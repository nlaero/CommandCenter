/**
 * Dev-server stand-in for the desktop `transcribe_media_local` command.
 * Audio is converted on this machine and passed to the installed whisper.cpp
 * binary. It is not sent to a cloud speech service.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NOTE = "Transcribed on this computer with Tiny English. Audio was not uploaded.";

export function blocksCaptionDownload(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  return (
    host === "youtu.be" ||
    host.endsWith(".youtu.be") ||
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube-nocookie.com") ||
    host === "googlevideo.com" ||
    host.endsWith(".googlevideo.com") ||
    host === "youtube.googleapis.com" ||
    host.endsWith(".youtube.googleapis.com")
  );
}

function aiRoot() {
  const override = process.env.COMMAND_CENTER_HOME?.trim();
  if (override) return override;
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "command-center");
  }
  return path.join(os.homedir(), ".config", "command-center");
}

function readInstall() {
  const root = aiRoot();
  const markerPath = path.join(root, "ai", "install.json");
  if (!fs.existsSync(markerPath)) return null;
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    const cli = path.join(root, marker.runtimePath);
    const model = path.join(root, marker.modelPath);
    if (!fs.existsSync(cli) || !fs.existsSync(model)) return null;
    return { cli, model, label: marker.modelLabel || "Tiny English" };
  } catch {
    return null;
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      timeout: options.timeout ?? 60_000,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (err.code === "ENOENT") reject(Object.assign(new Error("FFMPEG_MISSING"), { code: "ENOENT" }));
      else reject(err);
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(stderr.trim().slice(0, 240) || `${command} failed`));
    });
  });
}

async function ffmpegToWav(sourceUrl, seekSec, durationSec, wavPath) {
  const duration = Math.min(30, Math.max(1, Number(durationSec) || 30));
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-user_agent", "CommandCenter/0.1"];
  if (seekSec > 0.05) args.push("-ss", seekSec.toFixed(3));
  args.push("-t", duration.toFixed(3), "-i", sourceUrl, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", wavPath);
  await run("ffmpeg", args, { timeout: 45_000 });
}

async function whisper(cli, model, wavPath, jsonBase) {
  // Same flags as run_whisper in src-tauri/src/local_ai.rs.
  await run(
    cli,
    ["-m", model, "-f", wavPath, "-oj", "-of", jsonBase, "-np", "-ng", "-l", "en"],
    { cwd: path.dirname(cli), timeout: 90_000 },
  );
  const raw = JSON.parse(fs.readFileSync(`${jsonBase}.json`, "utf8"));
  const items = Array.isArray(raw.transcription) ? raw.transcription : [];
  return items
    .map((item, index) => {
      const text = String(item.text ?? "").trim();
      const from = Number(item.offsets?.from ?? 0);
      const to = Number(item.offsets?.to ?? from);
      return {
        id: `seg-${index}`,
        startSec: from / 1000,
        endSec: Math.max(from, to) / 1000,
        text,
      };
    })
    .filter((segment) => segment.text);
}

export async function transcribeClip(body) {
  const sourceUrl = String(body?.sourceUrl ?? "").trim();
  if (!sourceUrl) throw new Error("audio URL required for transcription");
  if (blocksCaptionDownload(sourceUrl)) {
    throw new Error("YouTube audio is not downloaded. This panel uses YouTube's captions.");
  }
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error("Enter an http or https link.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Enter an http or https link.");
  }
  const installed = readInstall();
  const clipId = String(body?.clipId ?? "clip").trim() || "clip";
  if (!installed) {
    return {
      engine: "local-whisper",
      status: "needs-model",
      sourceUrl,
      segments: [],
      note: "Local AI is not installed. Settings → Local AI downloads Tiny English onto this computer. Audio stays here.",
      generatedAt: new Date().toISOString(),
    };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "command-center-ai-"));
  const wavPath = path.join(dir, "clip.wav");
  const jsonBase = path.join(dir, "out");
  try {
    await ffmpegToWav(sourceUrl, Number(body?.seekSec) || 0, Number(body?.durationSec) || 30, wavPath);
    const shift = Number(body?.timelineStart) || 0;
    const segments = (await whisper(installed.cli, installed.model, wavPath, jsonBase)).map((segment, index) => ({
      ...segment,
      id: `${clipId}-seg-${index}`,
      startSec: segment.startSec + shift,
      endSec: segment.endSec + shift,
    }));
    return {
      engine: "local-whisper",
      status: "ready",
      sourceUrl,
      segments,
      note: NOTE.replace("Tiny English", installed.label),
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error("Couldn't prepare audio for captions. ffmpeg is not installed. Audio was not uploaded.");
    }
    const message = err instanceof Error ? err.message : "Couldn't create captions on this device.";
    throw new Error(
      message.includes("not uploaded") ? message : `${message} Audio was not uploaded.`.trim(),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
