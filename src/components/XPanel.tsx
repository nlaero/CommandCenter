import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSourcePayload, xAccount, xBeginSignIn, xPollSignIn, xSignOut } from "../lib/api";
import { transcribeMediaLocal } from "../lib/captions";
import { X_REDIRECT_URI } from "../lib/xFollow";
import type { SourceConfig, SourcePayload, XAccount, XMedia, XPost } from "../types";

type Props = {
  sourceId: string;
  source: SourceConfig;
  configRevision?: number;
};

function parseRefreshMs(refresh?: string): number {
  if (!refresh) return 120_000;
  const match = refresh.trim().match(/^(\d+)\s*([smh])$/i);
  if (!match) return 120_000;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "s") return Math.max(60_000, n * 1000);
  if (unit === "m") return Math.max(60_000, n * 60_000);
  return Math.max(60_000, n * 60 * 60_000);
}

function formatWhen(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "X follow feed failed.";
}

function needsSignIn(message: string): boolean {
  return message.toLowerCase().includes("sign in");
}

export function XPanel({ sourceId, source, configRevision = 0 }: Props) {
  const [account, setAccount] = useState<XAccount | null>(null);
  const [payload, setPayload] = useState<SourcePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const knownIds = useRef<Set<string>>(new Set());
  const primed = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void xAccount()
      .then((next) => {
        if (!cancelled) setAccount(next);
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceId, configRevision]);

  useEffect(() => {
    if (!account?.signedIn) return;
    let cancelled = false;
    let flashTimer: number | undefined;

    async function load(isPoll: boolean) {
      try {
        if (!isPoll) setLoading(true);
        const next = await fetchSourcePayload(sourceId, source);
        if (cancelled) return;
        const incoming: string[] = [];
        const posts = next.xFeed?.posts ?? [];
        if (primed.current) {
          for (const post of posts) {
            if (!knownIds.current.has(post.id)) incoming.push(post.id);
          }
        } else {
          primed.current = true;
        }
        knownIds.current = new Set(posts.map((post) => post.id));
        setPayload(next);
        setError(null);
        if (incoming.length) {
          setFlashIds(new Set(incoming));
          if (flashTimer) window.clearTimeout(flashTimer);
          flashTimer = window.setTimeout(() => setFlashIds(new Set()), 8_000);
        }
      } catch (err) {
        if (cancelled) return;
        const message = errorText(err);
        setError(message);
        if (needsSignIn(message)) {
          setAccount({ signedIn: false, username: null, name: null });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load(false);
    const timer = window.setInterval(() => void load(true), parseRefreshMs(source.refresh));
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (flashTimer) window.clearTimeout(flashTimer);
    };
  }, [account?.signedIn, sourceId, source.refresh, source.type, JSON.stringify(source.params), configRevision]);

  async function signIn() {
    setBusy(true);
    setError(null);
    setAuthorizeUrl(null);
    try {
      const start = await xBeginSignIn(sourceId);
      if (!start.authorizeUrl) {
        setAccount(await xAccount());
        return;
      }
      setAuthorizeUrl(start.authorizeUrl);
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 400));
        const next = await xPollSignIn();
        if (next?.signedIn) {
          primed.current = false;
          setAuthorizeUrl(null);
          setAccount(next);
          return;
        }
      }
      setError("X sign-in timed out. Try again.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      const next = await xSignOut();
      primed.current = false;
      knownIds.current = new Set();
      setPayload(null);
      setAuthorizeUrl(null);
      setAccount(next);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const posts = payload?.xFeed?.posts ?? [];
  const handle = account?.username ? `@${account.username}` : null;

  return (
    <div className="incident-panel x-panel">
      <div className="incident-toolbar">
        <span className="incident-live">
          <span className="live-dot" aria-hidden />
          Following
        </span>
        <span className="incident-meta">
          {handle}
          {loading && !payload ? " Loading…" : null}
          {payload ? ` ${posts.length} posts · ${formatWhen(payload.fetchedAt)}` : null}
        </span>
        {account?.signedIn ? (
          <button type="button" className="btn btn-ghost incident-refresh" disabled={busy} onClick={() => void signOut()}>
            Sign out
          </button>
        ) : null}
      </div>

      {error ? <div className="alert error">{error}</div> : null}

      {!account?.signedIn ? (
        <div className="x-signin">
          <p>Sign in to X to see new posts from accounts you follow.</p>
          <button type="button" className="btn btn-primary" disabled={busy || loading} onClick={() => void signIn()}>
            {busy ? "Waiting for X…" : "Sign in to X"}
          </button>
          {authorizeUrl ? (
            <p className="x-signin-note">
              If the browser did not open,{" "}
              <a href={authorizeUrl} target="_blank" rel="noreferrer">
                continue sign-in
              </a>
              . The callback URL on the X app is {X_REDIRECT_URI}.
            </p>
          ) : (
            <p className="x-signin-note">
              The access token stays in the OS keyring. Set the X app callback to {X_REDIRECT_URI}.
            </p>
          )}
        </div>
      ) : (
        <div className="x-feed" role="feed" aria-label="Posts from accounts you follow">
          {posts.map((post) => (
            <XPostCard key={post.id} post={post} isNew={flashIds.has(post.id)} />
          ))}
          {!loading && payload && posts.length === 0 ? (
            <p className="incident-empty">No new posts from accounts you follow.</p>
          ) : null}
        </div>
      )}

      {payload?.attribution ? (
        <footer className="incident-footer" title={payload.note ?? undefined}>
          {payload.attribution}
          {payload.note ? ` · ${payload.note}` : null}
        </footer>
      ) : null}
    </div>
  );
}

function XPostCard({ post, isNew }: { post: XPost; isNew: boolean }) {
  return (
    <article className={`x-post${isNew ? " is-new" : ""}`}>
      <div className="incident-alert-top">
        <span className="incident-sev">
          {post.authorName || (post.authorHandle ? `@${post.authorHandle}` : "Post")}
          {post.authorHandle && post.authorName ? ` @${post.authorHandle}` : ""}
        </span>
        <span className="incident-when">{formatWhen(post.createdAt)}</span>
      </div>
      {post.repostedBy ? <div className="x-repost">Reposted by @{post.repostedBy}</div> : null}
      {post.text ? <p className="x-text">{post.text}</p> : null}
      {post.media.length > 0 ? (
        <div className="x-media">
          {post.media.map((media, index) => (
            <PostMedia key={`${post.id}-${index}`} postId={post.id} media={media} />
          ))}
        </div>
      ) : null}
      <a className="x-open" href={post.url} target="_blank" rel="noreferrer">
        Open on X
      </a>
    </article>
  );
}

function PostMedia({ postId, media }: { postId: string; media: XMedia }) {
  if (media.kind === "photo" && media.url) {
    return <img src={media.url} alt={media.alt ?? ""} />;
  }
  if (!media.url) {
    return media.previewUrl ? <img src={media.previewUrl} alt={media.alt ?? ""} /> : null;
  }
  if (media.kind === "audio" || media.kind === "video") {
    return <AudibleMedia postId={postId} media={media} />;
  }
  return (
    <video muted playsInline loop controls preload="none" poster={media.previewUrl} src={media.url}>
      <a href={media.url}>Open media</a>
    </video>
  );
}

function AudibleMedia({ postId, media }: { postId: string; media: XMedia }) {
  const ref = useRef<HTMLMediaElement | null>(null);
  const setMedia = useCallback((node: HTMLMediaElement | null) => {
    ref.current = node;
  }, []);
  const [muted, setMuted] = useState(true);
  const [showCc, setShowCc] = useState(true);
  const [caption, setCaption] = useState<string | null>(media.alt ?? null);
  const [note, setNote] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    setMuted(true);
    setShowCc(true);
    setCaption(media.alt ?? null);
    setNote(null);
    started.current = false;
    const el = ref.current;
    if (el) {
      el.muted = true;
      el.defaultMuted = true;
      el.setAttribute("muted", "");
      el.pause();
    }
  }, [media.url, media.alt, postId]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.muted = muted;
    if (muted) el.setAttribute("muted", "");
    else el.removeAttribute("muted");
  }, [muted]);

  async function onPlay() {
    const el = ref.current;
    if (el) el.muted = muted;
    if (started.current || !media.url) return;
    started.current = true;
    try {
      const result = await transcribeMediaLocal({
        sourceUrl: media.url,
        clipId: postId,
        seekSec: 0,
        durationSec: 20,
      });
      const text = result.segments
        .map((segment) => segment.text.trim())
        .filter(Boolean)
        .join(" ");
      if (text) setCaption(text);
      else if (result.note) setNote(result.note);
    } catch (err) {
      if (!media.alt) setNote(errorText(err));
    }
  }

  const showLine = muted || showCc;
  const line = caption || (showLine ? "Captions show while this plays, including while the sound is off." : "");

  return (
    <div className="x-audible">
      <div className="bcfy-audio-head">
        <button
          type="button"
          className={`btn btn-ghost bcfy-mute${muted ? " is-muted" : ""}`}
          onClick={() => setMuted((value) => !value)}
          aria-pressed={muted}
        >
          {muted ? "Muted" : "Sound on"}
        </button>
        <label className="bcfy-cc-toggle" title="Closed captions">
          <input type="checkbox" checked={showCc} onChange={(event) => setShowCc(event.target.checked)} />
          <span className={`bcfy-cc-badge${showCc ? " on" : ""}`}>CC</span>
        </label>
      </div>
      {media.kind === "audio" ? (
        <audio
          ref={setMedia}
          controls
          preload="none"
          muted={muted}
          src={media.url}
          onPlay={() => void onPlay()}
          onVolumeChange={(event) => {
            setMuted(event.currentTarget.muted || event.currentTarget.volume === 0);
          }}
        >
          <a href={media.url}>Open audio</a>
        </audio>
      ) : (
        <video
          ref={setMedia}
          controls
          playsInline
          preload="none"
          muted={muted}
          poster={media.previewUrl}
          src={media.url}
          onPlay={() => void onPlay()}
          onVolumeChange={(event) => {
            setMuted(event.currentTarget.muted || event.currentTarget.volume === 0);
          }}
        >
          <a href={media.url}>Open video</a>
        </video>
      )}
      {showLine ? (
        <p className={`bcfy-caption-live${line ? "" : " is-empty"}`}>{line}</p>
      ) : null}
      {note ? <p className="bcfy-captions-note">{note}</p> : null}
      <p className="bcfy-audio-hint">Starts muted. Unmute in the player to listen.</p>
    </div>
  );
}
