//! On-device speech model. Audio never leaves this computer.
//!
//! Install downloads a pinned Whisper runtime and the Tiny English model,
//! checks the checksum, and keeps both under the Command Center config directory.

use crate::ai_sync::{self, AiMemory};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin";
const MODEL_SHA256: &str = "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f";
const LINUX_RUNTIME_URL: &str =
    "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-ubuntu-x64.tar.gz";
const LINUX_RUNTIME_SHA256: &str =
    "a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c";
const WINDOWS_RUNTIME_URL: &str =
    "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip";
const WINDOWS_RUNTIME_SHA256: &str =
    "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb";
const MAX_AUDIO_BYTES: u64 = 20 * 1024 * 1024;

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

pub fn transcribe(root: &Path, source_url: &str) -> Result<(Vec<TranscriptSegment>, String), TranscribeError> {
    let current = status(root);
    if !current.installed {
        return Err(TranscribeError::NotInstalled);
    }
    let marker = read_marker(root).ok_or_else(|| TranscribeError::Message("Local AI is not installed.".into()))?;
    let audio = materialize_audio(source_url).map_err(TranscribeError::Message)?;
    let memory = ai_sync::load(root);
    let result = run_whisper(root, &marker, &audio.path, &memory);
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
        fs::remove_dir_all(&staging).map_err(|err| format!("could not prepare the install: {err}"))?;
    }
    fs::create_dir_all(staging.join("models")).map_err(|err| format!("could not prepare the install: {err}"))?;
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
    fs::rename(staging.join("models"), &final_models).map_err(|err| format!("could not place the model: {err}"))?;
    fs::rename(&runtime_dir, &final_runtime).map_err(|err| format!("could not place the runtime: {err}"))?;
    let _ = fs::remove_dir_all(&staging);
    let model_rel = path_rel(root, &final_models.join("ggml-tiny.en.bin"))?;
    let model_bytes = fs::metadata(root.join(&model_rel)).map(|meta| meta.len()).unwrap_or(0);
    let runtime_rel = runtime_suffix(&binary, &runtime_dir);
    let marker = Marker {
        model_id: plan.model_id.into(),
        model_label: plan.label.into(),
        model_bytes,
        model_path: model_rel,
        runtime_path: format!("ai/runtime/{runtime_rel}"),
    };
    let raw = serde_json::to_string_pretty(&marker).map_err(|err| err.to_string())?;
    fs::write(ai.join("install.json"), raw).map_err(|err| format!("could not record the install: {err}"))?;
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
    let rel = path.strip_prefix(root).map_err(|_| "install path escaped the config directory".to_string())?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

fn download(fetch: &Fetch, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let partial = dest.with_extension(format!(
        "{}.partial",
        dest.extension().and_then(|ext| ext.to_str()).unwrap_or("bin")
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
    let mut file = File::create(&partial).map_err(|err| format!("could not write the download: {err}"))?;
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
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("");
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
        let mut perms = fs::metadata(path).map_err(|err| err.to_string())?.permissions();
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
        let parsed = url::Url::parse(source_url).map_err(|_| "That audio file URL is not valid.".to_string())?;
        let path = parsed
            .to_file_path()
            .map_err(|_| "That audio file URL is not valid.".to_string())?;
        let meta = fs::metadata(&path).map_err(|_| "Could not read that audio file.".to_string())?;
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
        let read = response.read(&mut buf).map_err(|_| "The audio download stopped.".to_string())?;
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
    !(head.starts_with("<!") || head.starts_with("<html") || head.starts_with("{") || head.starts_with("["))
}

fn run_whisper(root: &Path, marker: &Marker, audio: &Path, memory: &AiMemory) -> Result<Vec<TranscriptSegment>, String> {
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
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|err| format!("could not start the local model: {err}"))?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > Duration::from_secs(180) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = fs::remove_file(out_json(&out_base));
                return Err("The local model took too long and was stopped.".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(err) => return Err(format!("the local model stopped: {err}")),
        }
    };
    let json_path = out_json(&out_base);
    if !status.success() {
        let err = child
            .stderr
            .as_mut()
            .and_then(|stderr| {
                let mut raw = String::new();
                stderr.read_to_string(&mut raw).ok()?;
                Some(raw)
            })
            .unwrap_or_default();
        let _ = fs::remove_file(&json_path);
        let trimmed = err.chars().take(400).collect::<String>();
        return Err(if trimmed.is_empty() {
            "The local model could not transcribe that clip.".into()
        } else {
            format!("The local model could not transcribe that clip. {trimmed}")
        });
    }
    let raw = fs::read_to_string(&json_path).map_err(|_| "The local model did not write a transcript.".to_string())?;
    let _ = fs::remove_file(&json_path);
    let mut segments = parse_whisper_json(&raw)?;
    for segment in &mut segments {
        segment.text = ai_sync::apply_corrections(&segment.text, memory);
    }
    if segments.is_empty() {
        return Err("The model did not return any words.".into());
    }
    Ok(segments)
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
        });
    }
    Ok(segments)
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
                let Ok(n) = stream.read(&mut buf) else { continue };
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
        let _ = fs::remove_dir_all(&root);
    }
}
