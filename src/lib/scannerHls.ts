import Hls, {
  LoadStats,
  type ErrorData,
  type LoaderCallbacks,
  type LoaderConfiguration,
  type LoaderContext,
  type LoaderStats,
} from "hls.js";
import { fetchMedia, looksLikePlaylist } from "./streamMedia";

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

/** hls.js loader. Playlists and segments are fetched here so a stream without CORS still plays. */
class MediaProxyLoader {
  context: LoaderContext | null = null;
  stats: LoaderStats = new LoadStats();
  private callbacks: LoaderCallbacks<LoaderContext> | null = null;
  private controller: AbortController | null = null;
  private timer = 0;
  private settled = false;
  private generation = 0;

  constructor(_config: unknown) {}

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
      typeof context.rangeEnd === "number" ? `bytes=${context.rangeStart ?? 0}-${context.rangeEnd - 1}` : undefined;

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
        callbacks.onSuccess({ url: result.finalUrl || context.url, data, code: 200 }, this.stats, context, null);
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

/** Play an HLS audio playlist on this element. Returns a stop function. */
export function playHlsAudio(
  audio: HTMLAudioElement,
  url: string,
  onError: (message: string) => void,
): () => void {
  let destroyed = false;
  let hls: Hls | null = null;
  audio.muted = true;

  const stop = () => {
    destroyed = true;
    hls?.destroy();
    hls = null;
    audio.pause();
    audio.removeAttribute("src");
    try {
      audio.load();
    } catch {
      // The element may already be gone.
    }
  };

  const native = audio.canPlayType("application/vnd.apple.mpegurl") === "probably" && !Hls.isSupported();
  if (native) {
    audio.src = url;
    void audio.play().catch(() => undefined);
    return stop;
  }
  if (!Hls.isSupported()) {
    onError("This window can't decode that HLS stream.");
    return stop;
  }

  let recoveries = 0;
  hls = new Hls({
    enableWorker: false,
    lowLatencyMode: true,
    backBufferLength: 30,
    loader: MediaProxyLoader,
  });
  hls.attachMedia(audio);
  hls.loadSource(url);
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    if (!destroyed) void audio.play().catch(() => undefined);
  });
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
    onError(hlsFailure(data.details));
    hls?.destroy();
    hls = null;
  });
  return stop;
}
