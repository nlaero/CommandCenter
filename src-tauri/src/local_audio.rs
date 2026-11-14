//! Short recordings from a jack or Bluetooth input on this computer.
//! The clip stays here and is transcribed with Tiny English.
//! Nearby-alert recordings and the Broadcastify relay are separate paths.

use crate::local_ai::{self, TranscribeError};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

const WINDOW_SECONDS: u32 = 12;
const MAX_CLIP_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InputKind {
    Jack,
    Bluetooth,
}

impl InputKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Jack => "jack",
            Self::Bluetooth => "bluetooth",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAudioInput {
    pub id: String,
    pub label: String,
    pub kind: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenRequest {
    pub device_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSegment {
    pub id: String,
    pub start_sec: f64,
    pub end_sec: f64,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAudioWindow {
    pub engine: String,
    pub status: String,
    pub note: String,
    pub duration_sec: f64,
    pub segments: Vec<LocalSegment>,
    pub mime: String,
    pub audio_base64: String,
}

pub fn list_inputs() -> Vec<LocalAudioInput> {
    #[cfg(windows)]
    {
        devices_from_dshow(&command_text(
            "ffmpeg",
            &[
                "-hide_banner",
                "-list_devices",
                "true",
                "-f",
                "dshow",
                "-i",
                "dummy",
            ],
        ))
    }
    #[cfg(not(windows))]
    {
        devices_from_pactl(&command_text("pactl", &["list", "short", "sources"]))
    }
}

pub fn listen(root: &Path, request: ListenRequest) -> Result<LocalAudioWindow, String> {
    let id = normalize_device(&request.device_id)?;
    if classify(&id, &id).is_none() {
        return Err("That input is not a jack or Bluetooth device.".into());
    }
    let dir = root.join("local-audio");
    fs::create_dir_all(&dir)
        .map_err(|err| format!("could not prepare a recording folder: {err}"))?;
    prune_clips(&dir);
    let clip_id = uuid::Uuid::new_v4().simple().to_string();
    let dest = dir.join(format!("{clip_id}.wav"));
    if let Err(err) = capture_input(&id, &dest) {
        let _ = fs::remove_file(&dest);
        return Err(err);
    }
    let bytes = match fs::read(&dest) {
        Ok(bytes) if bytes.len() >= 1000 && (bytes.len() as u64) <= MAX_CLIP_BYTES => bytes,
        Ok(_) => {
            let _ = fs::remove_file(&dest);
            return Err("The recording was empty. Check that jack or Bluetooth input.".into());
        }
        Err(err) => {
            let _ = fs::remove_file(&dest);
            return Err(format!("Could not read the recording. {err}"));
        }
    };
    let file_url = url::Url::from_file_path(&dest)
        .map_err(|_| "Could not read the recorded window.".to_string())?;
    let transcribed = local_ai::transcribe_heard(root, file_url.as_str());
    let _ = fs::remove_file(&dest);
    let audio_base64 = encode_base64(&bytes);
    let duration_sec = f64::from(WINDOW_SECONDS);
    match transcribed {
        Ok((segments, note)) => {
            let heard = segments
                .into_iter()
                .enumerate()
                .map(|(index, segment)| LocalSegment {
                    id: format!("{clip_id}-seg-{index}"),
                    start_sec: segment.start_sec,
                    end_sec: segment.end_sec,
                    text: segment.text,
                })
                .filter(|segment| !segment.text.trim().is_empty())
                .collect::<Vec<_>>();
            let status = if heard.is_empty() { "empty" } else { "ready" };
            let note = if heard.is_empty() {
                "No speech in that window.".into()
            } else {
                note
            };
            Ok(LocalAudioWindow {
                engine: "local-whisper".into(),
                status: status.into(),
                note,
                duration_sec,
                segments: heard,
                mime: "audio/wav".into(),
                audio_base64,
            })
        }
        Err(TranscribeError::NotInstalled) => Ok(LocalAudioWindow {
            engine: "local-stub".into(),
            status: "needs-model".into(),
            note: "Tiny English is not installed. Settings → Local AI downloads it onto this computer. Audio stays here.".into(),
            duration_sec,
            segments: Vec::new(),
            mime: "audio/wav".into(),
            audio_base64,
        }),
        Err(TranscribeError::Message(message)) if no_words(&message) => Ok(LocalAudioWindow {
            engine: "local-whisper".into(),
            status: "empty".into(),
            note: "No speech in that window.".into(),
            duration_sec,
            segments: Vec::new(),
            mime: "audio/wav".into(),
            audio_base64,
        }),
        Err(TranscribeError::Message(message)) => Ok(LocalAudioWindow {
            engine: "local-whisper".into(),
            status: "error".into(),
            note: message,
            duration_sec,
            segments: Vec::new(),
            mime: "audio/wav".into(),
            audio_base64,
        }),
    }
}

fn no_words(message: &str) -> bool {
    message
        .to_ascii_lowercase()
        .contains("did not return any words")
}

/// Same jack / Bluetooth split as the settings list.
fn classify(id: &str, label: &str) -> Option<InputKind> {
    let text = format!("{id} {label}").to_ascii_lowercase();
    if text.contains(".monitor") {
        return None;
    }
    if text.contains("bluez")
        || text.contains("bluetooth")
        || text.contains("hands-free")
        || text.contains("handsfree")
        || text.contains("a2dp")
    {
        return Some(InputKind::Bluetooth);
    }
    if text.contains("analog")
        || text.contains("line in")
        || text.contains("line-in")
        || text.contains("line_in")
        || text.contains("aux")
        || text.contains("jack")
        || (text.contains("microphone") && !text.contains("array") && !text.contains("virtual"))
    {
        return Some(InputKind::Jack);
    }
    None
}

fn devices_from_pactl(text: &str) -> Vec<LocalAudioInput> {
    let mut out = Vec::new();
    for line in text.lines() {
        let mut cols = line.split('\t');
        let _index = cols.next();
        let Some(name) = cols.next() else { continue };
        push_device(&mut out, name.trim(), &name.trim().replace('_', " "));
    }
    out
}

fn devices_from_dshow(text: &str) -> Vec<LocalAudioInput> {
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
        push_device(&mut out, &name, &name);
    }
    out
}

fn push_device(out: &mut Vec<LocalAudioInput>, id: &str, label: &str) {
    if !device_id_ok(id) || out.iter().any(|item| item.id == id) {
        return;
    }
    let Some(kind) = classify(id, label) else {
        return;
    };
    out.push(LocalAudioInput {
        id: id.to_string(),
        label: label.to_string(),
        kind: kind.as_str().to_string(),
    });
}

fn normalize_device(raw: &str) -> Result<String, String> {
    let id = raw.trim();
    if id.is_empty() {
        return Err("Choose a jack or Bluetooth input.".into());
    }
    if !device_id_ok(id) {
        return Err("That audio input is not a device name this computer can record.".into());
    }
    Ok(id.to_string())
}

fn device_id_ok(id: &str) -> bool {
    let trimmed = id.trim();
    if trimmed.is_empty() || trimmed.len() > 180 || trimmed.starts_with('-') {
        return false;
    }
    trimmed.chars().all(|ch| {
        ch.is_ascii_alphanumeric()
            || matches!(
                ch,
                ' ' | '.' | '_' | ':' | '+' | '/' | '-' | '(' | ')' | '\''
            )
    })
}

fn capture_input(device_id: &str, dest: &Path) -> Result<(), String> {
    let args = input_ffmpeg_args(device_id, WINDOW_SECONDS, dest);
    run_ffmpeg(&args, Duration::from_secs(u64::from(WINDOW_SECONDS) + 20))
}

fn input_ffmpeg_args(device_id: &str, seconds: u32, dest: &Path) -> Vec<String> {
    input_ffmpeg_args_for(device_id, seconds, dest, cfg!(windows))
}

fn input_ffmpeg_args_for(device_id: &str, seconds: u32, dest: &Path, windows: bool) -> Vec<String> {
    let mut args = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
    ];
    if windows {
        args.extend([
            "-f".into(),
            "dshow".into(),
            "-i".into(),
            format!("audio={device_id}"),
        ]);
    } else {
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
        .map_err(|_| {
            "ffmpeg is not installed, so this computer cannot record that input.".to_string()
        })?;
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
                return Err("Recording the input took too long and was stopped.".into());
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
        return "Could not record that input. Check that jack or Bluetooth device.".into();
    }
    let short: String = trimmed.chars().take(180).collect();
    format!("Could not record that input. {short}")
}

fn command_text(program: &str, args: &[&str]) -> String {
    match Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
    {
        Ok(output) => {
            let mut text = String::from_utf8_lossy(&output.stdout).to_string();
            text.push_str(&String::from_utf8_lossy(&output.stderr));
            text
        }
        Err(_) => String::new(),
    }
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
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
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
            .map(|age| age.as_secs() > 3600)
            .unwrap_or(false)
        {
            let _ = fs::remove_file(&path);
            continue;
        }
        files.push((modified, path));
    }
    files.sort_by_key(|(modified, _)| *modified);
    while files.len() > 4 {
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
        let n = ((data[index] as u32) << 16)
            | ((data[index + 1] as u32) << 8)
            | (data[index + 2] as u32);
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
    fn pactl_keeps_jack_and_bluetooth_only() {
        let text = "\
0\talsa_output.pci.analog-stereo.monitor\tmodule\ts16le\tSUSPENDED
1\talca_input.pci-0000_00_1f.3.analog-stereo\tmodule\ts16le\tRUNNING
2\tbluez_input.AA_BB\tmodule\ts16le\tIDLE
3\talca_input.usb-array.monitor\tmodule\ts16le\tIDLE
";
        let devices = devices_from_pactl(text);
        let ids: Vec<_> = devices.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "alca_input.pci-0000_00_1f.3.analog-stereo",
                "bluez_input.AA_BB"
            ]
        );
        assert_eq!(devices[0].kind, "jack");
        assert_eq!(devices[1].kind, "bluetooth");
    }

    #[test]
    fn dshow_splits_jack_bluetooth_and_skips_arrays() {
        let text = "\
DirectShow video devices
 \"Integrated Camera\"
DirectShow audio devices
 \"Microphone Array (Intel Smart Sound)\"
 \"Microphone (Realtek(R) Audio)\"
    Alternative name \"@device_cm\"
 \"Headset (Bluetooth Hands-Free)\"
 \"Line In (Realtek High Definition Audio)\"
";
        let devices = devices_from_dshow(text);
        let labels: Vec<_> = devices
            .iter()
            .map(|item| (item.kind.as_str(), item.label.as_str()))
            .collect();
        assert_eq!(
            labels,
            vec![
                ("jack", "Microphone (Realtek(R) Audio)"),
                ("bluetooth", "Headset (Bluetooth Hands-Free)"),
                ("jack", "Line In (Realtek High Definition Audio)"),
            ]
        );
    }

    #[test]
    fn device_id_rejects_flags_and_blank() {
        assert!(normalize_device("").is_err());
        assert!(normalize_device("-hide_banner").is_err());
        assert!(normalize_device("mic\n-evil").is_err());
        assert!(classify("default", "Default input").is_none());
        assert_eq!(
            normalize_device("bluez_input.AA_BB").unwrap(),
            "bluez_input.AA_BB"
        );
        assert_eq!(
            classify("bluez_input.AA_BB", "bluez_input.AA_BB"),
            Some(InputKind::Bluetooth)
        );
    }

    #[test]
    fn ffmpeg_args_keep_the_device_as_one_argument() {
        let dest = Path::new("/tmp/local-audio.wav");
        let pulse = input_ffmpeg_args_for("bluez_input.AA_BB", 12, dest, false);
        let input = pulse.iter().position(|arg| arg == "-i").unwrap();
        assert_eq!(pulse[input - 1], "pulse");
        assert_eq!(pulse[input + 1], "bluez_input.AA_BB");
        assert!(pulse.iter().any(|arg| arg == "16000"));
        assert_eq!(pulse.last().unwrap(), "/tmp/local-audio.wav");
        let dshow = input_ffmpeg_args_for("Microphone (Realtek Audio)", 12, dest, true);
        let dshow_input = dshow.iter().position(|arg| arg == "-i").unwrap();
        assert_eq!(dshow[dshow_input + 1], "audio=Microphone (Realtek Audio)");
        assert!(dshow.iter().all(|arg| !arg.contains("ffmpeg")));
    }

    #[test]
    fn base64_matches_known_values() {
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
    }
}
