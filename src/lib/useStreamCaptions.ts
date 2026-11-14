import { useEffect, useRef, useState, type RefObject } from "react";
import { activeCaptionAt, captionFailureText, transcribeMediaLocal, type CaptionSegment } from "./captions";
import {
  alignAudioSlices,
  cleanCaptionText,
  fileCaptionWindow,
  hlsCaptionPlan,
  parseMediaSegments,
  slicesAround,
  type MediaSlice,
} from "./streamCaptions";
import { fetchMedia, type PlaybackKind } from "./streamMedia";

type Job = {
  key: string;
  sourceUrl: string;
  timelineStart: number;
  seekSec: number;
  durationSec: number;
};

const AHEAD = 3;

/**
 * Shows in-stream captions when the playlist has them. Otherwise transcribes
 * short slices on this computer and lines them up with playback.
 * Nothing is fetched for YouTube.
 */
export function useStreamCaptions(options: {
  show: boolean;
  kind: PlaybackKind | null;
  url: string;
  videoRef: RefObject<HTMLVideoElement | null>;
}): { text: string | null; status: string | null } {
  const { show, kind, url, videoRef } = options;
  const showRef = useRef(show);
  showRef.current = show;
  const [text, setText] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    setText(null);
    setStatus(null);
    if ((kind !== "hls" && kind !== "file") || !url) return;

    let stopped = false;
    const controller = new AbortController();
    const cache = new Map<string, CaptionSegment[]>();
    const pending = new Set<string>();
    let queue: Job[] = [];
    let pumping = false;
    let slices: MediaSlice[] = [];
    let mode: "pending" | "native" | "local" = "pending";
    let note: string | null = null;
    let blocked = false;
    let holdText = "";
    let holdStart = 0;
    let holdDuration = 0;
    let shown = "";
    let shownStatus: string | null = null;

    const publish = () => {
      if (stopped) return;
      const video = videoRef.current;
      const native = nativeCue(video);
      if (native) mode = "native";
      let next = "";
      if (mode === "native") {
        next = native ?? "";
      } else if (mode === "local") {
        const time = video?.currentTime ?? 0;
        const active = activeCaptionAt([...cache.values()].flat(), time);
        next = active ? cleanCaptionText(active.text) : "";
        if (!next && time >= holdStart - 0.5 && time < holdStart + Math.max(holdDuration, 8)) next = holdText;
      }
      if (next !== shown) {
        shown = next;
        setText(next || null);
      }
      const time = video?.currentTime ?? 0;
      const key = coveringKey(time);
      const waiting =
        mode === "local" &&
        !next &&
        !note &&
        !blocked &&
        (pending.size > 0 || (key != null && !cache.has(key)));
      const nextStatus = note ?? (waiting ? "Creating captions on this device…" : null);
      if (nextStatus !== shownStatus) {
        shownStatus = nextStatus;
        setStatus(nextStatus);
      }
    };

    const coveringKey = (time: number): string | null => {
      if (kind === "file") return `file:${fileCaptionWindow(time).startSec}`;
      const slice = slices.find((item) => time >= item.startSec && time < item.startSec + item.durationSec);
      return slice?.url ?? null;
    };

    const desiredJobs = (): Job[] => {
      const time = videoRef.current?.currentTime ?? 0;
      if (kind === "file") {
        const first = fileCaptionWindow(time);
        const second = fileCaptionWindow(time + first.durationSec);
        return [first, second].map((window) => ({
          key: `file:${window.startSec}`,
          sourceUrl: url,
          timelineStart: window.startSec,
          seekSec: window.startSec,
          durationSec: window.durationSec,
        }));
      }
      return slicesAround(slices, time, AHEAD).map((slice) => ({
        key: slice.url,
        sourceUrl: slice.url,
        timelineStart: slice.startSec,
        seekSec: 0,
        durationSec: Math.min(30, slice.durationSec + 0.4),
      }));
    };

    const schedule = () => {
      if (stopped || blocked || mode === "native") {
        publish();
        return;
      }
      if (nativeCue(videoRef.current) || embeddedTracks(videoRef.current)) {
        mode = "native";
        queue = [];
        publish();
        return;
      }
      if (mode !== "local") return;
      if (!showRef.current) {
        publish();
        return;
      }
      const wanted = desiredJobs();
      const wantedKeys = new Set(wanted.map((job) => job.key));
      queue = queue.filter((job) => wantedKeys.has(job.key));
      for (const job of wanted) {
        if (!cache.has(job.key) && !queue.some((queued) => queued.key === job.key)) queue.push(job);
      }
      queue.sort(
        (a, b) => wanted.findIndex((job) => job.key === a.key) - wanted.findIndex((job) => job.key === b.key),
      );
      void pump();
      publish();
    };

    const pump = async () => {
      if (pumping) return;
      pumping = true;
      while (!stopped && queue.length && !blocked) {
        const job = queue.shift();
        if (!job || cache.has(job.key) || pending.has(job.key)) continue;
        pending.add(job.key);
        publish();
        try {
          const result = await transcribeMediaLocal({
            sourceUrl: job.sourceUrl,
            clipId: job.key,
            timelineStart: job.timelineStart,
            seekSec: job.seekSec,
            durationSec: job.durationSec,
          });
          if (stopped) return;
          if (result.status === "needs-model") {
            blocked = true;
            queue = [];
            note = result.note;
            break;
          }
          const segments = result.segments
            .map((segment) => ({ ...segment, text: cleanCaptionText(segment.text) }))
            .filter((segment) => segment.text);
          cache.set(job.key, segments);
          const line = segments.map((segment) => segment.text).join(" ");
          if (line) {
            holdText = line;
            holdStart = job.timelineStart;
            holdDuration = job.durationSec;
            note = null;
          }
        } catch (err) {
          if (stopped) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          cache.set(job.key, []);
          note = captionFailureText(err);
        } finally {
          pending.delete(job.key);
        }
        publish();
      }
      pumping = false;
      publish();
    };

    const loadHls = async () => {
      const master = await fetchMedia(url, { signal: controller.signal });
      if (stopped) return;
      const text = new TextDecoder("utf-8").decode(master.data);
      const plan = hlsCaptionPlan(text, master.finalUrl || url);
      if (plan.kind === "embedded") {
        mode = "native";
        publish();
        return;
      }
      let videoSlices = parseMediaSegments(text, master.finalUrl || url);
      let audioSlices: MediaSlice[] = [];
      if (plan.mediaPlaylistUrl) {
        const media = await fetchMedia(plan.mediaPlaylistUrl, { signal: controller.signal });
        if (stopped) return;
        const mediaText = new TextDecoder("utf-8").decode(media.data);
        videoSlices = parseMediaSegments(mediaText, media.finalUrl || plan.mediaPlaylistUrl);
      }
      if (plan.audioPlaylistUrl) {
        const audio = await fetchMedia(plan.audioPlaylistUrl, { signal: controller.signal });
        if (stopped) return;
        const audioText = new TextDecoder("utf-8").decode(audio.data);
        audioSlices = parseMediaSegments(audioText, audio.finalUrl || plan.audioPlaylistUrl);
      }
      slices = alignAudioSlices(videoSlices, audioSlices);
      mode = "local";
      schedule();
    };

    if (kind === "file") {
      const wait = window.setTimeout(() => {
        if (stopped) return;
        if (embeddedTracks(videoRef.current)) {
          mode = "native";
          publish();
          return;
        }
        mode = "local";
        schedule();
      }, 1200);
      const timer = window.setInterval(schedule, 400);
      return () => {
        stopped = true;
        controller.abort();
        window.clearTimeout(wait);
        window.clearInterval(timer);
      };
    }

    void loadHls().catch((err: unknown) => {
      if (stopped || (err instanceof DOMException && err.name === "AbortError")) return;
      note = captionFailureText(err);
      mode = "local";
      publish();
    });
    const timer = window.setInterval(schedule, 400);
    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [kind, url, videoRef]);

  return { text: show ? text : null, status: show ? status : null };
}

function nativeCue(video: HTMLVideoElement | null): string | null {
  if (!video) return null;
  const lines: string[] = [];
  for (const track of captionTracks(video)) {
    if (track.mode === "disabled") track.mode = "hidden";
    const cues = track.activeCues;
    if (!cues) continue;
    for (let i = 0; i < cues.length; i += 1) {
      const cue = cues[i] as VTTCue;
      const text = cleanCaptionText(cue.text ?? "");
      if (text) lines.push(text);
    }
  }
  return lines.length ? lines.join(" ") : null;
}

function embeddedTracks(video: HTMLVideoElement | null): boolean {
  if (!video) return false;
  return captionTracks(video).some((track) => (track.cues?.length ?? 0) > 0);
}

function captionTracks(video: HTMLVideoElement): TextTrack[] {
  return Array.from(video.textTracks).filter((track) => track.kind === "subtitles" || track.kind === "captions");
}
