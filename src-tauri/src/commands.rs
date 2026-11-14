use crate::auth::{self, AuthError, AuthProbe, AuthService, AuthSession};
use crate::local_server::{self, BackupDocument, LocalServerChange, LocalServerStatus};
use crate::config::{
    self, AppState, AuthSettings, ConfigPaths, GridItem, LoadResult, SourceConfig,
};
use crate::secrets;
use crate::sources::{self, SourcePayload};
use crate::sync;
use crate::updates::{self, ApplyResult, UpdateReport};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{mpsc, OnceLock};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub message: String,
}

impl From<config::ConfigError> for CommandError {
    fn from(value: config::ConfigError) -> Self {
        Self {
            message: value.to_string(),
        }
    }
}

impl From<sources::SourceError> for CommandError {
    fn from(value: sources::SourceError) -> Self {
        Self {
            message: value.to_string(),
        }
    }
}

impl From<auth::AuthError> for CommandError {
    fn from(value: auth::AuthError) -> Self {
        Self {
            message: value.to_string(),
        }
    }
}

impl From<String> for CommandError {
    fn from(message: String) -> Self {
        Self { message }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveLayoutArgs {
    pub board_id: String,
    pub items: Vec<GridItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertSourceArgs {
    pub id: String,
    pub source: SourceConfig,
    #[serde(default)]
    pub secrets: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreSecretsArgs {
    pub secrets: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchSourceArgs {
    pub source_id: String,
    /// Optional runtime overrides (e.g. archiveDay for Broadcastify).
    #[serde(default)]
    pub overrides: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeAudioArgs {
    pub source_url: String,
    pub clip_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionSegment {
    pub id: String,
    pub start_sec: f64,
    pub end_sec: f64,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionResult {
    pub engine: String,
    pub status: String,
    pub source_url: String,
    pub segments: Vec<CaptionSegment>,
    pub note: String,
    pub generated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddPanelArgs {
    pub board_id: String,
    pub panel: config::Panel,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult {
    pub ok: bool,
    pub missing: Vec<String>,
    pub message: String,
}

#[tauri::command]
pub fn get_config_paths() -> Result<ConfigPaths, CommandError> {
    Ok(config::resolve_paths()?)
}

#[tauri::command]
pub fn load_app_state() -> Result<LoadResult, CommandError> {
    Ok(config::load_or_create()?)
}

#[tauri::command]
pub fn save_app_state(state: AppState) -> Result<ConfigPaths, CommandError> {
    let paths = config::resolve_paths()?;
    config::save_state(&paths, &state)?;
    publish_settings(&state);
    Ok(paths)
}

#[tauri::command]
pub fn save_board_layout(args: SaveLayoutArgs) -> Result<(), CommandError> {
    let paths = config::resolve_paths()?;
    let mut loaded = config::load_or_create()?;
    if let Some(board) = loaded
        .state
        .boards
        .iter_mut()
        .find(|b| b.id == args.board_id)
    {
        for item in &args.items {
            if let Some(panel) = board.panels.iter_mut().find(|p| p.id == item.i) {
                panel.layout = item.clone();
            }
        }
    }
    config::write_layout(&paths, &args.board_id, &args.items)?;
    config::save_state(&paths, &loaded.state)?;
    publish_settings(&loaded.state);
    Ok(())
}

#[tauri::command]
pub fn upsert_source(args: UpsertSourceArgs) -> Result<AppState, CommandError> {
    if !args.secrets.is_empty() {
        secrets::set_secrets(&args.secrets)?;
    }
    let mut loaded = config::load_or_create()?;
    loaded.state.sources.insert(args.id, args.source);
    let paths = config::resolve_paths()?;
    config::save_state(&paths, &loaded.state)?;
    if !args.secrets.is_empty() {
        let _ = local_server::sync_vault(&auth_service(), &loaded.state);
    }
    publish_settings(&loaded.state);
    Ok(loaded.state)
}

#[tauri::command]
pub fn store_secrets(args: StoreSecretsArgs) -> Result<(), CommandError> {
    secrets::set_secrets(&args.secrets)?;
    if let Ok(loaded) = config::load_or_create() {
        let _ = local_server::sync_vault(&auth_service(), &loaded.state);
    }
    Ok(())
}

#[tauri::command]
pub fn fetch_source_payload(args: FetchSourceArgs) -> Result<SourcePayload, CommandError> {
    let loaded = config::load_or_create()?;
    let source = loaded
        .state
        .sources
        .get(&args.source_id)
        .ok_or_else(|| CommandError {
            message: format!("source not found: {}", args.source_id),
        })?;
    if source.draft || !source.enabled {
        return Err(CommandError {
            message: "source is draft or disabled".into(),
        });
    }
    Ok(sources::fetch_source(
        &args.source_id,
        source,
        &args.overrides,
    )?)
}

#[tauri::command]
pub fn add_panel_to_board(args: AddPanelArgs) -> Result<AppState, CommandError> {
    let mut loaded = config::load_or_create()?;
    let board = loaded
        .state
        .boards
        .iter_mut()
        .find(|b| b.id == args.board_id)
        .ok_or_else(|| CommandError {
            message: format!("board not found: {}", args.board_id),
        })?;

    if board.panels.iter().any(|p| p.id == args.panel.id) {
        return Err(CommandError {
            message: format!("panel already exists: {}", args.panel.id),
        });
    }

    let rotation_ids = args
        .panel
        .rotation
        .as_ref()
        .filter(|r| r.enabled)
        .map(|r| r.source_ids.clone())
        .unwrap_or_default();

    let mut required_ids: Vec<String> = vec![args.panel.source.clone()];
    for id in &rotation_ids {
        if !required_ids.iter().any(|x| x == id) {
            required_ids.push(id.clone());
        }
    }

    if let Some(rot) = args.panel.rotation.as_ref().filter(|r| r.enabled) {
        if rot.source_ids.len() < 2 {
            return Err(CommandError {
                message: "rotating panel needs at least two configured sources".into(),
            });
        }
        if rot.interval_sec < 5 || rot.interval_sec > 3600 {
            return Err(CommandError {
                message: "rotation interval must be between 5 and 3600 seconds".into(),
            });
        }
    }

    for source_id in &required_ids {
        if !loaded.state.sources.contains_key(source_id) {
            return Err(CommandError {
                message: format!(
                    "source {source_id} must exist and be valid before adding to board"
                ),
            });
        }
        let source = &loaded.state.sources[source_id];
        if source.draft {
            return Err(CommandError {
                message: format!(
                    "source {source_id} is still a draft; finish required fields first"
                ),
            });
        }
        if !source.enabled {
            return Err(CommandError {
                message: format!("source {source_id} is disabled"),
            });
        }
    }

    board.panels.push(args.panel);
    let paths = config::resolve_paths()?;
    config::save_state(&paths, &loaded.state)?;
    publish_settings(&loaded.state);
    Ok(loaded.state)
}

#[tauri::command]
pub fn create_board(title: String) -> Result<AppState, CommandError> {
    let mut loaded = config::load_or_create()?;
    let id = slugify(&title);
    if loaded.state.boards.iter().any(|b| b.id == id) {
        return Err(CommandError {
            message: format!("board id already exists: {id}"),
        });
    }
    loaded.state.boards.push(config::Board {
        id: id.clone(),
        title,
        panels: vec![],
    });
    loaded.state.active_board_id = id;
    let paths = config::resolve_paths()?;
    config::save_state(&paths, &loaded.state)?;
    publish_settings(&loaded.state);
    Ok(loaded.state)
}

#[tauri::command]
pub fn set_active_board(board_id: String) -> Result<AppState, CommandError> {
    let mut loaded = config::load_or_create()?;
    if !loaded.state.boards.iter().any(|b| b.id == board_id) {
        return Err(CommandError {
            message: format!("board not found: {board_id}"),
        });
    }
    loaded.state.active_board_id = board_id;
    let paths = config::resolve_paths()?;
    config::save_state(&paths, &loaded.state)?;
    publish_settings(&loaded.state);
    Ok(loaded.state)
}

#[tauri::command]
pub fn set_edit_mode(enabled: bool) -> Result<AppState, CommandError> {
    let mut loaded = config::load_or_create()?;
    loaded.state.edit_mode = enabled;
    let paths = config::resolve_paths()?;
    config::save_state(&paths, &loaded.state)?;
    Ok(loaded.state)
}

/// Local / on-device captioning stub for Broadcastify archive audio (personal use).
///
/// Prefer keeping clips on-device — do not upload to cloud ASR. Full whisper.cpp
/// (or similar) sidecar is not bundled yet; this returns structured stub segments
/// so the panel UI can ship before the model path lands.
#[tauri::command]
pub fn transcribe_audio_local(args: TranscribeAudioArgs) -> Result<CaptionResult, CommandError> {
    let url = args.source_url.trim();
    if url.is_empty() {
        return Err(CommandError {
            message: "sourceUrl required for local transcription".into(),
        });
    }
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("file://")) {
        return Err(CommandError {
            message: "sourceUrl must be http(s) or file:// for local transcription".into(),
        });
    }

    let clip = if args.clip_id.trim().is_empty() {
        "clip".to_string()
    } else {
        args.clip_id.trim().to_string()
    };
    let seed = clip.len() + url.len();
    let lines = [
        "Dispatch, unit responding.",
        "Traffic holding on the main.",
        "Copy, standing by.",
        "Clear the last.",
    ];
    let segments = lines
        .iter()
        .enumerate()
        .map(|(i, text)| {
            let start = (i * 8 + seed % 3) as f64;
            CaptionSegment {
                id: format!("{clip}-seg-{i}"),
                start_sec: start,
                end_sec: start + 7.0,
                text: (*text).to_string(),
            }
        })
        .collect();

    Ok(CaptionResult {
        engine: "local-stub".into(),
        status: "stub".into(),
        source_url: url.to_string(),
        segments,
        note: "Offline stub captions (personal use). On-device Whisper/local ASR not bundled yet — audio stays local; no cloud upload.".into(),
        generated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    })
}

/// Stub validation against a simple required-fields map from the UI.
#[tauri::command]
pub fn validate_source_fields(
    required: Vec<String>,
    params: BTreeMap<String, serde_json::Value>,
    secrets: BTreeMap<String, String>,
) -> ValidationResult {
    let mut missing = Vec::new();
    for key in &required {
        if key.starts_with("secret:") {
            let name = key.trim_start_matches("secret:");
            if secrets
                .get(name)
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
            {
                missing.push(key.clone());
            }
        } else {
            let empty = match params.get(key) {
                None => true,
                Some(serde_json::Value::Null) => true,
                Some(serde_json::Value::String(s)) => s.trim().is_empty(),
                Some(serde_json::Value::Number(n)) => n.as_f64().is_none(),
                Some(_) => false,
            };
            if empty {
                missing.push(key.clone());
            }
        }
    }

    if missing.is_empty() {
        ValidationResult {
            ok: true,
            missing,
            message: "ok".into(),
        }
    } else {
        ValidationResult {
            ok: false,
            missing: missing.clone(),
            message: format!("missing required fields: {}", missing.join(", ")),
        }
    }
}

fn auth_service() -> AuthService<auth::KeyringStore> {
    AuthService::keyring()
}

/// Best-effort upload after a local board or source save. A down server leaves
/// the saved file in place. Edit mode and auth settings are not published.
///
/// The upload runs after the command returns. Layout drags and Settings saves
/// should not sit on the auth-server connect timeout (the default host is a
/// tailnet address). Queued saves collapse to the newest board.
fn publish_settings(state: &AppState) {
    if !state.auth.enabled {
        return;
    }
    let _ = publish_sender().send(state.clone());
}

fn publish_sender() -> mpsc::Sender<AppState> {
    static TX: OnceLock<mpsc::Sender<AppState>> = OnceLock::new();
    TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<AppState>();
        std::thread::spawn(move || {
            while let Ok(mut latest) = rx.recv() {
                while let Ok(newer) = rx.try_recv() {
                    latest = newer;
                }
                publish_settings_now(&latest);
            }
        });
        tx
    })
    .clone()
}

fn publish_settings_now(state: &AppState) {
    if !state.auth.enabled {
        return;
    }
    let secrets = sync::secret_values(state);
    let Ok(paths) = config::resolve_paths() else {
        return;
    };
    let cursor = sync::read_cursor(&paths.root);
    match sync::publish(&auth_service(), state, &secrets, cursor) {
        Ok(work) => {
            if let Some(cursor) = work.cursor {
                if let Err(err) = sync::write_cursor(&paths.root, &cursor) {
                    eprintln!("command-center settings sync: {err}");
                }
            }
        }
        Err(err) if quiet_sync(&err) => {}
        Err(err) => eprintln!("command-center settings sync: {err}"),
    }
}

fn quiet_sync(err: &AuthError) -> bool {
    if err.is_unreachable() {
        return true;
    }
    match err {
        AuthError::Message(message) if message.contains("Sign in before") => true,
        AuthError::Api { status: 401, .. } => true,
        _ => false,
    }
}

#[tauri::command]
pub fn sync_board() -> Result<sync::SyncOutcome, CommandError> {
    let loaded = config::load_or_create()?;
    if !loaded.state.auth.enabled {
        return Ok(sync::SyncOutcome {
            state: loaded.state,
            restored: false,
            published: false,
            message: None,
        });
    }
    let secrets = sync::secret_values(&loaded.state);
    let paths = config::resolve_paths()?;
    let cursor = sync::read_cursor(&paths.root);
    match sync::reconcile(&auth_service(), &loaded.state, &secrets, cursor) {
        Ok(work) => {
            if work.restored {
                config::save_state(&paths, &work.state)?;
            }
            if let Some(cursor) = &work.cursor {
                let _ = sync::write_cursor(&paths.root, cursor);
            }
            let message = work.restored.then(|| {
                "Restored your boards and sources from this account.".to_string()
            });
            Ok(sync::SyncOutcome {
                state: work.state,
                restored: work.restored,
                published: work.published,
                message,
            })
        }
        Err(err) if quiet_sync(&err) => Ok(sync::SyncOutcome {
            state: loaded.state,
            restored: false,
            published: false,
            message: None,
        }),
        Err(err) => Ok(sync::SyncOutcome {
            state: loaded.state,
            restored: false,
            published: false,
            message: Some(err.to_string()),
        }),
    }
}

#[tauri::command]
pub fn auth_session() -> Result<AuthSession, CommandError> {
    let loaded = config::load_or_create()?;
    Ok(auth_service().session(&loaded.state.auth))
}

#[tauri::command]
pub fn auth_probe() -> Result<AuthProbe, CommandError> {
    let loaded = config::load_or_create()?;
    Ok(auth_service().probe(&loaded.state.auth))
}

#[tauri::command]
pub fn auth_save_settings(settings: AuthSettings) -> Result<AppState, CommandError> {
    let mut loaded = config::load_or_create()?;
    let normalized = auth_service().prepare_settings(&loaded.state.auth, settings)?;
    loaded.state.auth = normalized;
    let paths = config::resolve_paths()?;
    config::save_state(&paths, &loaded.state)?;
    Ok(loaded.state)
}

#[tauri::command]
pub fn auth_register(username: String, password: String) -> Result<AuthSession, CommandError> {
    let loaded = config::load_or_create()?;
    let session = auth_service().register(&loaded.state.auth, &username, &password)?;
    if session.signed_in {
        let _ = local_server::sync_vault(&auth_service(), &loaded.state);
    }
    Ok(session)
}

#[tauri::command]
pub fn auth_login(username: String, password: String) -> Result<AuthSession, CommandError> {
    let loaded = config::load_or_create()?;
    let session = auth_service().login(&loaded.state.auth, &username, &password)?;
    if session.signed_in {
        let _ = local_server::sync_vault(&auth_service(), &loaded.state);
    }
    Ok(session)
}

#[tauri::command]
pub fn local_server_status() -> Result<LocalServerStatus, CommandError> {
    let paths = config::resolve_paths()?;
    Ok(local_server::status(std::path::Path::new(&paths.root)))
}

#[tauri::command]
pub fn local_server_install(
    role: String,
    store_secrets: bool,
    port: u16,
    startup: String,
    admin_username: String,
    admin_password: String,
) -> Result<LocalServerChange, CommandError> {
    let paths = config::resolve_paths()?;
    let root = std::path::PathBuf::from(&paths.root);
    let url = local_server::install_local(
        &root,
        &role,
        store_secrets,
        port,
        &startup,
        &admin_username,
        &admin_password,
    )?;
    let mut loaded = config::load_or_create()?;
    loaded.state.auth.base_url = url;
    loaded.state.auth.allow_insecure_http = true;
    loaded.state.auth.enabled = true;
    config::save_state(&paths, &loaded.state)?;
    if store_secrets {
        let _ = local_server::sync_vault(&auth_service(), &loaded.state);
    }
    Ok(LocalServerChange {
        status: local_server::status(&root),
        state: loaded.state,
    })
}

#[tauri::command]
pub fn local_server_open_admin() -> Result<(), CommandError> {
    let paths = config::resolve_paths()?;
    local_server::open_admin(std::path::Path::new(&paths.root))?;
    Ok(())
}

#[tauri::command]
pub fn local_server_start() -> Result<LocalServerStatus, CommandError> {
    let paths = config::resolve_paths()?;
    let root = std::path::PathBuf::from(&paths.root);
    local_server::start_installed(&root)?;
    Ok(local_server::status(&root))
}

#[tauri::command]
pub fn local_server_stop() -> Result<LocalServerStatus, CommandError> {
    let paths = config::resolve_paths()?;
    let root = std::path::PathBuf::from(&paths.root);
    local_server::stop_installed(&root)?;
    Ok(local_server::status(&root))
}

#[tauri::command]
pub fn local_server_set_secrets(store_secrets: bool) -> Result<LocalServerChange, CommandError> {
    let paths = config::resolve_paths()?;
    let root = std::path::PathBuf::from(&paths.root);
    local_server::set_store_secrets(&root, store_secrets)?;
    let loaded = config::load_or_create()?;
    if store_secrets {
        let _ = local_server::sync_vault(&auth_service(), &loaded.state);
    }
    Ok(LocalServerChange {
        status: local_server::status(&root),
        state: loaded.state,
    })
}

#[tauri::command]
pub fn local_server_export_backup() -> Result<BackupDocument, CommandError> {
    let paths = config::resolve_paths()?;
    Ok(local_server::export_backup(std::path::Path::new(&paths.root))?)
}

#[tauri::command]
pub fn local_server_import_backup(document: String) -> Result<LocalServerStatus, CommandError> {
    let paths = config::resolve_paths()?;
    let root = std::path::PathBuf::from(&paths.root);
    local_server::import_backup(&root, &document)?;
    Ok(local_server::status(&root))
}

#[tauri::command]
pub fn check_updates(force: bool) -> Result<UpdateReport, CommandError> {
    let loaded = config::load_or_create()?;
    let root = std::path::PathBuf::from(&loaded.paths.root);
    Ok(updates::check(&root, &loaded.state.auth.base_url, force)?)
}

#[tauri::command]
pub fn apply_update(product: String) -> Result<ApplyResult, CommandError> {
    let loaded = config::load_or_create()?;
    let root = std::path::PathBuf::from(&loaded.paths.root);
    Ok(updates::apply(
        &root,
        &loaded.state.auth.base_url,
        &product,
    )?)
}

#[tauri::command]
pub fn auth_logout() -> Result<AuthSession, CommandError> {
    let loaded = config::load_or_create()?;
    Ok(auth_service().logout(&loaded.state.auth)?)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayWorkArea {
    pub width: u32,
    pub height: u32,
}

fn clamp_display(value: u32, min: u32, max: u32) -> u32 {
    value.clamp(min, max)
}

/// Resize the main window. Used by Settings → Display. Logical pixels.
#[tauri::command]
pub fn set_display_size(
    window: tauri::WebviewWindow,
    width: u32,
    height: u32,
) -> Result<(), CommandError> {
    let width = clamp_display(width, 960, 7680);
    let height = clamp_display(height, 640, 4320);
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|err| CommandError {
            message: err.to_string(),
        })?;
    }
    window
        .set_size(tauri::LogicalSize::new(f64::from(width), f64::from(height)))
        .map_err(|err| CommandError {
            message: err.to_string(),
        })?;
    let _ = window.center();
    Ok(())
}

/// Work area of the monitor the window is on, in logical pixels.
#[tauri::command]
pub fn display_work_area(window: tauri::WebviewWindow) -> Result<DisplayWorkArea, CommandError> {
    let monitor = window
        .current_monitor()
        .map_err(|err| CommandError {
            message: err.to_string(),
        })?
        .ok_or_else(|| CommandError {
            message: "No display found for this window.".into(),
        })?;
    let scale = monitor.scale_factor().max(0.5);
    let size = monitor.work_area().size;
    Ok(DisplayWorkArea {
        width: clamp_display((f64::from(size.width) / scale).floor() as u32, 960, 7680),
        height: clamp_display((f64::from(size.height) / scale).floor() as u32, 640, 4320),
    })
}

fn slugify(input: &str) -> String {
    let mut out = String::new();
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if ch == ' ' || ch == '-' || ch == '_' {
            if !out.ends_with('-') {
                out.push('-');
            }
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        format!("board-{}", &uuid::Uuid::new_v4().to_string()[..8])
    } else {
        trimmed
    }
}
