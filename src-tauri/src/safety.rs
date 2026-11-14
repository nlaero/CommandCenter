//! Short recordings from an online stream or a local audio input.
//! The clip stays on this computer and is transcribed with the local model.

use crate::local_ai::{self, TranscribeError};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

const WINDOW_SECONDS: u32 = 12;
const MAX_CLIP_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInput {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenRequest {
    pub kind: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipRequest {
    pub clip_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeardSegment {
    pub id: String,
    pub start_sec: f64,
    pub end_sec: f64,
    pub text: String,
    /// Local person key, if a diarizer supplied one. Not a unit ID.
    pub speaker: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenResult {
    pub engine: String,
    pub status: String,
    pub note: String,
    pub clip_id: Option<String>,
    pub segments: Vec<HeardSegment>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafetyClip {
    pub mime: String,
    pub base64: String,
}

pub fn list_inputs() -> Vec<AudioInput> {
    let mut out = vec![AudioInput {
        id: "default".into(),
        label: "Default input".into(),
    }];
    for item in capture_devices() {
        if item.id != "default" && device_id_ok(&item.id) && !out.iter().any(|row| row.id == item.id) {
            out.push(item);
        }
    }
    out
}

pub fn listen(root: &Path, request: ListenRequest) -> Result<ListenResult, String> {
    let dir = root.join("safety-clips");
    fs::create_dir_all(&dir).map_err(|err| format!("could not prepare a recording folder: {err}"))?;
    prune_clips(&dir);
    let clip_id = uuid::Uuid::new_v4().simple().to_string();
    let dest = dir.join(format!("{clip_id}.wav"));
    let kind = request.kind.trim().to_ascii_lowercase();
    let recorded = match kind.as_str() {
        "online" => capture_online(request.url.as_deref().unwrap_or(""), &dest),
        "audio-in" | "audio" => capture_input(request.device_id.as_deref().unwrap_or("default"), &dest),
        _ => Err("Feed kind must be online or audio-in.".into()),
    };
    if let Err(err) = recorded {
        let _ = fs::remove_file(&dest);
        return Err(err);
    }
    let size = fs::metadata(&dest).map(|meta| meta.len()).unwrap_or(0);
    if size < 1000 || size > MAX_CLIP_BYTES {
        let _ = fs::remove_file(&dest);
        return Err("The recording was empty. Check the stream URL or the audio input.".into());
    }
    let file_url = url::Url::from_file_path(&dest)
        .map_err(|_| "Could not read the recorded window.".to_string())?;
    match local_ai::transcribe(root, file_url.as_str()) {
        Ok((segments, note)) => {
            let heard = segments
                .into_iter()
                .enumerate()
                .map(|(index, segment)| HeardSegment {
                    id: format!("{clip_id}-seg-{index}"),
                    start_sec: segment.start_sec,
                    end_sec: segment.end_sec,
                    text: segment.text,
                    speaker: segment.speaker,
                })
                .collect();
            Ok(ListenResult {
                engine: "local-whisper".into(),
                status: "ready".into(),
                note,
                clip_id: Some(clip_id),
                segments: heard,
            })
        }
        Err(TranscribeError::NotInstalled) => Ok(ListenResult {
            engine: "local-stub".into(),
            status: "needs-model".into(),
            note: "Tiny English is not installed. Settings → Local AI downloads it onto this computer. No alert is read until then. Audio stays here.".into(),
            clip_id: Some(clip_id),
            segments: Vec::new(),
        }),
        Err(TranscribeError::Message(message)) => Ok(ListenResult {
            engine: "local-whisper".into(),
            status: "error".into(),
            note: message,
            clip_id: Some(clip_id),
            segments: Vec::new(),
        }),
    }
}

pub fn read_clip(root: &Path, clip_id: &str) -> Result<SafetyClip, String> {
    let path = clip_file(root, clip_id)?;
    let bytes = fs::read(&path).map_err(|_| "That recording is no longer on this computer.".to_string())?;
    if bytes.len() as u64 > MAX_CLIP_BYTES {
        return Err("That recording is too large.".into());
    }
    Ok(SafetyClip {
        mime: "audio/wav".into(),
        base64: encode_base64(&bytes),
    })
}

fn clip_file(root: &Path, clip_id: &str) -> Result<PathBuf, String> {
    if clip_id.len() != 32 || !clip_id.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("Unknown recording.".into());
    }
    let path = root.join("safety-clips").join(format!("{clip_id}.wav"));
    if !path.is_file() {
        return Err("That recording is no longer on this computer.".into());
    }
    Ok(path)
}

fn capture_online(raw: &str, dest: &Path) -> Result<(), String> {
    let url = validate_stream_url(raw)?;
    let args = online_ffmpeg_args(&url, WINDOW_SECONDS, dest);
    run_ffmpeg(&args, Duration::from_secs(u64::from(WINDOW_SECONDS) + 25))
}

fn capture_input(device_id: &str, dest: &Path) -> Result<(), String> {
    let id = normalize_device(device_id)?;
    let args = input_ffmpeg_args(&id, WINDOW_SECONDS, dest);
    run_ffmpeg(&args, Duration::from_secs(u64::from(WINDOW_SECONDS) + 20))
}

fn validate_stream_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 500 {
        return Err("Online feeds use an http or https stream URL.".into());
    }
    let parsed = url::Url::parse(trimmed).map_err(|_| "The stream URL is not valid.".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Online feeds use an http or https stream URL.".into());
    }
    if parsed.host_str().is_none() {
        return Err("The stream URL needs a host.".into());
    }
    Ok(trimmed.to_string())
}

fn normalize_device(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    let id = if trimmed.is_empty() { "default" } else { trimmed };
    if !device_id_ok(id) {
        return Err("That audio input is not a device name this computer can record.".into());
    }
    Ok(id.to_string())
}

fn device_id_ok(id: &str) -> bool {
    let trimmed = id.trim();
    if trimmed.is_empty() || trimmed.len() > 160 || trimmed.starts_with('-') {
        return false;
    }
    trimmed.chars().all(|ch| {
        ch.is_ascii_alphanumeric()
            || matches!(ch, ' ' | '.' | '_' | ':' | '+' | '/' | '-' | '(' | ')' | '\'')
    })
}

fn online_ffmpeg_args(url: &str, seconds: u32, dest: &Path) -> Vec<String> {
    vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-i".into(),
        url.into(),
        "-t".into(),
        seconds.to_string(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        "16000".into(),
        "-f".into(),
        "wav".into(),
        dest.display().to_string(),
    ]
}

fn input_ffmpeg_args(device_id: &str, seconds: u32, dest: &Path) -> Vec<String> {
    let mut args = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
    ];
    #[cfg(windows)]
    {
        args.extend([
            "-f".into(),
            "dshow".into(),
            "-i".into(),
            format!("audio={device_id}"),
        ]);
    }
    #[cfg(not(windows))]
    {
        args.extend(["-f".into(), "pulse".into(), "-i".into(), device_id.into()]);
    }
    args.extend([
        "-t".into(),
        seconds.to_string(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        "16000".into(),
        "-f".into(),
        "wav".into(),
        dest.display().to_string(),
    ]);
    args
}

fn run_ffmpeg(args: &[String], limit: Duration) -> Result<(), String> {
    let mut child = Command::new("ffmpeg")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "ffmpeg is not installed, so this computer cannot record that feed.".to_string())?;
    let stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut err = String::new();
        if let Some(mut pipe) = stderr {
            let _ = pipe.read_to_string(&mut err);
        }
        err
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > limit => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err("Recording the feed took too long and was stopped.".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(80)),
            Err(err) => {
                let _ = child.kill();
                let _ = reader.join();
                return Err(format!("Recording stopped: {err}"));
            }
        }
    };
    let err = reader.join().unwrap_or_default();
    if status.success() {
        Ok(())
    } else {
        Err(redact_ffmpeg(&err))
    }
}

fn redact_ffmpeg(err: &str) -> String {
    let trimmed = err.trim();
    if trimmed.is_empty() || trimmed.contains("://") {
        return "Could not record that feed. Check the stream URL or the audio input.".into();
    }
    let short: String = trimmed.chars().take(180).collect();
    format!("Could not record that feed. {short}")
}

fn capture_devices() -> Vec<AudioInput> {
    #[cfg(windows)]
    {
        parse_dshow(&command_text("ffmpeg", &["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]))
    }
    #[cfg(not(windows))]
    {
        parse_pactl(&command_text("pactl", &["list", "short", "sources"]))
    }
}

fn command_text(program: &str, args: &[&str]) -> String {
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output();
    match output {
        Ok(output) => {
            let mut text = String::from_utf8_lossy(&output.stdout).to_string();
            text.push_str(&String::from_utf8_lossy(&output.stderr));
            text
        }
        Err(_) => String::new(),
    }
}

fn parse_pactl(text: &str) -> Vec<AudioInput> {
    let mut out = Vec::new();
    for line in text.lines() {
        let mut cols = line.split('\t');
        let _index = cols.next();
        let Some(name) = cols.next() else { continue };
        let name = name.trim();
        if name.is_empty() || name.ends_with(".monitor") || !device_id_ok(name) {
            continue;
        }
        out.push(AudioInput {
            id: name.to_string(),
            label: name.replace('_', " "),
        });
    }
    out
}

fn parse_dshow(text: &str) -> Vec<AudioInput> {
    let mut out = Vec::new();
    let mut audio = false;
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.contains("audio devices") {
            audio = true;
            continue;
        }
        if lower.contains("video devices") {
            audio = false;
            continue;
        }
        if !audio && !lower.contains("(audio)") {
            continue;
        }
        if lower.contains("alternative name") {
            continue;
        }
        let Some(name) = quoted(line) else { continue };
        if device_id_ok(&name) {
            out.push(AudioInput {
                id: name.clone(),
                label: name,
            });
        }
    }
    out
}

fn quoted(line: &str) -> Option<String> {
    let start = line.find('"')?;
    let end = line.rfind('"')?;
    if end <= start {
        return None;
    }
    let name = line[start + 1..end].trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

fn prune_clips(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut files: Vec<(SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("wav") {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        if modified
            .elapsed()
            .map(|age| age.as_secs() > 6 * 3600)
            .unwrap_or(false)
        {
            let _ = fs::remove_file(&path);
            continue;
        }
        files.push((modified, path));
    }
    files.sort_by_key(|(modified, _)| *modified);
    while files.len() > 12 {
        if let Some((_, path)) = files.first() {
            let _ = fs::remove_file(path);
        }
        files.remove(0);
    }
}

fn encode_base64(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    let mut index = 0;
    while index + 3 <= data.len() {
        let n = ((data[index] as u32) << 16) | ((data[index + 1] as u32) << 8) | (data[index + 2] as u32);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push(TABLE[(n & 63) as usize] as char);
        index += 3;
    }
    if index < data.len() {
        let rest = data.len() - index;
        let n = if rest == 1 {
            (data[index] as u32) << 16
        } else {
            ((data[index] as u32) << 16) | ((data[index + 1] as u32) << 8)
        };
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        if rest == 1 {
            out.push('=');
            out.push('=');
        } else {
            out.push(TABLE[((n >> 6) & 63) as usize] as char);
            out.push('=');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pactl_skips_monitor_sources() {
        let text = "\
0\talsa_output.pci.analog-stereo.monitor\tmodule\ts16le\tSUSPENDED
1\talca_input.pci.analog-stereo\tmodule\ts16le\tRUNNING
2\tbluez_input.AA_BB\tmodule\ts16le\tIDLE
";
        let devices = parse_pactl(text);
        let ids: Vec<_> = devices.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["alca_input.pci.analog-stereo", "bluez_input.AA_BB"]
        );
    }

    #[test]
    fn dshow_reads_audio_names_only() {
        let text = "\
DirectShow video devices
 \"Integrated Camera\"
DirectShow audio devices
 \"Microphone (Realtek(R) Audio)\"
    Alternative name \"@device_cm\"
";
        let devices = parse_dshow(text);
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].id, "Microphone (Realtek(R) Audio)");
    }

    #[test]
    fn stream_url_rejects_files_and_blank() {
        assert!(validate_stream_url("").is_err());
        assert!(validate_stream_url("file:///tmp/a.wav").is_err());
        assert!(validate_stream_url("ftp://example.com/a").is_err());
        assert_eq!(
            validate_stream_url("https://example.com/live").unwrap(),
            "https://example.com/live"
        );
    }

    #[test]
    fn device_id_rejects_newlines_and_flags() {
        assert!(device_id_ok("default"));
        assert!(device_id_ok("Microphone (Realtek Audio)"));
        assert!(!device_id_ok("mic\n-evil"));
        assert!(!device_id_ok("-hide_banner"));
        assert!(normalize_device("").unwrap() == "default");
        assert!(normalize_device("mic\n-evil").is_err());
    }

    #[test]
    fn online_args_keep_the_url_as_one_argument() {
        let dest = Path::new("/tmp/clip.wav");
        let args = online_ffmpeg_args("https://example.com/live?token=abc", 12, dest);
        let input = args.iter().position(|arg| arg == "-i").unwrap();
        assert_eq!(args[input + 1], "https://example.com/live?token=abc");
        assert_eq!(args.last().unwrap(), "/tmp/clip.wav");
        assert!(args.iter().all(|arg| !arg.contains("ffmpeg")));
    }

    #[test]
    fn base64_matches_known_values() {
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
    }

    #[test]
    fn clip_ids_cannot_escape_the_folder() {
        let root = std::env::temp_dir().join(format!("cc-safety-{}", uuid::Uuid::new_v4().simple()));
        let err = clip_file(&root, "../secret").unwrap_err();
        assert!(err.contains("Unknown"));
        let _ = fs::remove_dir_all(&root);
    }
}
