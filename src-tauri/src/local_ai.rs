//! On-device speech model. Audio never leaves this computer.
//!
//! Install downloads a pinned Whisper runtime and the Tiny English model,
//! checks the checksum, and keeps both under the Command Center config directory.
//! The Windows installer copies this same model and runtime into that directory
//! (`scripts/fetch-tiny-en.mjs`) so a new install already has Tiny English.

use crate::ai_sync::{self, AiMemory};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin";
/// Same bytes the Windows installer ships. `scripts/fetch-tiny-en.mjs` refuses a mismatch.
const MODEL_SHA256: &str = "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f";
const LINUX_RUNTIME_URL: &str =
    "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-ubuntu-x64.tar.gz";
const LINUX_RUNTIME_SHA256: &str =
    "a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c";
const WINDOWS_RUNTIME_URL: &str =
    "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip";
/// Same archive the Windows installer ships. `scripts/fetch-tiny-en.mjs` refuses a mismatch.
const WINDOWS_RUNTIME_SHA256: &str =
    "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb";
const MAX_AUDIO_BYTES: u64 = 20 * 1024 * 1024;
const RELAY_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 CommandCenter/0.1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalAiStatus {
    pub installed: bool,
    pub model_id: Option<String>,
    pub model_label: Option<String>,
    pub bytes: Option<u64>,
    pub runtime_ready: bool,
    pub path: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptSegment {
    pub start_sec: f64,
    pub end_sec: f64,
    pub text: String,
    /// Stable person key from a local diarizer. Not a unit ID.
    /// The pinned Tiny English runtime leaves this empty.
    pub speaker: Option<String>,
}

#[derive(Debug)]
pub enum TranscribeError {
    NotInstalled,
    Message(String),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ArchiveKind {
    TarGz,
    Zip,
}

struct Fetch {
    url: String,
    sha256: String,
    max_bytes: u64,
}

struct InstallPlan {
    model_id: &'static str,
    label: &'static str,
    model: Fetch,
    runtime: Fetch,
    kind: ArchiveKind,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Marker {
    model_id: String,
    model_label: String,
    model_bytes: u64,
    model_path: String,
    runtime_path: String,
}

pub fn status(root: &Path) -> LocalAiStatus {
    match read_marker(root) {
        Some(marker) => {
            let model = root.join(&marker.model_path);
            let runtime = root.join(&marker.runtime_path);
            let ready = model.is_file() && runtime.is_file();
            LocalAiStatus {
                installed: ready,
                model_id: Some(marker.model_id),
                model_label: Some(marker.model_label),
                bytes: Some(marker.model_bytes),
                runtime_ready: ready,
                path: ready.then(|| model.display().to_string()),
                message: if ready {
                    None
                } else {
                    Some("The local AI files are missing. Install again.".into())
                },
            }
        }
        None => LocalAiStatus {
            installed: false,
            model_id: None,
            model_label: None,
            bytes: None,
            runtime_ready: false,
            path: None,
            message: None,
        },
    }
}

pub fn install(root: &Path) -> Result<LocalAiStatus, String> {
    let plan = production_plan()?;
    install_with(root, &plan)
}

pub fn remove(root: &Path) -> Result<LocalAiStatus, String> {
    let dir = root.join("ai");
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|err| format!("could not remove the local AI: {err}"))?;
    }
    Ok(status(root))
}

pub fn transcribe(
    root: &Path,
    source_url: &str,
) -> Result<(Vec<TranscriptSegment>, String), TranscribeError> {
    transcribe_file(root, source_url, true)
}

/// Tiny English words before this computer's caption fixes.
/// Local audio keeps those words and applies the caption store once.
pub fn transcribe_heard(
    root: &Path,
    source_url: &str,
) -> Result<(Vec<TranscriptSegment>, String), TranscribeError> {
    transcribe_file(root, source_url, false)
}

fn transcribe_file(
    root: &Path,
    source_url: &str,
    apply_memory: bool,
) -> Result<(Vec<TranscriptSegment>, String), TranscribeError> {
    if caption_download_blocked(source_url) {
        return Err(TranscribeError::Message(
            "YouTube audio is not downloaded. This panel uses YouTube's captions.".into(),
        ));
    }
    let current = status(root);
    if !current.installed {
        return Err(TranscribeError::NotInstalled);
    }
    let marker = read_marker(root)
        .ok_or_else(|| TranscribeError::Message("Local AI is not installed.".into()))?;
    let audio = materialize_audio(source_url).map_err(TranscribeError::Message)?;
    let memory = ai_sync::load(root);
    let result = run_whisper(root, &marker, &audio.path, &memory, apply_memory);
    drop(audio);
    let segments = result.map_err(TranscribeError::Message)?;
    let note = format!(
        "Transcribed on this computer with {}. Audio was not uploaded.",
        marker.model_label
    );
    Ok((segments, note))
}

fn production_plan() -> Result<InstallPlan, String> {
    let (runtime, kind) = if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        (
            Fetch {
                url: LINUX_RUNTIME_URL.into(),
                sha256: LINUX_RUNTIME_SHA256.into(),
                max_bytes: 20 * 1024 * 1024,
            },
            ArchiveKind::TarGz,
        )
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        (
            Fetch {
                url: WINDOWS_RUNTIME_URL.into(),
                sha256: WINDOWS_RUNTIME_SHA256.into(),
                max_bytes: 20 * 1024 * 1024,
            },
            ArchiveKind::Zip,
        )
    } else {
        return Err("Local AI is available on 64-bit Windows and Linux.".into());
    };
    Ok(InstallPlan {
        model_id: "tiny.en",
        label: "Tiny English",
        model: Fetch {
            url: MODEL_URL.into(),
            sha256: MODEL_SHA256.into(),
            max_bytes: 80 * 1024 * 1024,
        },
        runtime,
        kind,
    })
}

fn install_with(root: &Path, plan: &InstallPlan) -> Result<LocalAiStatus, String> {
    let ai = root.join("ai");
    let staging = ai.join(".staging");
    if staging.exists() {
        fs::remove_dir_all(&staging)
            .map_err(|err| format!("could not prepare the install: {err}"))?;
    }
    fs::create_dir_all(staging.join("models"))
        .map_err(|err| format!("could not prepare the install: {err}"))?;
    let model_file = staging.join("models").join("ggml-tiny.en.bin");
    download(&plan.model, &model_file)?;
    let archive = staging.join(if plan.kind == ArchiveKind::TarGz {
        "runtime.tar.gz"
    } else {
        "runtime.zip"
    });
    download(&plan.runtime, &archive)?;
    let runtime_dir = staging.join("runtime");
    extract(&archive, &runtime_dir, plan.kind)?;
    let binary = find_binary(&runtime_dir)?;
    make_executable(&binary)?;
    let final_models = ai.join("models");
    let final_runtime = ai.join("runtime");
    if final_models.exists() {
        fs::remove_dir_all(&final_models).map_err(|err| err.to_string())?;
    }
    if final_runtime.exists() {
        fs::remove_dir_all(&final_runtime).map_err(|err| err.to_string())?;
    }
    fs::create_dir_all(&ai).map_err(|err| err.to_string())?;
    fs::rename(staging.join("models"), &final_models)
        .map_err(|err| format!("could not place the model: {err}"))?;
    fs::rename(&runtime_dir, &final_runtime)
        .map_err(|err| format!("could not place the runtime: {err}"))?;
    let _ = fs::remove_dir_all(&staging);
    let model_rel = path_rel(root, &final_models.join("ggml-tiny.en.bin"))?;
    let model_bytes = fs::metadata(root.join(&model_rel))
        .map(|meta| meta.len())
        .unwrap_or(0);
    let runtime_rel = runtime_suffix(&binary, &runtime_dir);
    let marker = Marker {
        model_id: plan.model_id.into(),
        model_label: plan.label.into(),
        model_bytes,
        model_path: model_rel,
        runtime_path: format!("ai/runtime/{runtime_rel}"),
    };
    let raw = serde_json::to_string_pretty(&marker).map_err(|err| err.to_string())?;
    fs::write(ai.join("install.json"), raw)
        .map_err(|err| format!("could not record the install: {err}"))?;
    let current = status(root);
    if !current.installed {
        return Err("The install finished but the model is not where it should be.".into());
    }
    Ok(current)
}

fn runtime_suffix(binary: &Path, runtime_dir: &Path) -> String {
    binary
        .strip_prefix(runtime_dir)
        .unwrap_or(binary)
        .components()
        .map(|part| part.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/")
}

fn path_rel(root: &Path, path: &Path) -> Result<String, String> {
    let rel = path
        .strip_prefix(root)
        .map_err(|_| "install path escaped the config directory".to_string())?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

fn download(fetch: &Fetch, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let partial = dest.with_extension(format!(
        "{}.partial",
        dest.extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("bin")
    ));
    let client = http_client()?;
    let mut response = client
        .get(&fetch.url)
        .send()
        .map_err(|err| format!("could not download the local AI: {err}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "could not download the local AI (HTTP {}).",
            response.status()
        ));
    }
    let mut file =
        File::create(&partial).map_err(|err| format!("could not write the download: {err}"))?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let read = response
            .read(&mut buf)
            .map_err(|err| format!("the download stopped: {err}"))?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > fetch.max_bytes {
            let _ = fs::remove_file(&partial);
            return Err("The download is larger than the pinned file.".into());
        }
        hasher.update(&buf[..read]);
        file.write_all(&buf[..read])
            .map_err(|err| format!("could not write the download: {err}"))?;
    }
    file.flush().ok();
    drop(file);
    let digest = hex_encode(&hasher.finalize());
    if !digest.eq_ignore_ascii_case(&fetch.sha256) {
        let _ = fs::remove_file(&partial);
        return Err("The download did not match the expected checksum.".into());
    }
    fs::rename(&partial, dest).map_err(|err| format!("could not finish the download: {err}"))?;
    Ok(())
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let scheme = attempt.url().scheme();
            let host = attempt.url().host_str().unwrap_or("");
            let loopback = host == "127.0.0.1" || host == "localhost" || host == "::1";
            if scheme == "https" || (scheme == "http" && loopback) {
                if attempt.previous().len() >= 5 {
                    return attempt.error(io::Error::other("too many redirects"));
                }
                attempt.follow()
            } else {
                attempt.error(io::Error::other("the download left https"))
            }
        }))
        .timeout(Duration::from_secs(600))
        .user_agent("CommandCenter/0.1 (local speech model)")
        .build()
        .map_err(|err| format!("could not start the download: {err}"))
}

fn extract(archive: &Path, dest: &Path, kind: ArchiveKind) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|err| err.to_string())?;
    let mut cmd = Command::new("tar");
    match kind {
        ArchiveKind::TarGz => {
            cmd.arg("-xzf");
        }
        ArchiveKind::Zip => {
            cmd.arg("-xf");
        }
    }
    let output = cmd
        .arg(archive)
        .arg("-C")
        .arg(dest)
        .output()
        .map_err(|err| format!("could not unpack the local AI runtime: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "could not unpack the local AI runtime: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

fn find_binary(dir: &Path) -> Result<PathBuf, String> {
    let mut found = None;
    visit(dir, &mut |path| {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if name == "whisper-cli" || name == "whisper-cli.exe" {
            found = Some(path.to_path_buf());
        }
    })?;
    found.ok_or_else(|| "The runtime archive did not contain whisper-cli.".into())
}

fn visit(dir: &Path, visit_file: &mut dyn FnMut(&Path)) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|err| err.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            visit(&path, visit_file)?;
        } else {
            visit_file(&path);
        }
    }
    Ok(())
}

fn make_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path)
            .map_err(|err| err.to_string())?
            .permissions();
        perms.set_mode(perms.mode() | 0o755);
        fs::set_permissions(path, perms).map_err(|err| err.to_string())?;
    }
    let _ = path;
    Ok(())
}

fn read_marker(root: &Path) -> Option<Marker> {
    let raw = fs::read_to_string(root.join("ai").join("install.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

struct TempAudio {
    path: PathBuf,
    owned: bool,
}

impl Drop for TempAudio {
    fn drop(&mut self) {
        if self.owned {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn materialize_audio(source_url: &str) -> Result<TempAudio, String> {
    if source_url.starts_with("file:") {
        let parsed = url::Url::parse(source_url)
            .map_err(|_| "That audio file URL is not valid.".to_string())?;
        let path = parsed
            .to_file_path()
            .map_err(|_| "That audio file URL is not valid.".to_string())?;
        let meta =
            fs::metadata(&path).map_err(|_| "Could not read that audio file.".to_string())?;
        if !meta.is_file() || meta.len() > MAX_AUDIO_BYTES {
            return Err("That audio file is missing or larger than 20 MB.".into());
        }
        return Ok(TempAudio { path, owned: false });
    }
    if !(source_url.starts_with("https://") || source_url.starts_with("http://")) {
        return Err("Audio must be a local file or an http(s) URL.".into());
    }
    let client = http_client()?;
    let mut response = client
        .get(source_url)
        .send()
        .map_err(|_| "Could not read that audio on this computer.".to_string())?;
    if !response.status().is_success() {
        return Err("Could not read that audio on this computer.".into());
    }
    let mut bytes = Vec::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let read = response
            .read(&mut buf)
            .map_err(|_| "The audio download stopped.".to_string())?;
        if read == 0 {
            break;
        }
        if bytes.len() as u64 + read as u64 > MAX_AUDIO_BYTES {
            return Err("That clip is larger than 20 MB.".into());
        }
        bytes.extend_from_slice(&buf[..read]);
    }
    if !looks_like_audio(&bytes) {
        return Err("That URL did not look like an audio file. It was not uploaded.".into());
    }
    let dir = std::env::temp_dir().join(format!("command-center-ai-{}", unique_stamp()));
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let path = dir.join("clip.bin");
    fs::write(&path, &bytes).map_err(|err| err.to_string())?;
    Ok(TempAudio { path, owned: true })
}

fn looks_like_audio(bytes: &[u8]) -> bool {
    if bytes.len() < 4 {
        return false;
    }
    if bytes.starts_with(b"RIFF")
        || bytes.starts_with(b"fLaC")
        || bytes.starts_with(b"OggS")
        || bytes.starts_with(b"ID3")
        || (bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0)
    {
        return true;
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(12)]).to_ascii_lowercase();
    !(head.starts_with("<!")
        || head.starts_with("<html")
        || head.starts_with("{")
        || head.starts_with("["))
}

fn run_whisper(
    root: &Path,
    marker: &Marker,
    audio: &Path,
    memory: &AiMemory,
    apply_memory: bool,
) -> Result<Vec<TranscriptSegment>, String> {
    let runtime = root.join(&marker.runtime_path);
    let model = root.join(&marker.model_path);
    let stamp = unique_stamp();
    let out_base = std::env::temp_dir().join(format!("command-center-ai-{stamp}"));
    let mut cmd = Command::new(&runtime);
    cmd.arg("-m")
        .arg(&model)
        .arg("-f")
        .arg(audio)
        .arg("-oj")
        .arg("-of")
        .arg(&out_base)
        .arg("-np")
        .arg("-ng")
        .arg("-l")
        .arg("en");
    let prompt = ai_sync::prompt_from(memory);
    if !prompt.is_empty() {
        cmd.arg("--prompt").arg(prompt);
    }
    if let Some(dir) = runtime.parent() {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|err| format!("could not start the local model: {err}"))?;
    // Drain stderr while the model runs. A full pipe stalls whisper-cli until the timeout.
    let stderr = child.stderr.take();
    let reader = std::thread::spawn(move || read_capped(stderr, 4_000));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > Duration::from_secs(180) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                let _ = fs::remove_file(out_json(&out_base));
                return Err("The local model took too long and was stopped.".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(err) => {
                let _ = child.kill();
                let _ = reader.join();
                return Err(format!("the local model stopped: {err}"));
            }
        }
    };
    let err_text = reader.join().unwrap_or_default();
    let json_path = out_json(&out_base);
    if !status.success() {
        let _ = fs::remove_file(&json_path);
        let trimmed: String = redact_urls(&err_text).chars().take(400).collect();
        let trimmed = trimmed.trim();
        return Err(if trimmed.is_empty() {
            "The local model could not transcribe that clip.".into()
        } else {
            format!("The local model could not transcribe that clip. {trimmed}")
        });
    }
    let raw = fs::read_to_string(&json_path)
        .map_err(|_| "The local model did not write a transcript.".to_string())?;
    let _ = fs::remove_file(&json_path);
    let mut segments = parse_whisper_json(&raw)?;
    if apply_memory {
        for segment in &mut segments {
            segment.text = ai_sync::apply_corrections(&segment.text, memory);
        }
    }
    if segments.is_empty() {
        return Err("The model did not return any words.".into());
    }
    Ok(segments)
}

/// Person key from the local transcript, when the runtime provides one.
///
/// ggml-tiny.en via whisper.cpp b5454 does not. `whisper-cli -oj` writes
/// `transcription[].text` and `transcription[].offsets` only. There is no
/// speaker token in that model and this command does not run a diarizer.
/// Returning a unit ID here would treat the radio as one voice, which it is not.
/// What is missing is a local diarizer that emits a stable per-person key.
/// That key can later be heard on a different unit. Audio is not uploaded.
fn speaker_key(item: &serde_json::Value) -> Option<String> {
    let raw = item.get("speaker")?.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    Some(raw.to_string())
}

fn out_json(base: &Path) -> PathBuf {
    let mut path = base.as_os_str().to_os_string();
    path.push(".json");
    PathBuf::from(path)
}

fn parse_whisper_json(raw: &str) -> Result<Vec<TranscriptSegment>, String> {
    let value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|_| "The local model wrote a transcript this app could not read.".to_string())?;
    let items = value
        .get("transcription")
        .and_then(|item| item.as_array())
        .ok_or_else(|| "The local model wrote a transcript this app could not read.".to_string())?;
    let mut segments = Vec::new();
    for item in items {
        let text = item
            .get("text")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if text.is_empty() {
            continue;
        }
        let from = item
            .pointer("/offsets/from")
            .and_then(|value| value.as_f64())
            .unwrap_or(0.0);
        let to = item
            .pointer("/offsets/to")
            .and_then(|value| value.as_f64())
            .unwrap_or(from);
        segments.push(TranscriptSegment {
            start_sec: from / 1000.0,
            end_sec: (to / 1000.0).max(from / 1000.0),
            text,
            // whisper-cli JSON has text and offsets only. A future local
            // diarizer may add `speaker` as a person key. Never a unit ID.
            speaker: speaker_key(item),
        });
    }
    Ok(segments)
}

pub struct MediaTranscriptRequest<'a> {
    pub source_url: &'a str,
    pub timeline_start: f64,
    pub seek_sec: f64,
    pub duration_sec: f64,
}

/// True for YouTube and its media hosts. Captioning must not download that audio.
pub fn caption_download_blocked(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let host = parsed
        .host_str()
        .unwrap_or("")
        .trim_end_matches('.')
        .to_ascii_lowercase();
    host == "youtu.be"
        || host.ends_with(".youtu.be")
        || host == "youtube.com"
        || host.ends_with(".youtube.com")
        || host == "youtube-nocookie.com"
        || host.ends_with(".youtube-nocookie.com")
        || host == "googlevideo.com"
        || host.ends_with(".googlevideo.com")
        || host == "youtube.googleapis.com"
        || host.ends_with(".youtube.googleapis.com")
}

/// Transcribe one short slice on this computer. `timeline_start` is added to
/// every timestamp so the words line up with playback. Audio is not uploaded.
pub fn transcribe_media(
    root: &Path,
    request: MediaTranscriptRequest<'_>,
) -> Result<(Vec<TranscriptSegment>, String), TranscribeError> {
    if caption_download_blocked(request.source_url) {
        return Err(TranscribeError::Message(
            "YouTube audio is not downloaded. This panel uses YouTube's captions.".into(),
        ));
    }
    if !status(root).installed {
        return Err(TranscribeError::NotInstalled);
    }
    let marker = read_marker(root)
        .ok_or_else(|| TranscribeError::Message("Local AI is not installed.".into()))?;
    let duration = if request.duration_sec <= 0.0 {
        30.0
    } else {
        request.duration_sec.clamp(1.0, 30.0)
    };
    let seek = request.seek_sec.max(0.0);
    let audio = prepare_whisper_audio(request.source_url, seek, duration)
        .map_err(TranscribeError::Message)?;
    let memory = ai_sync::load(root);
    let mut segments = match run_whisper(root, &marker, &audio.path, &memory, true) {
        Ok(segments) => segments,
        Err(err) if err.contains("did not return any words") => Vec::new(),
        Err(err) => return Err(TranscribeError::Message(err)),
    };
    drop(audio);
    if request.timeline_start != 0.0 {
        for segment in &mut segments {
            segment.start_sec += request.timeline_start;
            segment.end_sec += request.timeline_start;
        }
    }
    let note = format!(
        "Transcribed on this computer with {}. Audio was not uploaded.",
        marker.model_label
    );
    Ok((segments, note))
}

fn prepare_whisper_audio(source_url: &str, seek: f64, duration: f64) -> Result<TempAudio, String> {
    prepare_caption_audio(source_url, seek, duration, true)
}

fn prepare_caption_audio(
    source_url: &str,
    seek: f64,
    duration: f64,
    use_ffmpeg: bool,
) -> Result<TempAudio, String> {
    if seek <= 0.05 {
        if let Some(audio) = existing_whisper_wav(source_url) {
            return Ok(audio);
        }
    }
    let ffmpeg_error = if use_ffmpeg {
        match ffmpeg_to_wav(source_url, seek, duration) {
            Ok(audio) => return Ok(audio),
            Err(err) => err,
        }
    } else {
        "FFMPEG_MISSING".to_string()
    };
    if finite_caption_source(source_url) {
        return match decode_to_whisper_wav(source_url, seek, duration) {
            Ok(audio) => Ok(audio),
            Err(decode_err) if ffmpeg_error == "FFMPEG_MISSING" => Err(decode_err),
            Err(decode_err) => Err(merge_caption_errors(&ffmpeg_error, &decode_err)),
        };
    }
    // A relay does not end. Read one window; do not download it whole.
    match capture_relay_audio(source_url, duration) {
        Ok(audio) => Ok(audio),
        Err(capture_err) if ffmpeg_error == "FFMPEG_MISSING" => Err(capture_err),
        Err(capture_err) => Err(merge_caption_errors(&ffmpeg_error, &capture_err)),
    }
}

/// One short slice of a live relay, decoded on this computer. The read stops
/// after the window, so an open Icecast mount is not saved to disk in full.
fn capture_relay_audio(source_url: &str, duration: f64) -> Result<TempAudio, String> {
    if !(source_url.starts_with("https://") || source_url.starts_with("http://")) {
        return Err("Audio must be a local file or an http(s) URL.".into());
    }
    let window = duration.clamp(1.0, 30.0);
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(4))
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs_f64(window + 12.0))
        .user_agent(RELAY_USER_AGENT)
        .build()
        .map_err(|_| "Couldn't open the relay.".to_string())?;
    let response = client
        .get(source_url)
        .header("Icy-MetaData", "0")
        .header("Accept", "audio/*,*/*;q=0.1")
        .send()
        .map_err(|err| relay_send_error(&err))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "The relay refused the audio (HTTP {}). Audio was not uploaded.",
            status.as_u16()
        ));
    }
    let icy_interval = response
        .headers()
        .get("icy-metaint")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(0);
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let mut bytes = read_window(response, window)?;
    if icy_interval > 0 {
        bytes = strip_icy(&bytes, icy_interval);
    }
    if looks_like_page(&bytes) {
        return Err("The relay sent a web page instead of audio. Audio was not uploaded.".into());
    }
    if looks_like_playlist(&bytes) {
        return Err("The relay sent a playlist instead of audio. Audio was not uploaded.".into());
    }
    let extension = sniff_audio_extension(&bytes, &content_type);
    let (rate, samples) = decode_audio_bytes(&bytes, &extension)?;
    samples_to_whisper_file(&samples, rate, 0.0, window)
}

fn relay_send_error(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        return "The relay did not send audio in time. Audio was not uploaded.".into();
    }
    if err.is_connect() {
        return "Couldn't connect to the relay. Audio was not uploaded.".into();
    }
    let detail = redact_urls(&err.to_string());
    let detail = detail.trim();
    if detail.is_empty() || detail == "the relay" {
        "Couldn't reach the relay. Audio was not uploaded.".into()
    } else {
        format!("Couldn't reach the relay. Audio was not uploaded. {detail}")
    }
}

fn read_window(mut reader: impl Read, window: f64) -> Result<Vec<u8>, String> {
    let deadline = Instant::now() + Duration::from_secs_f64(window + 1.5);
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    const CAP: usize = 1_500_000;
    while buf.len() < CAP && Instant::now() < deadline {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                let room = CAP - buf.len();
                buf.extend_from_slice(&chunk[..n.min(room)]);
            }
            Err(err) => {
                if buf.len() > 1024 {
                    break;
                }
                return Err(read_window_error(&err));
            }
        }
    }
    if buf.len() < 64 {
        return Err(
            "The relay did not send enough audio to caption. Audio was not uploaded.".into(),
        );
    }
    Ok(buf)
}

fn read_window_error(err: &std::io::Error) -> String {
    let timed_out = err.kind() == io::ErrorKind::TimedOut
        || err.to_string().to_ascii_lowercase().contains("timed out");
    if timed_out {
        return "The relay did not send audio in time. Audio was not uploaded.".into();
    }
    let detail = redact_urls(&err.to_string());
    let detail = detail.trim();
    if detail.is_empty() {
        "Couldn't read the relay. Audio was not uploaded.".into()
    } else {
        format!("Couldn't read the relay. Audio was not uploaded. {detail}")
    }
}

fn strip_icy(bytes: &[u8], interval: usize) -> Vec<u8> {
    if interval == 0 {
        return bytes.to_vec();
    }
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let audio_end = (index + interval).min(bytes.len());
        out.extend_from_slice(&bytes[index..audio_end]);
        index = audio_end;
        if index >= bytes.len() {
            break;
        }
        let meta_len = bytes[index] as usize * 16;
        index = index.saturating_add(1 + meta_len);
    }
    out
}

fn looks_like_page(bytes: &[u8]) -> bool {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(64)]);
    let trimmed = head.trim_start().to_ascii_lowercase();
    trimmed.starts_with("<!doctype")
        || trimmed.starts_with("<html")
        || trimmed.starts_with("<head")
        || trimmed.starts_with('{')
        || trimmed.starts_with('[')
}

fn looks_like_playlist(bytes: &[u8]) -> bool {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(32)]);
    head.trim_start().starts_with("#EXTM3U")
}

fn sniff_audio_extension(bytes: &[u8], content_type: &str) -> String {
    let kind = content_type.to_ascii_lowercase();
    if kind.contains("mpeg") || kind.contains("mp3") {
        return "mp3".into();
    }
    if kind.contains("aac") {
        return "aac".into();
    }
    if kind.contains("wav") || kind.contains("wave") {
        return "wav".into();
    }
    if kind.contains("ogg") {
        return "ogg".into();
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" {
        return "wav".into();
    }
    if bytes.len() >= 3 && &bytes[0..3] == b"ID3" {
        return "mp3".into();
    }
    if bytes.len() >= 2 && bytes[0] == 0xff && (bytes[1] & 0xe0) == 0xe0 {
        return "mp3".into();
    }
    String::new()
}

fn decode_audio_bytes(bytes: &[u8], extension: &str) -> Result<(u32, Vec<f32>), String> {
    match decode_pcm(bytes, extension) {
        Ok(decoded) => Ok(decoded),
        Err(err) => {
            let stripped = strip_id3(bytes);
            if stripped.len() == bytes.len() {
                return Err(err);
            }
            decode_pcm(stripped, extension)
        }
    }
}

fn samples_to_whisper_file(
    samples: &[f32],
    rate: u32,
    seek: f64,
    duration: f64,
) -> Result<TempAudio, String> {
    let sliced = slice_pcm(samples, rate, seek, duration);
    if sliced.is_empty() {
        return Err("That clip had no audio to caption.".into());
    }
    let pcm = resample_linear(&sliced, rate, 16_000);
    let dir = std::env::temp_dir().join(format!("command-center-ai-{}", unique_stamp()));
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let wav = dir.join("clip.wav");
    fs::write(&wav, write_pcm_wav(&pcm, 16_000)).map_err(|err| err.to_string())?;
    Ok(TempAudio {
        path: wav,
        owned: true,
    })
}

fn read_capped(stderr: Option<impl Read>, cap: usize) -> String {
    let Some(mut pipe) = stderr else {
        return String::new();
    };
    let mut kept = String::new();
    let mut buf = [0u8; 4096];
    loop {
        match pipe.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if kept.len() < cap {
                    let room = cap - kept.len();
                    let take = n.min(room);
                    kept.push_str(&String::from_utf8_lossy(&buf[..take]));
                }
            }
        }
    }
    kept
}

fn redact_urls(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut out = String::new();
    let mut index = 0;
    while index < text.len() {
        let rest = &lower[index..];
        let http = rest.find("http://");
        let https = rest.find("https://");
        let at = match (http, https) {
            (Some(left), Some(right)) => Some(left.min(right)),
            (Some(left), None) => Some(left),
            (None, Some(right)) => Some(right),
            (None, None) => None,
        };
        let Some(at) = at else {
            out.push_str(&text[index..]);
            break;
        };
        out.push_str(&text[index..index + at]);
        let start = index + at;
        let tail = &text[start..];
        let end = tail
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '<' || c == '>')
            .unwrap_or(tail.len());
        out.push_str("the relay");
        index = start + end;
    }
    out
}

fn merge_caption_errors(first: &str, second: &str) -> String {
    let primary = first.trim();
    let extra = second.trim();
    if primary.is_empty() || primary == "FFMPEG_MISSING" {
        return extra.to_string();
    }
    if extra.is_empty() || primary.contains(extra) {
        return primary.to_string();
    }
    format!("{primary} {extra}")
}

/// A finished file can be decoded here. A relay or playlist is not downloaded whole.
fn finite_caption_source(source_url: &str) -> bool {
    if source_url.starts_with("file:") {
        return true;
    }
    let path = url::Url::parse(source_url)
        .map(|parsed| parsed.path().to_ascii_lowercase())
        .unwrap_or_else(|_| {
            source_url
                .split(['?', '#'])
                .next()
                .unwrap_or("")
                .to_ascii_lowercase()
        });
    [
        ".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac", ".mp4", ".webm", ".m4v", ".mov", ".ts",
        ".m4s", ".caf",
    ]
    .iter()
    .any(|ext| path.ends_with(ext))
}

fn existing_whisper_wav(source_url: &str) -> Option<TempAudio> {
    let path = file_path(source_url)?;
    let bytes = fs::read(&path).ok()?;
    if !is_whisper_wav(&bytes) {
        return None;
    }
    Some(TempAudio { path, owned: false })
}

fn is_whisper_wav(bytes: &[u8]) -> bool {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return false;
    }
    let mut index = 12usize;
    while index + 8 <= bytes.len() {
        let id = &bytes[index..index + 4];
        let size =
            u32::from_le_bytes(bytes[index + 4..index + 8].try_into().unwrap_or([0; 4])) as usize;
        let data_at = index + 8;
        if id == b"fmt " && size >= 16 && data_at + 16 <= bytes.len() {
            let format =
                u16::from_le_bytes(bytes[data_at..data_at + 2].try_into().unwrap_or([0; 2]));
            let channels =
                u16::from_le_bytes(bytes[data_at + 2..data_at + 4].try_into().unwrap_or([0; 2]));
            let rate =
                u32::from_le_bytes(bytes[data_at + 4..data_at + 8].try_into().unwrap_or([0; 4]));
            let bits = u16::from_le_bytes(
                bytes[data_at + 14..data_at + 16]
                    .try_into()
                    .unwrap_or([0; 2]),
            );
            return format == 1 && channels == 1 && rate == 16_000 && bits == 16;
        }
        let step = 8 + size + (size % 2);
        if step == 0 {
            return false;
        }
        index = index.saturating_add(step);
    }
    false
}

fn file_path(source_url: &str) -> Option<PathBuf> {
    let parsed = url::Url::parse(source_url).ok()?;
    if parsed.scheme() != "file" {
        return None;
    }
    parsed.to_file_path().ok()
}

fn ffmpeg_input(source_url: &str) -> Result<String, String> {
    if source_url.starts_with("file:") {
        let path =
            file_path(source_url).ok_or_else(|| "That audio file URL is not valid.".to_string())?;
        return Ok(path.display().to_string());
    }
    if !(source_url.starts_with("https://") || source_url.starts_with("http://")) {
        return Err("Audio must be a local file or an http(s) URL.".into());
    }
    Ok(source_url.to_string())
}

fn ffmpeg_caption_args(input: &str, seek: f64, duration: f64, wav: &Path) -> Vec<String> {
    let mut args = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-user_agent".into(),
        RELAY_USER_AGENT.into(),
    ];
    if seek > 0.05 {
        args.push("-ss".into());
        args.push(format!("{seek:.3}"));
    }
    // `-t` is an output limit so a live relay stops after this window.
    // Putting it before `-i` does not stop every stream.
    args.push("-i".into());
    args.push(input.to_string());
    args.push("-t".into());
    args.push(format!("{:.3}", duration.clamp(1.0, 30.0)));
    args.extend([
        "-vn".into(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        "16000".into(),
        "-c:a".into(),
        "pcm_s16le".into(),
        "-y".into(),
        wav.display().to_string(),
    ]);
    args
}

fn caption_prep_error(detail: &str) -> String {
    let redacted = redact_urls(detail);
    let trimmed = redacted.trim();
    if trimmed.is_empty() || trimmed == "the relay" {
        return "Couldn't prepare audio for captions. Audio was not uploaded.".into();
    }
    let short: String = trimmed.chars().take(180).collect();
    if short
        .to_ascii_lowercase()
        .contains("audio was not uploaded")
    {
        return short;
    }
    format!("Couldn't prepare audio for captions. Audio was not uploaded. {short}")
}

fn ffmpeg_to_wav(source_url: &str, seek: f64, duration: f64) -> Result<TempAudio, String> {
    let dir = std::env::temp_dir().join(format!("command-center-ai-{}", unique_stamp()));
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let wav = dir.join("clip.wav");
    let input = ffmpeg_input(source_url)?;
    let args = ffmpeg_caption_args(&input, seek, duration, &wav);
    let mut child = match Command::new("ffmpeg")
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            let _ = fs::remove_dir_all(&dir);
            return Err("FFMPEG_MISSING".into());
        }
        Err(err) => {
            let _ = fs::remove_dir_all(&dir);
            return Err(caption_prep_error(&err.to_string()));
        }
    };
    let stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut err = String::new();
        if let Some(mut pipe) = stderr {
            let _ = std::io::Read::read_to_string(&mut pipe, &mut err);
        }
        err
    });
    let limit = Duration::from_secs_f64(duration.clamp(1.0, 30.0) + 20.0);
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > limit => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                let _ = fs::remove_dir_all(&dir);
                return Err(
                    "couldn't prepare audio for captions. The capture took too long and was stopped."
                        .into(),
                );
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(80)),
            Err(err) => {
                let _ = child.kill();
                let _ = reader.join();
                let _ = fs::remove_dir_all(&dir);
                return Err(caption_prep_error(&err.to_string()));
            }
        }
    };
    let detail = reader.join().unwrap_or_default();
    if !status.success() || !wav.is_file() {
        let _ = fs::remove_dir_all(&dir);
        return Err(caption_prep_error(&detail));
    }
    Ok(TempAudio {
        path: wav,
        owned: true,
    })
}

fn decode_to_whisper_wav(source_url: &str, seek: f64, duration: f64) -> Result<TempAudio, String> {
    let bytes = load_audio_bytes(source_url)?;
    let (rate, samples) = decode_audio_bytes(&bytes, &extension_of(source_url))?;
    samples_to_whisper_file(&samples, rate, seek, duration)
}

fn load_audio_bytes(source_url: &str) -> Result<Vec<u8>, String> {
    if caption_download_blocked(source_url) {
        return Err("YouTube audio is not downloaded. This panel uses YouTube's captions.".into());
    }
    if let Some(path) = file_path(source_url) {
        let meta =
            fs::metadata(&path).map_err(|_| "Could not read that audio file.".to_string())?;
        if !meta.is_file() || meta.len() > MAX_AUDIO_BYTES {
            return Err("That audio file is missing or larger than 20 MB.".into());
        }
        return fs::read(&path).map_err(|err| err.to_string());
    }
    if !(source_url.starts_with("https://") || source_url.starts_with("http://")) {
        return Err("Audio must be a local file or an http(s) URL.".into());
    }
    crate::media::fetch_media(source_url, None)
}

fn extension_of(source_url: &str) -> String {
    let path = url::Url::parse(source_url)
        .map(|parsed| parsed.path().to_string())
        .unwrap_or_default();
    Path::new(&path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn strip_id3(bytes: &[u8]) -> &[u8] {
    if bytes.len() < 10 || &bytes[0..3] != b"ID3" {
        return bytes;
    }
    let size = ((bytes[6] as usize & 0x7f) << 21)
        | ((bytes[7] as usize & 0x7f) << 14)
        | ((bytes[8] as usize & 0x7f) << 7)
        | (bytes[9] as usize & 0x7f);
    let start = 10 + size;
    if start < bytes.len() {
        &bytes[start..]
    } else {
        bytes
    }
}

fn decode_pcm(bytes: &[u8], extension: &str) -> Result<(u32, Vec<f32>), String> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
    use symphonia::core::errors::Error as AudioError;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let stream = MediaSourceStream::new(
        Box::new(std::io::Cursor::new(bytes.to_vec())),
        Default::default(),
    );
    let mut hint = Hint::new();
    if !extension.is_empty() {
        hint.with_extension(extension);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|_| "couldn't read that audio on this computer.".to_string())?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        .cloned()
        .ok_or_else(|| "That clip had no audio to caption.".to_string())?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|_| "couldn't read that audio on this computer.".to_string())?;
    let mut rate = track.codec_params.sample_rate.unwrap_or(16_000);
    let mut mono = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(AudioError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(AudioError::IoError(_)) => break,
            Err(_) => break,
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(AudioError::DecodeError(_)) => continue,
            Err(_) => break,
        };
        rate = decoded.spec().rate;
        let channels = decoded.spec().channels.count().max(1);
        let mut buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
        buffer.copy_interleaved_ref(decoded);
        if channels == 1 {
            mono.extend_from_slice(buffer.samples());
        } else {
            for frame in buffer.samples().chunks(channels) {
                let sum: f32 = frame.iter().copied().sum();
                mono.push(sum / channels as f32);
            }
        }
    }
    if mono.is_empty() {
        return Err("That clip had no audio to caption.".into());
    }
    Ok((rate, mono))
}

fn slice_pcm(samples: &[f32], rate: u32, seek: f64, duration: f64) -> Vec<f32> {
    if samples.is_empty() || rate == 0 {
        return Vec::new();
    }
    let start = ((seek.max(0.0) * f64::from(rate)) as usize).min(samples.len());
    let end = (((seek.max(0.0) + duration.max(0.0)) * f64::from(rate)) as usize).min(samples.len());
    samples[start..end].to_vec()
}

fn resample_linear(samples: &[f32], from: u32, to: u32) -> Vec<f32> {
    if samples.is_empty() || from == 0 || to == 0 || from == to {
        return samples.to_vec();
    }
    let ratio = f64::from(from) / f64::from(to);
    let out_len = ((samples.len() as f64) / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for index in 0..out_len {
        let position = index as f64 * ratio;
        let left = position.floor() as usize;
        let frac = (position - left as f64) as f32;
        let a = samples[left.min(samples.len() - 1)];
        let b = samples[(left + 1).min(samples.len() - 1)];
        out.push(a + (b - a) * frac);
    }
    out
}

fn write_pcm_wav(samples: &[f32], rate: u32) -> Vec<u8> {
    let mut data = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        data.extend_from_slice(&value.to_le_bytes());
    }
    let data_len = data.len() as u32;
    let mut out = Vec::with_capacity(44 + data.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(&data);
    out
}

fn unique_stamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0xf) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread;

    fn sha(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        hex_encode(&hasher.finalize())
    }

    fn serve(files: Arc<Mutex<std::collections::HashMap<String, Vec<u8>>>>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut stream) = conn else { continue };
                let mut buf = [0u8; 2048];
                let Ok(n) = stream.read(&mut buf) else {
                    continue;
                };
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req.split_whitespace().nth(1).unwrap_or("/");
                let body = files.lock().unwrap().get(path).cloned().unwrap_or_default();
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        format!("http://127.0.0.1:{port}")
    }

    fn pack_runtime() -> Vec<u8> {
        let dir = std::env::temp_dir().join(format!("cc-ai-pack-{}", unique_stamp()));
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("whisper-cli");
        fs::write(
            &script,
            "#!/bin/sh\nout=\nprev=\nfor arg in \"$@\"; do\n  if [ \"$prev\" = \"-of\" ]; then\n    out=$arg\n  fi\n  prev=$arg\ndone\nprintf '%s\\n' '{\"transcription\":[{\"offsets\":{\"from\":0,\"to\":1800},\"text\":\" engine twelve responding\"}]}' > \"$out.json\"\n",
        )
        .unwrap();
        make_executable(&script).unwrap();
        let archive = dir.join("runtime.tar.gz");
        let status = Command::new("tar")
            .args(["-czf"])
            .arg(&archive)
            .arg("-C")
            .arg(&dir)
            .arg("whisper-cli")
            .status()
            .unwrap();
        assert!(status.success());
        let bytes = fs::read(&archive).unwrap();
        let _ = fs::remove_dir_all(&dir);
        bytes
    }

    #[test]
    fn install_checks_the_checksum_and_transcribes_locally() {
        let runtime = pack_runtime();
        let model = b"not-a-real-model".to_vec();
        let files = Arc::new(Mutex::new(std::collections::HashMap::from([
            ("/model".into(), model.clone()),
            ("/runtime.tar.gz".into(), runtime.clone()),
        ])));
        let base = serve(files);
        let root = std::env::temp_dir().join(format!("cc-ai-install-{}", unique_stamp()));
        fs::create_dir_all(&root).unwrap();
        let plan = InstallPlan {
            model_id: "tiny.en",
            label: "Tiny English",
            model: Fetch {
                url: format!("{base}/model"),
                sha256: sha(&model),
                max_bytes: 1024,
            },
            runtime: Fetch {
                url: format!("{base}/runtime.tar.gz"),
                sha256: sha(&runtime),
                max_bytes: 1024 * 1024,
            },
            kind: ArchiveKind::TarGz,
        };
        let installed = install_with(&root, &plan).unwrap();
        assert!(installed.installed);
        assert_eq!(installed.model_label.as_deref(), Some("Tiny English"));
        assert!(installed.runtime_ready);

        let mismatch = InstallPlan {
            model_id: plan.model_id,
            label: plan.label,
            model: Fetch {
                url: plan.model.url.clone(),
                sha256: "0000000000000000000000000000000000000000000000000000000000000000".into(),
                max_bytes: plan.model.max_bytes,
            },
            runtime: Fetch {
                url: plan.runtime.url.clone(),
                sha256: plan.runtime.sha256.clone(),
                max_bytes: plan.runtime.max_bytes,
            },
            kind: plan.kind,
        };
        let err = install_with(&root, &mismatch).unwrap_err();
        assert!(err.contains("checksum"), "{err}");

        let memory = AiMemory {
            version: 1,
            corrections: vec![ai_sync::Correction {
                id: "c1".into(),
                heard: "engine twelve".into(),
                says: "Engine 12".into(),
                count: 1,
            }],
        };
        ai_sync::store(&root, &memory).unwrap();
        let audio = root.join("clip.wav");
        fs::write(&audio, b"RIFFfake").unwrap();
        let url = format!("file://{}", audio.display());
        let (segments, note) = transcribe(&root, &url).unwrap();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "Engine 12 responding");
        assert!(note.contains("not uploaded"));
        assert!((segments[0].end_sec - 1.8).abs() < 0.01);
        assert_eq!(segments[0].speaker, None);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn whisper_json_speaker_is_a_person_key_only_when_the_runtime_emits_one() {
        let plain =
            r#"{"transcription":[{"offsets":{"from":0,"to":1000},"text":" Engine 12 on scene"}]}"#;
        let heard = parse_whisper_json(plain).unwrap();
        assert_eq!(heard[0].text, "Engine 12 on scene");
        assert_eq!(heard[0].speaker, None);

        let keyed = r#"{"transcription":[{"offsets":{"from":0,"to":1000},"text":" Engine 12 on scene","speaker":" voice-a "}]}"#;
        let with_key = parse_whisper_json(keyed).unwrap();
        assert_eq!(with_key[0].speaker.as_deref(), Some("voice-a"));
    }

    #[test]
    fn media_transcript_does_not_fetch_youtube() {
        let root = std::env::temp_dir();
        let err = transcribe_media(
            &root,
            MediaTranscriptRequest {
                source_url: "https://www.youtube.com/watch?v=abcdefghijk",
                timeline_start: 0.0,
                seek_sec: 0.0,
                duration_sec: 12.0,
            },
        )
        .unwrap_err();
        match err {
            TranscribeError::Message(message) => {
                assert!(message.contains("not downloaded"), "{message}")
            }
            TranscribeError::NotInstalled => {
                panic!("youtube should be rejected before the model check")
            }
        }
        assert!(caption_download_blocked("https://youtu.be/abcdefghijk"));
        assert!(caption_download_blocked(
            "https://rr3.googlevideo.com/videoplayback"
        ));
        assert!(!caption_download_blocked(
            "https://cdn.example/hls/playlist_audio_en_1_00001.aac"
        ));
    }

    #[test]
    fn live_relay_is_not_a_finite_caption_file() {
        assert!(finite_caption_source("file:///tmp/clip.wav"));
        assert!(finite_caption_source(
            "https://cdn.example/archive/hour.mp3?token=abc"
        ));
        assert!(!finite_caption_source("http://relay.example/penn_hills"));
        assert!(!finite_caption_source(
            "https://cdn.example/hls/playlist.m3u8"
        ));
        let args = ffmpeg_caption_args(
            "http://relay.example/penn_hills",
            0.0,
            12.0,
            std::path::Path::new("clip.wav"),
        );
        let input = args.iter().position(|arg| arg == "-i").unwrap();
        let limit = args.iter().position(|arg| arg == "-t").unwrap();
        assert!(limit > input);
        assert_eq!(args[limit + 1], "12.000");
    }

    #[test]
    fn media_transcript_shifts_a_local_wav() {
        let root = std::env::temp_dir().join(format!("cc-ai-media-{}", unique_stamp()));
        fs::create_dir_all(root.join("ai/runtime")).unwrap();
        fs::create_dir_all(root.join("ai/models")).unwrap();
        let script = root.join("ai/runtime/whisper-cli");
        fs::write(
            &script,
            "#!/bin/sh\nout=\nprev=\nfor arg in \"$@\"; do\n  if [ \"$prev\" = \"-of\" ]; then\n    out=$arg\n  fi\n  prev=$arg\ndone\nprintf '%s\\n' '{\"transcription\":[{\"offsets\":{\"from\":0,\"to\":1800},\"text\":\" engine twelve responding\"}]}' > \"$out.json\"\n",
        )
        .unwrap();
        make_executable(&script).unwrap();
        fs::write(root.join("ai/models/ggml-tiny.en.bin"), b"model").unwrap();
        let marker = Marker {
            model_id: "tiny.en".into(),
            model_label: "Tiny English".into(),
            model_bytes: 5,
            model_path: "ai/models/ggml-tiny.en.bin".into(),
            runtime_path: "ai/runtime/whisper-cli".into(),
        };
        fs::write(
            root.join("ai/install.json"),
            serde_json::to_string(&marker).unwrap(),
        )
        .unwrap();
        let wav_path = root.join("tone.wav");
        fs::write(&wav_path, write_pcm_wav(&[0.0; 1600], 16_000)).unwrap();
        assert!(is_whisper_wav(&fs::read(&wav_path).unwrap()));
        let url = url::Url::from_file_path(&wav_path).unwrap().to_string();
        let (segments, note) = transcribe_media(
            &root,
            MediaTranscriptRequest {
                source_url: &url,
                timeline_start: 12.0,
                seek_sec: 0.0,
                duration_sec: 6.0,
            },
        )
        .unwrap();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "engine twelve responding");
        assert!((segments[0].start_sec - 12.0).abs() < 0.01);
        assert!((segments[0].end_sec - 13.8).abs() < 0.01);
        assert!(note.contains("not uploaded"));
        let _ = fs::remove_dir_all(&root);
    }

    fn install_chatty_model(root: &Path, text: &str) {
        fs::create_dir_all(root.join("ai/runtime")).unwrap();
        fs::create_dir_all(root.join("ai/models")).unwrap();
        let script = root.join("ai/runtime/whisper-cli");
        let body = format!(
            "#!/bin/sh\ndd if=/dev/zero bs=1024 count=128 2>/dev/null | tr '\\0' 'm' >&2\nout=\nprev=\nfor arg in \"$@\"; do\n  if [ \"$prev\" = \"-of\" ]; then\n    out=$arg\n  fi\n  prev=$arg\ndone\nprintf '%s\\n' '{{\"transcription\":[{{\"offsets\":{{\"from\":0,\"to\":2200}},\"text\":\" {text}\"}}]}}' > \"$out.json\"\n"
        );
        fs::write(&script, body).unwrap();
        make_executable(&script).unwrap();
        fs::write(root.join("ai/models/ggml-tiny.en.bin"), b"model").unwrap();
        let marker = Marker {
            model_id: "tiny.en".into(),
            model_label: "Tiny English".into(),
            model_bytes: 5,
            model_path: "ai/models/ggml-tiny.en.bin".into(),
            runtime_path: "ai/runtime/whisper-cli".into(),
        };
        fs::write(
            root.join("ai/install.json"),
            serde_json::to_string(&marker).unwrap(),
        )
        .unwrap();
    }

    fn serve_reply(status: u16, kind: &'static str, body: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut stream) = conn else { continue };
                let mut buf = [0u8; 4096];
                let Ok(_n) = stream.read(&mut buf) else {
                    continue;
                };
                let reason = if status == 200 { "OK" } else { "NO" };
                let head = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        format!("http://127.0.0.1:{port}")
    }

    #[test]
    fn missing_model_is_its_own_reason() {
        let root = std::env::temp_dir().join(format!("cc-ai-missing-{}", unique_stamp()));
        fs::create_dir_all(&root).unwrap();
        let err = transcribe_media(
            &root,
            MediaTranscriptRequest {
                source_url: "http://relay.example/penn_hills",
                timeline_start: 0.0,
                seek_sec: 0.0,
                duration_sec: 12.0,
            },
        )
        .unwrap_err();
        assert!(matches!(err, TranscribeError::NotInstalled));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn caption_errors_drop_relay_secrets() {
        let message = caption_prep_error(
            "Server returned 403 Forbidden\nhttp://owner:supersecret@relay.example/mount?p=supersecret",
        );
        assert!(message.contains("403"), "{message}");
        assert!(!message.contains("supersecret"), "{message}");
        assert!(!message.contains("://"), "{message}");
        assert!(!message.contains("[object Object]"), "{message}");
    }

    #[test]
    fn icy_metadata_is_not_left_in_the_audio() {
        let mut bytes = b"aaaa".to_vec();
        bytes.push(1);
        bytes.extend(std::iter::repeat(b'm').take(16));
        bytes.extend(b"bbbb");
        assert_eq!(strip_icy(&bytes, 4), b"aaaabbbb");
    }

    #[test]
    fn a_timed_out_relay_keeps_audio_already_read() {
        struct ThenTimeout {
            left: usize,
        }
        impl Read for ThenTimeout {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                if self.left == 0 {
                    return Err(io::Error::new(io::ErrorKind::TimedOut, "timed out"));
                }
                let n = 200.min(self.left).min(buf.len());
                buf[..n].fill(0x11);
                self.left -= n;
                Ok(n)
            }
        }
        let got = read_window(ThenTimeout { left: 4_000 }, 1.0).unwrap();
        assert!(got.len() > 1024);
        let err = read_window(ThenTimeout { left: 0 }, 1.0).unwrap_err();
        assert!(err.contains("did not send audio in time"), "{err}");
        assert!(!err.contains("[object Object]"), "{err}");
    }

    #[test]
    fn installed_model_captions_a_relay_without_printing_the_url() {
        let root = std::env::temp_dir().join(format!("cc-ai-relay-{}", unique_stamp()));
        install_chatty_model(&root, "Engine 12 responding");
        let wav = write_pcm_wav(&[0.2, -0.2, 0.2, -0.2].repeat(4_000).as_slice(), 16_000);
        let base = serve_reply(200, "audio/wav", wav);
        let url = format!("{base}/penn_hills?p=supersecret");
        let (segments, note) = transcribe_media(
            &root,
            MediaTranscriptRequest {
                source_url: &url,
                timeline_start: 24.0,
                seek_sec: 0.0,
                duration_sec: 2.0,
            },
        )
        .unwrap();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "Engine 12 responding");
        assert!((segments[0].start_sec - 24.0).abs() < 0.01);
        assert!(note.contains("Tiny English"), "{note}");
        assert!(note.contains("not uploaded"), "{note}");
        assert!(!note.contains("supersecret"), "{note}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn relay_refusal_names_the_http_status() {
        let root = std::env::temp_dir().join(format!("cc-ai-deny-{}", unique_stamp()));
        install_chatty_model(&root, "unused");
        let base = serve_reply(403, "text/plain", b"no".to_vec());
        let url = format!("{base}/penn_hills?p=supersecret");
        let err = transcribe_media(
            &root,
            MediaTranscriptRequest {
                source_url: &url,
                timeline_start: 0.0,
                seek_sec: 0.0,
                duration_sec: 2.0,
            },
        )
        .unwrap_err();
        let TranscribeError::Message(message) = err else {
            panic!("expected a message");
        };
        assert!(message.contains("403"), "{message}");
        assert!(!message.contains("supersecret"), "{message}");
        assert!(!message.contains("[object Object]"), "{message}");
        assert!(
            !message.contains("Couldn't create captions on this device"),
            "{message}"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn relay_audio_decodes_without_ffmpeg() {
        let wav = write_pcm_wav(&[0.1, -0.1].repeat(8_000).as_slice(), 16_000);
        let base = serve_reply(200, "audio/wav", wav);
        let audio = prepare_caption_audio(&format!("{base}/penn_hills"), 0.0, 2.0, false).unwrap();
        let bytes = fs::read(&audio.path).unwrap();
        assert!(is_whisper_wav(&bytes));
    }

    #[test]
    fn windows_installer_layout_counts_as_tiny_english() {
        let root = std::env::temp_dir().join(format!("cc-ai-bundle-{}", unique_stamp()));
        fs::create_dir_all(root.join("ai/models")).unwrap();
        fs::create_dir_all(root.join("ai/runtime")).unwrap();
        fs::write(root.join("ai/models/ggml-tiny.en.bin"), b"model").unwrap();
        fs::write(root.join("ai/runtime/whisper-cli.exe"), b"MZ").unwrap();
        fs::write(
            root.join("ai/install.json"),
            r#"{
  "modelId": "tiny.en",
  "modelLabel": "Tiny English",
  "modelBytes": 5,
  "modelPath": "ai/models/ggml-tiny.en.bin",
  "runtimePath": "ai/runtime/whisper-cli.exe"
}
"#,
        )
        .unwrap();
        let installed = status(&root);
        assert!(installed.installed);
        assert!(installed.runtime_ready);
        assert_eq!(installed.model_id.as_deref(), Some("tiny.en"));
        assert_eq!(installed.model_label.as_deref(), Some("Tiny English"));
        assert_eq!(installed.bytes, Some(5));
        assert!(installed.message.is_none());
        assert!(installed
            .path
            .as_deref()
            .unwrap()
            .contains("ggml-tiny.en.bin"));

        fs::remove_file(root.join("ai/runtime/whisper-cli.exe")).unwrap();
        let missing_runtime = status(&root);
        assert!(!missing_runtime.installed);
        assert!(!missing_runtime.runtime_ready);
        let _ = fs::remove_dir_all(&root);
    }
}
