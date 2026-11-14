//! A Command Center install either talks to a server or runs one.
//!
//! The server binary is `auth-server` (command-center-auth). This module writes nothing
//! about source secrets itself; the vault sync below only runs for a device-only server
//! that the user opted into.

use crate::auth::{AuthError, AuthService, KeyringStore};
use crate::config::{self, AppState, ConfigError, ConfigPaths};
use crate::secrets;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServerStatus {
    pub installed: bool,
    pub running: bool,
    pub role: Option<String>,
    pub store_secrets: bool,
    pub port: u16,
    pub base_url: Option<String>,
    pub binary_found: bool,
    pub lan_address: Option<String>,
    /// `service` or `login` after this computer has installed a server.
    pub startup: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServerChange {
    pub status: LocalServerStatus,
    pub state: AppState,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupDocument {
    pub document: String,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallMarker {
    role: String,
    secret_store: bool,
    port: u16,
    #[allow(dead_code)]
    bind: String,
    base_url: String,
    #[serde(default)]
    startup: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingSetup {
    #[serde(default)]
    pending: bool,
    #[serde(default)]
    install_server: bool,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    store_secrets: bool,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    remote_url: Option<String>,
    #[serde(default)]
    allow_insecure_http: bool,
    #[serde(default)]
    startup: Option<String>,
    #[serde(default)]
    admin_username: Option<String>,
    #[serde(default)]
    admin_password: Option<String>,
}

pub fn status(root: &Path) -> LocalServerStatus {
    let marker = read_marker(root);
    let port = marker.as_ref().map(|m| m.port).unwrap_or(8080);
    let running = marker.is_some() && health_ok(port);
    let role = marker.as_ref().map(|m| m.role.clone());
    let store_secrets = marker.as_ref().map(|m| m.secret_store).unwrap_or(false);
    let lan_address = if role.as_deref() == Some("shared") && running {
        lan_hint().map(|ip| format!("http://{ip}:{port}"))
    } else {
        None
    };
    let startup = marker.as_ref().and_then(|item| item.startup.clone());
    LocalServerStatus {
        installed: marker.is_some(),
        running,
        role,
        store_secrets,
        port,
        base_url: marker.map(|m| m.base_url),
        binary_found: find_binary().is_some(),
        lan_address,
        startup,
        message: read_error(root),
    }
}

pub fn install_local(
    root: &Path,
    role: &str,
    store_secrets: bool,
    port: u16,
    startup: &str,
    admin_username: &str,
    admin_password: &str,
) -> Result<String, String> {
    let role = normalize_role(role)?;
    if !(1..=65535).contains(&port) {
        return Err("Port must be between 1 and 65535.".into());
    }
    let store_secrets = if role == "device" {
        store_secrets
    } else if store_secrets {
        return Err(
            "A server for other devices does not store passwords or API keys. Those stay on each computer."
                .into(),
        );
    } else {
        false
    };
    let startup = normalize_startup(startup)?;
    let bin = find_binary().ok_or_else(missing_binary)?;
    let admin_username = admin_username.trim();
    if admin_username.is_empty() || admin_password.len() < 8 {
        return Err(
            "Create a server admin during install. This account is for the server and its settings, not a Command Center board login. Use at least 8 characters."
                .into(),
        );
    }
    run_install(
        &bin,
        root,
        role,
        store_secrets,
        port,
        startup,
        Some((admin_username, admin_password)),
    )?;
    ensure_running(&bin, root, port, startup)?;
    clear_error(root);
    Ok(format!("http://127.0.0.1:{port}"))
}

pub fn open_admin(root: &Path) -> Result<(), String> {
    let marker = read_marker(root).ok_or_else(|| "No server is installed on this computer.".to_string())?;
    let url = format!("{}/admin", marker.base_url.trim_end_matches('/'));
    open_url(&url)
}

fn open_url(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    let mut cmd = {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "start", "", url]);
        cmd
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut cmd = Command::new("open");
        cmd.arg(url);
        cmd
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(url);
        cmd
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("could not open server settings: {err}"))
}

pub fn start_installed(root: &Path) -> Result<(), String> {
    let marker = read_marker(root).ok_or_else(|| "No server is installed on this computer.".to_string())?;
    if health_ok(marker.port) {
        return Ok(());
    }
    let bin = find_binary().ok_or_else(missing_binary)?;
    ensure_running(&bin, root, marker.port, marker.startup.as_deref().unwrap_or("login"))?;
    clear_error(root);
    Ok(())
}

pub fn stop_installed(root: &Path) -> Result<(), String> {
    let marker = read_marker(root).ok_or_else(|| "No server is installed on this computer.".to_string())?;
    if let Some(bin) = find_binary() {
        let _ = Command::new(&bin).arg("--service-stop").output();
    }
    stop_pid(root);
    for _ in 0..20 {
        if !health_ok(marker.port) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    if health_ok(marker.port) {
        return Err("auth-server is still running. Stop it from the task that started it, then try again.".into());
    }
    Ok(())
}

pub fn set_store_secrets(root: &Path, store_secrets: bool) -> Result<(), String> {
    let marker = read_marker(root).ok_or_else(|| "No server is installed on this computer.".to_string())?;
    if store_secrets && marker.role != "device" {
        return Err(
            "A server for other devices does not store passwords or API keys. Those stay on each computer."
                .into(),
        );
    }
    let bin = find_binary().ok_or_else(missing_binary)?;
    let was_running = health_ok(marker.port);
    let startup = marker.startup.clone().unwrap_or_else(|| "login".into());
    if was_running {
        stop_installed(root)?;
    }
    run_install(&bin, root, &marker.role, store_secrets, marker.port, &startup, None)?;
    if was_running || store_secrets {
        ensure_running(&bin, root, marker.port, &startup)?;
    }
    clear_error(root);
    Ok(())
}

pub fn export_backup(root: &Path) -> Result<BackupDocument, String> {
    let _marker = read_marker(root).ok_or_else(|| "Install the server on this computer before exporting a backup.".to_string())?;
    let bin = find_binary().ok_or_else(missing_binary)?;
    let dir = root.join("server").join("backups");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = dir.join(format!("command-center-auth-{stamp}.json"));
    run_backup(&bin, root, &path, false)?;
    let document = fs::read_to_string(&path).map_err(|err| err.to_string())?;
    Ok(BackupDocument {
        document,
        path: path.display().to_string(),
    })
}

pub fn import_backup(root: &Path, document: &str) -> Result<(), String> {
    let marker = read_marker(root).ok_or_else(|| {
        "Install the server on this computer before importing a backup.".to_string()
    })?;
    let parsed: serde_json::Value = serde_json::from_str(document)
        .map_err(|_| "That file is not a Command Center auth-server backup.".to_string())?;
    if parsed.get("format").and_then(|v| v.as_str()) != Some("command-center-auth-backup") {
        return Err("That file is not a Command Center auth-server backup.".into());
    }
    let bin = find_binary().ok_or_else(missing_binary)?;
    let dir = root.join("server").join("backups");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let incoming = dir.join("import-incoming.json");
    fs::write(&incoming, document).map_err(|err| err.to_string())?;
    let was_running = health_ok(marker.port);
    if was_running {
        stop_installed(root)?;
    }
    let imported = run_backup(&bin, root, &incoming, true);
    if was_running {
        let _ = ensure_running(
            &bin,
            root,
            marker.port,
            marker.startup.as_deref().unwrap_or("login"),
        );
    }
    imported?;
    let _ = fs::remove_file(incoming);
    clear_error(root);
    Ok(())
}

/// Apply the Windows installer's `server-setup.json`, or adopt a server already installed here
/// when this computer does not have a URL yet.
pub fn adopt_server(paths: &ConfigPaths, state: &mut AppState) -> Result<bool, ConfigError> {
    let root = PathBuf::from(&paths.root);
    let pending_path = root.join("server-setup.json");
    let mut changed = false;
    if pending_path.is_file() {
        let raw = fs::read_to_string(&pending_path)?;
        let pending: PendingSetup = serde_json::from_str(&raw).unwrap_or(PendingSetup {
            pending: false,
            install_server: false,
            role: None,
            store_secrets: false,
            port: None,
            remote_url: None,
            allow_insecure_http: false,
            startup: None,
            admin_username: None,
            admin_password: None,
        });
        if pending.pending {
            if pending.install_server {
                match install_local(
                    &root,
                    pending.role.as_deref().unwrap_or("device"),
                    pending.store_secrets,
                    pending.port.unwrap_or(8080),
                    pending.startup.as_deref().unwrap_or("login"),
                    pending.admin_username.as_deref().unwrap_or(""),
                    pending.admin_password.as_deref().unwrap_or(""),
                ) {
                    Ok(url) => {
                        state.auth.base_url = url;
                        state.auth.allow_insecure_http = true;
                        state.auth.enabled = true;
                        changed = true;
                    }
                    Err(err) => {
                        let _ = write_error(&root, &err);
                    }
                }
            } else if let Some(url) = pending
                .remote_url
                .as_deref()
                .map(str::trim)
                .filter(|url| !url.is_empty())
            {
                state.auth.base_url = url.to_string();
                state.auth.allow_insecure_http = pending.allow_insecure_http;
                state.auth.enabled = true;
                changed = true;
            }
            let _ = fs::rename(&pending_path, root.join("server-setup.applied.json"));
        }
    }
    if state.auth.base_url.trim().is_empty() {
        if let Some(marker) = read_marker(&root) {
            state.auth.base_url = marker.base_url;
            state.auth.allow_insecure_http = true;
            state.auth.enabled = true;
            changed = true;
        }
    }
    Ok(changed)
}

pub fn sync_vault(service: &AuthService<KeyringStore>, state: &AppState) -> Result<(), AuthError> {
    let root = PathBuf::from(config::resolve_paths().map_err(config_err)?.root);
    let Some(marker) = read_marker(&root) else {
        return Ok(());
    };
    if marker.role != "device" || !marker.secret_store {
        return Ok(());
    }
    if !points_at_local(&state.auth.base_url, marker.port) {
        return Ok(());
    }
    let local = collect_source_secrets(state);
    let merged = service.sync_source_secrets(&state.auth, &local)?;
    for (name, value) in merged {
        secrets::set_secret(&name, &value).map_err(config_err)?;
    }
    Ok(())
}

pub fn collect_source_secrets(state: &AppState) -> BTreeMap<String, String> {
    let mut names = BTreeMap::<String, ()>::new();
    for source in state.sources.values() {
        for name in &source.secrets {
            if !is_session_key(name) {
                names.insert(name.clone(), ());
            }
        }
    }
    if let Ok(extra) = secrets::fallback_names() {
        for name in extra {
            if !is_session_key(&name) {
                names.insert(name, ());
            }
        }
    }
    let mut out = BTreeMap::new();
    for name in names.into_keys() {
        if let Ok(Some(value)) = secrets::get_secret(&name) {
            let value = value.trim().to_string();
            if !value.is_empty() {
                out.insert(name, value);
            }
        }
    }
    out
}

fn points_at_local(base_url: &str, port: u16) -> bool {
    let Ok(url) = url::Url::parse(base_url.trim()) else {
        return false;
    };
    let host = url.host_str().unwrap_or("");
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host == "127.0.0.1"
        || host == "::1";
    loopback && url.port().unwrap_or(80) == port
}

fn is_session_key(name: &str) -> bool {
    name.trim().to_ascii_lowercase().starts_with("auth.")
}

fn normalize_startup(startup: &str) -> Result<&'static str, String> {
    match startup.trim().to_ascii_lowercase().as_str() {
        "service" | "windows-service" => Ok("service"),
        "login" | "tray" | "taskbar" => Ok("login"),
        _ => Err(
            "Choose a Windows service, or start at login with a taskbar icon.".into(),
        ),
    }
}

fn normalize_role(role: &str) -> Result<&'static str, String> {
    match role.trim().to_ascii_lowercase().as_str() {
        "device" | "device-only" | "local" => Ok("device"),
        "shared" | "lan" | "other" => Ok("shared"),
        _ => Err("Choose this computer only, or a server for other devices.".into()),
    }
}

fn missing_binary() -> String {
    "The auth-server program is not in this install. Re-run setup and include the server, or set COMMAND_CENTER_AUTH_SERVER to the auth-server binary.".into()
}

pub fn find_binary() -> Option<PathBuf> {
    if let Ok(raw) = std::env::var("COMMAND_CENTER_AUTH_SERVER") {
        let path = PathBuf::from(raw.trim());
        if path.is_file() {
            return Some(path);
        }
    }
    let Ok(exe) = std::env::current_exe() else {
        return None;
    };
    let Some(dir) = exe.parent() else {
        return None;
    };
    for name in ["auth-server", "auth-server.exe"] {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn run_install(
    bin: &Path,
    root: &Path,
    role: &str,
    store_secrets: bool,
    port: u16,
    startup: &str,
    admin: Option<(&str, &str)>,
) -> Result<(), String> {
    let admin_file = root.join("server").join("admin-once.txt");
    if let Some((username, password)) = admin {
        fs::create_dir_all(admin_file.parent().unwrap()).map_err(|err| err.to_string())?;
        fs::write(&admin_file, format!("{username}\n{password}")).map_err(|err| err.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&admin_file, fs::Permissions::from_mode(0o600));
        }
    }
    let mut cmd = Command::new(bin);
    cmd.arg("--install")
        .arg("--home")
        .arg(root)
        .arg("--role")
        .arg(role)
        .arg("--port")
        .arg(port.to_string())
        .arg("--startup")
        .arg(startup)
        .arg("--autostart");
    if store_secrets {
        cmd.arg("--secret-store");
    }
    if admin.is_some() {
        cmd.arg("--admin-file").arg(&admin_file);
    }
    let output = cmd.output().map_err(|err| format!("could not run auth-server: {err}"))?;
    if admin.is_some() {
        let _ = fs::write(&admin_file, "");
        let _ = fs::remove_file(&admin_file);
    }
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = detail.trim();
        if detail.is_empty() {
            Err("auth-server --install failed.".into())
        } else {
            Err(detail.to_string())
        }
    }
}

fn run_backup(bin: &Path, root: &Path, file: &Path, import: bool) -> Result<(), String> {
    let mut cmd = Command::new(bin);
    if import {
        cmd.arg("--backup-import").arg("--yes");
    } else {
        cmd.arg("--backup-export");
    }
    cmd.arg("--file")
        .arg(file)
        .arg("--home")
        .arg(root);
    let output = cmd.output().map_err(|err| format!("could not run auth-server: {err}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = detail.trim();
        Err(if detail.is_empty() {
            "backup failed.".into()
        } else {
            detail.to_string()
        })
    }
}

fn ensure_running(bin: &Path, root: &Path, port: u16, startup: &str) -> Result<(), String> {
    if health_ok(port) {
        return Ok(());
    }
    if startup == "service" {
        let output = Command::new(bin)
            .arg("--service-start")
            .output()
            .map_err(|err| format!("could not start the Windows service: {err}"))?;
        for _ in 0..40 {
            if health_ok(port) {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(150));
        }
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(if detail.trim().is_empty() {
            format!("The Windows service did not answer on http://127.0.0.1:{port}/health.")
        } else {
            detail.trim().to_string()
        });
    }
    let server_dir = root.join("server");
    fs::create_dir_all(&server_dir).map_err(|err| err.to_string())?;
    let log_path = server_dir.join("auth-server.log");
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|err| format!("could not open {}: {err}", log_path.display()))?;
    let err_log = log.try_clone().map_err(|err| err.to_string())?;
    let mut cmd = Command::new(bin);
    cmd.arg("--tray")
        .arg("--home")
        .arg(root)
        .current_dir(&server_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err_log));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    let mut child = cmd
        .spawn()
        .map_err(|err| format!("could not start auth-server: {err}"))?;
    thread::spawn(move || {
        let _ = child.wait();
    });
    for _ in 0..40 {
        if health_ok(port) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(150));
    }
    Err(format!(
        "auth-server did not answer on http://127.0.0.1:{port}/health. See {}.",
        log_path.display()
    ))
}

fn stop_pid(root: &Path) {
    let pid_path = root.join("server").join("auth-server.pid");
    let Ok(raw) = fs::read_to_string(&pid_path) else {
        return;
    };
    let Ok(pid) = raw.trim().parse::<u32>() else {
        return;
    };
    if pid == 0 {
        return;
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill").args(["-TERM", &pid.to_string()]).status();
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .status();
    }
}

fn health_ok(port: u16) -> bool {
    let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(700))
        .build()
    else {
        return false;
    };
    let url = format!("http://127.0.0.1:{port}/health");
    let Ok(response) = client.get(url).send() else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    let Ok(body) = response.json::<serde_json::Value>() else {
        return false;
    };
    body.get("ok").and_then(|value| value.as_bool()) == Some(true)
}

fn read_marker(root: &Path) -> Option<InstallMarker> {
    let raw = fs::read_to_string(root.join("server").join("install.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

fn read_error(root: &Path) -> Option<String> {
    let text = fs::read_to_string(root.join("server").join("last-error.txt")).ok()?;
    let text = text.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn write_error(root: &Path, message: &str) -> Result<(), ConfigError> {
    let dir = root.join("server");
    fs::create_dir_all(&dir)?;
    let mut file = fs::File::create(dir.join("last-error.txt"))?;
    writeln!(file, "{message}")?;
    Ok(())
}

fn clear_error(root: &Path) {
    let _ = fs::remove_file(root.join("server").join("last-error.txt"));
}

fn lan_hint() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("1.1.1.1:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    if ip.is_loopback() || ip.is_unspecified() {
        None
    } else {
        Some(ip.to_string())
    }
}

fn config_err(err: ConfigError) -> AuthError {
    AuthError::Message(err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{self, ENV_HOME_OVERRIDE};

    #[test]
    fn pending_remote_url_is_applied_and_a_missing_binary_is_recorded() {
        let _guard = crate::config::TEST_ENV_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("cc-server-{}", uuid::Uuid::new_v4()));
        std::env::set_var(ENV_HOME_OVERRIDE, &dir);
        std::env::remove_var("COMMAND_CENTER_AUTH_SERVER");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("server-setup.json"),
            r#"{"pending":true,"installServer":false,"remoteUrl":"http://10.1.2.3:8080","allowInsecureHttp":false}"#,
        )
        .unwrap();
        let loaded = config::load_or_create().unwrap();
        assert_eq!(loaded.state.auth.base_url, "http://10.1.2.3:8080");
        assert!(!dir.join("server-setup.json").exists());

        fs::write(
            dir.join("server-setup.json"),
            r#"{"pending":true,"installServer":true,"role":"device","storeSecrets":true,"port":8080}"#,
        )
        .unwrap();
        // The URL is already set, but pending install still runs and should fail closed
        // without a binary. Clear the URL first so a success would be visible.
        let mut state = loaded.state;
        state.auth.base_url.clear();
        let paths = config::resolve_paths().unwrap();
        config::save_state(&paths, &state).unwrap();
        let loaded = config::load_or_create().unwrap();
        assert!(loaded.state.auth.base_url.is_empty());
        let err = fs::read_to_string(dir.join("server").join("last-error.txt")).unwrap();
        assert!(err.contains("not in this install"), "{err}");
        std::env::remove_var(ENV_HOME_OVERRIDE);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn session_keys_are_not_source_secrets() {
        assert!(is_session_key("auth.access_token"));
        assert!(is_session_key("auth.refresh_token"));
        assert!(!is_session_key("broadcastify.password"));
        assert_eq!(normalize_role("device-only").unwrap(), "device");
        assert_eq!(normalize_role("shared").unwrap(), "shared");
        assert!(normalize_role("cloud").is_err());
        assert_eq!(normalize_startup("service").unwrap(), "service");
        assert_eq!(normalize_startup("taskbar").unwrap(), "login");
        assert!(normalize_startup("manual").is_err());
    }
}
