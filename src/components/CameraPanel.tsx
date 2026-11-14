import { useEffect, useRef, useState } from "react";
import Hls, {
  LoadStats,
  type ErrorData,
  type LoaderCallbacks,
  type LoaderConfiguration,
  type LoaderContext,
  type LoaderStats,
} from "hls.js";
import { captionsVisible } from "../lib/streamCaptions";
import { useStreamCaptions } from "../lib/useStreamCaptions";
import {
  classifyPlayback,
  fetchMedia,
  isYoutubeUrl,
  looksLikeImage,
  looksLikePlaylist,
  looksLikeVideoFile,
  prefersChannelLive,
  withCacheBust,
  youtubeChannelEmbed,
  youtubeChannelId,
  youtubeFromPage,
  youtubeVideoEmbed,
  youtubeVideoId,
  type PlaybackKind,
} from "../lib/streamMedia";
import type { SourceConfig } from "../types";

type Props = {
  source: SourceConfig;
};

type Phase = "loading" | "playing" | "error";

function textParam(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function refreshMs(refresh?: string): number {
  if (!refresh) return 30_000;
  const match = refresh.trim().match(/^(\d+)\s*([smh])$/i);
  if (!match) return 30_000;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  const ms = unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n * 3_600_000;
  return Math.min(3_600_000, Math.max(5_000, ms));
}

function hlsFailure(details?: string): string {
  switch (details) {
    case "manifestLoadError":
    case "manifestLoadTimeOut":
    case "levelLoadError":
    case "levelLoadTimeOut":
      return "Couldn't load that HLS playlist. Check the link in Settings.";
    case "manifestParsingError":
    case "levelParsingError":
      return "That link isn't a playlist this panel can play.";
    default:
      return "The stream stopped. Check the link in Settings.";
  }
}

function messageOf(err: unknown): string {
  if (err instanceof DOMException && err.name === "AbortError") return "";
  if (err instanceof Error && err.message.trim()) return err.message;
  return "Couldn't play that link. Check it in Settings.";
}

/** hls.js loader. Playlists and segments are fetched here so cameras without CORS still play. */
class MediaProxyLoader {
  context: LoaderContext | null = null;
  stats: LoaderStats = new LoadStats();
  private callbacks: LoaderCallbacks<LoaderContext> | null = null;
  private controller: AbortController | null = null;
  private timer = 0;
  private settled = false;

  constructor(_config: unknown) {}

  private generation = 0;

  load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>) {
    this.generation += 1;
    const generation = this.generation;
    this.controller?.abort();
    window.clearTimeout(this.timer);
    this.context = context;
    this.callbacks = callbacks;
    this.stats = new LoadStats();
    this.settled = false;
    const controller = new AbortController();
    this.controller = controller;
    const started = performance.now();
    this.stats.loading.start = started;
    const budget = config.loadPolicy?.maxLoadTimeMs || 20_000;
    this.timer = window.setTimeout(() => {
      if (this.settled || generation !== this.generation) return;
      this.settled = true;
      controller.abort();
      this.stats.loading.end = performance.now();
      callbacks.onTimeout(this.stats, context, null);
    }, budget);

    const range =
      typeof context.rangeEnd === "number"
        ? `bytes=${context.rangeStart ?? 0}-${context.rangeEnd - 1}`
        : undefined;

    void fetchMedia(context.url, { range, signal: controller.signal })
      .then((result) => {
        if (this.settled || generation !== this.generation) return;
        this.settled = true;
        window.clearTimeout(this.timer);
        const end = performance.now();
        this.stats.loading.first = end;
        this.stats.loading.end = end;
        this.stats.loaded = result.data.byteLength;
        this.stats.total = result.data.byteLength;
        const playlist = looksLikePlaylist(result.data, result.contentType);
        const text = new TextDecoder("utf-8").decode(result.data);
        const data =
          context.responseType === "json"
            ? (JSON.parse(text) as object)
            : context.responseType === "arraybuffer" && !playlist
              ? result.data
              : text;
        callbacks.onSuccess(
          { url: result.finalUrl || context.url, data, code: 200 },
          this.stats,
          context,
          null,
        );
      })
      .catch((err: unknown) => {
        if (this.settled || generation !== this.generation) return;
        this.settled = true;
        window.clearTimeout(this.timer);
        if (err instanceof DOMException && err.name === "AbortError") return;
        callbacks.onError(
          { code: 0, text: messageOf(err) || "Couldn't reach that stream." },
          context,
          null,
          this.stats,
        );
      });
  }

  abort() {
    this.generation += 1;
    this.controller?.abort();
    window.clearTimeout(this.timer);
    if (!this.settled && this.callbacks && this.context) {
      this.settled = true;
      this.stats.aborted = true;
      this.callbacks.onAbort?.(this.stats, this.context, null);
      return;
    }
    this.settled = true;
    this.stats.aborted = true;
  }

  destroy() {
    this.abort();
    this.callbacks = null;
    this.context = null;
  }
}

async function resolveYoutubeEmbed(raw: string, origin: string, signal: AbortSignal): Promise<string> {
  const videoId = youtubeVideoId(raw);
  if (videoId && (isYoutubeUrl(raw) || !raw.includes("://"))) {
    return youtubeVideoEmbed(videoId, origin, true);
  }
  if (!isYoutubeUrl(raw)) {
    throw new Error("Paste a YouTube watch, live, or youtu.be link.");
  }
  // Channel and @handle /live pages do not include a video id. Open the page and
  // embed the stream it resolved to. live_stream?channel= is only a fallback.
  const page = await fetchMedia(raw, { signal });
  const html = new TextDecoder("utf-8").decode(page.data);
  const found = youtubeFromPage(html);
  if (found.videoId) return youtubeVideoEmbed(found.videoId, origin, true);
  if (found.channelId) return youtubeChannelEmbed(found.channelId, origin, true);
  if (prefersChannelLive(raw) && youtubeChannelId(raw)) {
    return youtubeChannelEmbed(youtubeChannelId(raw) as string, origin, true);
  }
  throw new Error("Couldn't open that YouTube link. Paste a watch or youtu.be URL.");
}

async function probeKind(url: string, signal: AbortSignal): Promise<PlaybackKind> {
  try {
    const peeked = await fetchMedia(url, { range: "bytes=0-2047", signal });
    if (looksLikePlaylist(peeked.data, peeked.contentType)) return "hls";
    if (looksLikeImage(peeked.data, peeked.contentType)) return "image";
    if (looksLikeVideoFile(peeked.contentType)) return "file";
    if (peeked.contentType.toLowerCase().includes("mp2t")) {
      throw new Error("That link is a raw transport stream. Paste the HLS playlist (.m3u8).");
    }
    return "file";
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    const text = err instanceof Error ? err.message : "";
    if (text.includes("too large")) return "file";
    throw err;
  }
}

function postYouTube(frame: HTMLIFrameElement, func: string, args: unknown[] = []) {
  frame.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "*");
}

function setYouTubeCaptions(frame: HTMLIFrameElement, on: boolean) {
  if (on) {
    postYouTube(frame, "loadModule", ["captions"]);
    postYouTube(frame, "setOption", ["captions", "track", { languageCode: "en" }]);
    return;
  }
  postYouTube(frame, "unloadModule", ["captions"]);
}

export function CameraPanel({ source }: Props) {
  const rawUrl = textParam(source.params.url);
  const label =
    textParam(source.params.label) || (source.type === "video.youtube" ? "YouTube" : "Camera");
  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState("Opening stream…");
  const [kind, setKind] = useState<PlaybackKind | null>(null);
  const [embed, setEmbed] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);
  const [captionsOn, setCaptionsOn] = useState(false);
  const [imageToken, setImageToken] = useState(() => Date.now());
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const showCaptions = captionsVisible(muted, captionsOn);
  const generated = useStreamCaptions({ show: showCaptions, kind, url: rawUrl, videoRef });

  useEffect(() => {
    const controller = new AbortController();
    setPhase("loading");
    setStatus("Opening stream…");
    setEmbed(null);
    setKind(null);

    if (!rawUrl) {
      setPhase("error");
      setStatus(
        source.type === "video.youtube"
          ? "Add a YouTube link in Settings."
          : "Add a stream link in Settings.",
      );
      return () => controller.abort();
    }

    const hinted = classifyPlayback(rawUrl, source.type);
    void (async () => {
      try {
        if (hinted === "youtube") {
          const next = await resolveYoutubeEmbed(rawUrl, window.location.origin, controller.signal);
          if (controller.signal.aborted) return;
          setEmbed(next);
          setKind("youtube");
          return;
        }
        const resolved = hinted === "unknown" ? await probeKind(rawUrl, controller.signal) : hinted;
        if (controller.signal.aborted) return;
        setKind(resolved);
      } catch (err) {
        if (controller.signal.aborted) return;
        const text = messageOf(err);
        if (!text) return;
        setPhase("error");
        setStatus(text);
      }
    })();

    return () => controller.abort();
  }, [rawUrl, source.type]);

  useEffect(() => {
    if (kind !== "image") return;
    const timer = window.setInterval(() => setImageToken(Date.now()), refreshMs(source.refresh));
    return () => window.clearInterval(timer);
  }, [kind, source.refresh, rawUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || (kind !== "hls" && kind !== "file")) return;
    let destroyed = false;
    let hls: Hls | null = null;
    video.muted = true;
    video.playsInline = true;

    const stop = () => {
      destroyed = true;
      hls?.destroy();
      hls = null;
      video.pause();
      video.removeAttribute("src");
    };

    if (kind === "file") {
      video.src = rawUrl;
      void video.play().catch(() => undefined);
      return stop;
    }

    const native =
      video.canPlayType("application/vnd.apple.mpegurl") === "probably" && !Hls.isSupported();
    if (native) {
      video.src = rawUrl;
      void video.play().catch(() => undefined);
      return stop;
    }
    if (!Hls.isSupported()) {
      setPhase("error");
      setStatus("This window can't decode HLS. An MP4 or image link will still play.");
      return stop;
    }

    let recoveries = 0;
    hls = new Hls({
      enableWorker: false,
      lowLatencyMode: true,
      capLevelToPlayerSize: true,
      enableCEA708Captions: true,
      renderTextTracksNatively: true,
      backBufferLength: 30,
      loader: MediaProxyLoader,
    });
    hls.attachMedia(video);
    hls.loadSource(rawUrl);
    hls.on(Hls.Events.ERROR, (_event, data: ErrorData) => {
      if (destroyed || !data.fatal) return;
      recoveries += 1;
      if (recoveries <= 2 && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        hls?.startLoad();
        return;
      }
      if (recoveries <= 2 && data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls?.recoverMediaError();
        return;
      }
      setPhase("error");
      setStatus(hlsFailure(data.details));
      hls?.destroy();
      hls = null;
    });

    return stop;
  }, [kind, rawUrl]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
    const frame = frameRef.current;
    if (!frame || kind !== "youtube") return;
    postYouTube(frame, muted ? "mute" : "unMute");
    if (!muted) postYouTube(frame, "playVideo");
    setYouTubeCaptions(frame, showCaptions);
  }, [muted, showCaptions, kind, embed]);

  function toggleMute() {
    setMuted((current) => !current);
  }

  function toggleCaptions() {
    setCaptionsOn((current) => !current);
  }

  const showMediaControls = kind === "hls" || kind === "file" || kind === "youtube";
  const badge =
    phase === "error" ? "Offline" : kind === "image" ? "Still" : kind === "file" ? "Video" : "Live";
  const iframeSrc = embed;

  return (
    <div className="camera-panel">
      <div className="camera-stage">
        {kind === "youtube" && iframeSrc ? (
          <iframe
            ref={frameRef}
            className="camera-frame"
            src={iframeSrc}
            title={label}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="origin"
            onLoad={() => {
              setPhase("playing");
              const frame = frameRef.current;
              if (!frame) return;
              postYouTube(frame, muted ? "mute" : "unMute");
              setYouTubeCaptions(frame, captionsVisible(muted, captionsOn));
            }}
          />
        ) : null}
        {kind === "image" || kind === "mjpeg" ? (
          <img
            className="camera-frame"
            src={kind === "image" ? withCacheBust(rawUrl, imageToken) : rawUrl}
            alt={label}
            onLoad={() => setPhase("playing")}
            onError={() => {
              setPhase("error");
              setStatus("Couldn't load that image. Check the link in Settings.");
            }}
          />
        ) : null}
        {kind === "hls" || kind === "file" ? (
          <video
            ref={videoRef}
            className="camera-frame"
            muted
            autoPlay
            playsInline
            controls
            aria-label={label}
            onPlaying={() => setPhase("playing")}
            onError={() => {
              setPhase("error");
              setStatus(
                kind === "file"
                  ? "Couldn't play that file. An HLS playlist, MP4, or image link will play here."
                  : "Couldn't play that stream. Check the link in Settings.",
              );
            }}
          />
        ) : null}
        <div className="camera-overlay">
          <span className={`incident-live${phase === "error" ? " is-offline" : ""}`}>
            <span className="live-dot" aria-hidden />
            {badge}
          </span>
          <span className="camera-label">{label}</span>
          {showMediaControls ? (
            <span className="camera-actions">
              <button type="button" className="btn camera-btn" onClick={toggleMute}>
                {muted ? "Muted" : "Sound on"}
              </button>
              <button
                type="button"
                className={`btn camera-btn${captionsOn ? " active" : ""}`}
                aria-pressed={captionsOn}
                title="Closed captions"
                onClick={toggleCaptions}
              >
                CC
              </button>
            </span>
          ) : null}
        </div>
        {phase !== "playing" ? (
          <div className="camera-status" role="status">
            {status}
          </div>
        ) : null}
        {showCaptions && generated.text ? (
          <div className="camera-captions" aria-live="polite">
            <span>{generated.text}</span>
          </div>
        ) : null}
        {showCaptions && !generated.text && generated.status ? (
          <div className="camera-caption-note" role="status">
            {generated.status}
          </div>
        ) : null}
      </div>
    </div>
  );
}
