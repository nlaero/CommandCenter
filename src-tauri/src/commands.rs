use crate::ai_sync::{self, AiMemory, AiSyncOutcome};
use crate::auth::{self, AuthError, AuthProbe, AuthService, AuthSession};
use crate::config::{
    self, AppState, AuthSettings, ConfigPaths, GridItem, LoadResult, SourceConfig,
};
use crate::local_ai::{self, LocalAiStatus};
use crate::local_server::{self, BackupDocument, LocalServerChange, LocalServerStatus};
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
pub async fn fetch_media_url(
    url: String,
    range: Option<String>,
) -> Result<tauri::ipc::Response, CommandError> {
    let body = tauri::async_runtime::spawn_blocking(move || {
        crate::media::fetch_media(&url, range.as_deref())
    })
    .await
    .map_err(|_| CommandError {
        message: "Couldn't reach that stream.".into(),
    })?
    .map_err(|message| CommandError { message })?;
    Ok(tauri::ipc::Response::new(body))
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeMediaArgs {
    pub source_url: String,
    pub clip_id: String,
    #[serde(default)]
    pub timeline_start: f64,
    #[serde(default)]
    pub seek_sec: f64,
    #[serde(default)]
    pub duration_sec: f64,
}

/// Transcribe on this computer. Uses the installed model when Settings has one.
/// Otherwise returns a short placeholder so the caption UI still has something to show.
#[tauri::command]
pub fn transcribe_audio_local(args: TranscribeAudioArgs) -> Result<CaptionResult, CommandError> {
    let url = args.source_url.trim();
    if url.is_empty() {
        return Err(CommandError {
            message: "sourceUrl required for local transcription".into(),
        });
    }
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("file:")) {
        return Err(CommandError {
            message: "sourceUrl must be http(s) or file:// for local transcription".into(),
        });
    }
    let paths = config::resolve_paths()?;
    let clip = if args.clip_id.trim().is_empty() {
        "clip".to_string()
    } else {
        args.clip_id.trim().to_string()
    };
    match local_ai::transcribe(std::path::Path::new(&paths.root), url) {
        Ok((segments, note)) => Ok(CaptionResult {
            engine: "local-whisper".into(),
            status: "ready".into(),
            source_url: url.to_string(),
            segments: segments
                .into_iter()
                .enumerate()
                .map(|(index, segment)| CaptionSegment {
                    id: format!("{clip}-seg-{index}"),
                    start_sec: segment.start_sec,
                    end_sec: segment.end_sec,
                    text: segment.text,
                })
                .collect(),
            note,
            generated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        }),
        Err(local_ai::TranscribeError::NotInstalled) => Ok(stub_captions(url, &clip)),
        Err(local_ai::TranscribeError::Message(message)) => Err(CommandError { message }),
    }
}

/// Transcribe a short camera or file slice on this computer.
/// YouTube URLs are rejected. A missing model does not invent caption text.
#[tauri::command]
pub fn transcribe_media_local(args: TranscribeMediaArgs) -> Result<CaptionResult, CommandError> {
    let url = args.source_url.trim();
    if url.is_empty() {
        return Err(CommandError {
            message: "sourceUrl required for local transcription".into(),
        });
    }
    if local_ai::caption_download_blocked(url) {
        return Err(CommandError {
            message: "YouTube audio is not downloaded. This panel uses YouTube's captions.".into(),
        });
    }
    let paths = config::resolve_paths()?;
    let clip = if args.clip_id.trim().is_empty() {
        "clip".to_string()
    } else {
        args.clip_id.trim().to_string()
    };
    match local_ai::transcribe_media(
        std::path::Path::new(&paths.root),
        local_ai::MediaTranscriptRequest {
            source_url: url,
            timeline_start: args.timeline_start,
            seek_sec: args.seek_sec,
            duration_sec: args.duration_sec,
        },
    ) {
        Ok((segments, note)) => Ok(caption_result(
            url,
            &clip,
            "ready",
            &note,
            segments_from(segments, &clip),
        )),
        Err(local_ai::TranscribeError::NotInstalled) => Ok(needs_model_captions(url, &clip)),
        Err(local_ai::TranscribeError::Message(message)) => Err(CommandError { message }),
    }
}

fn segments_from(segments: Vec<local_ai::TranscriptSegment>, clip: &str) -> Vec<CaptionSegment> {
    segments
        .into_iter()
        .enumerate()
        .map(|(index, segment)| CaptionSegment {
            id: format!("{clip}-seg-{index}"),
            start_sec: segment.start_sec,
            end_sec: segment.end_sec,
            text: segment.text,
        })
        .collect()
}

fn caption_result(
    url: &str,
    _clip: &str,
    status: &str,
    note: &str,
    segments: Vec<CaptionSegment>,
) -> CaptionResult {
    CaptionResult {
        engine: "local-whisper".into(),
        status: status.into(),
        source_url: url.to_string(),
        segments,
        note: note.to_string(),
        generated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    }
}

fn needs_model_captions(url: &str, _clip: &str) -> CaptionResult {
    CaptionResult {
        engine: "local-whisper".into(),
        status: "needs-model".into(),
        source_url: url.to_string(),
        segments: Vec::new(),
        note: "Local AI is not installed. Settings → Local AI downloads Tiny English onto this computer. Audio stays here.".into(),
        generated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    }
}

fn stub_captions(url: &str, clip: &str) -> CaptionResult {
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
    CaptionResult {
        engine: "local-stub".into(),
        status: "stub".into(),
        source_url: url.to_string(),
        segments,
        note: "Local AI is not installed. Settings → Local AI downloads Tiny English onto this computer. Audio stays here.".into(),
        generated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    }
}

#[tauri::command]
pub fn local_ai_status() -> Result<LocalAiStatus, CommandError> {
    let paths = config::resolve_paths()?;
    Ok(local_ai::status(std::path::Path::new(&paths.root)))
}

#[tauri::command]
pub fn local_ai_install() -> Result<LocalAiStatus, CommandError> {
    let paths = config::resolve_paths()?;
    local_ai::install(std::path::Path::new(&paths.root)).map_err(|message| CommandError { message })
}

#[tauri::command]
pub fn local_ai_remove() -> Result<LocalAiStatus, CommandError> {
    let paths = config::resolve_paths()?;
    local_ai::remove(std::path::Path::new(&paths.root)).map_err(|message| CommandError { message })
}

#[tauri::command]
pub fn sync_ai_memory() -> Result<AiSyncOutcome, CommandError> {
    let loaded = config::load_or_create()?;
    let paths = config::resolve_paths()?;
    ai_memory_call(&loaded.state, std::path::Path::new(&paths.root), None)
}

#[tauri::command]
pub fn save_ai_memory(memory: AiMemory) -> Result<AiSyncOutcome, CommandError> {
    let loaded = config::load_or_create()?;
    let paths = config::resolve_paths()?;
    ai_memory_call(
        &loaded.state,
        std::path::Path::new(&paths.root),
        Some(memory),
    )
}

fn ai_memory_call(
    state: &config::AppState,
    root: &std::path::Path,
    memory: Option<AiMemory>,
) -> Result<AiSyncOutcome, CommandError> {
    let service = auth_service();
    let result = if let Some(memory) = memory {
        ai_sync::save(&service, state, root, &memory)
    } else {
        ai_sync::reconcile(&service, state, root)
    };
    match result {
        Ok(outcome) => Ok(outcome),
        Err(err) if quiet_ai(&err) => Ok(AiSyncOutcome {
            memory: ai_sync::load(root),
            revision: None,
            server: state.auth.base_url.clone(),
            published: false,
            restored: false,
            message: None,
        }),
        Err(err) => Err(CommandError {
            message: err.to_string(),
        }),
    }
}

fn quiet_ai(err: &AuthError) -> bool {
    err.is_unreachable()
        || matches!(
            err,
            AuthError::Message(message) if message.contains("Sign in before")
        )
        || matches!(err, AuthError::Api { status: 401, .. })
}

/// GPS, network location, another device location service, or a typed address.
/// Returns only after coordinates are in range — that is the confirmation.
#[tauri::command]
pub fn resolve_location(
    request: crate::location::LocationRequest,
) -> Result<crate::location::LocationLookup, CommandError> {
    crate::location::resolve(request).map_err(|message| CommandError { message })
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
                Some(value) => crate::location::value_missing(value),
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

fn require_auth_feature() -> Result<(), CommandError> {
    if config::AUTH_IN_APP {
        Ok(())
    } else {
        Err(CommandError {
            message: "Sign-in and the auth server are not part of this build.".into(),
        })
    }
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
            let message = work
                .restored
                .then(|| "Restored your boards and sources from this account.".to_string());
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
    require_auth_feature()?;
    let loaded = config::load_or_create()?;
    Ok(auth_service().session(&loaded.state.auth))
}

#[tauri::command]
pub fn auth_probe() -> Result<AuthProbe, CommandError> {
    require_auth_feature()?;
    let loaded = config::load_or_create()?;
    Ok(auth_service().probe(&loaded.state.auth))
}

#[tauri::command]
pub fn auth_save_settings(settings: AuthSettings) -> Result<AppState, CommandError> {
    require_auth_feature()?;
    let mut loaded = config::load_or_create()?;
    let normalized = auth_service().prepare_settings(&loaded.state.auth, settings)?;
    loaded.state.auth = normalized;
    let paths = config::resolve_paths()?;
    config::save_state(&paths, &loaded.state)?;
    Ok(loaded.state)
}

#[tauri::command]
pub fn auth_register(username: String, password: String) -> Result<AuthSession, CommandError> {
    require_auth_feature()?;
    let loaded = config::load_or_create()?;
    let session = auth_service().register(&loaded.state.auth, &username, &password)?;
    if session.signed_in {
        let _ = local_server::sync_vault(&auth_service(), &loaded.state);
    }
    Ok(session)
}

#[tauri::command]
pub fn auth_login(username: String, password: String) -> Result<AuthSession, CommandError> {
    require_auth_feature()?;
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
    require_auth_feature()?;
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
    require_auth_feature()?;
    let paths = config::resolve_paths()?;
    local_server::open_admin(std::path::Path::new(&paths.root))?;
    Ok(())
}

#[tauri::command]
pub fn local_server_start() -> Result<LocalServerStatus, CommandError> {
    require_auth_feature()?;
    let paths = config::resolve_paths()?;
    let root = std::path::PathBuf::from(&paths.root);
    local_server::start_installed(&root)?;
    Ok(local_server::status(&root))
}

#[tauri::command]
pub fn local_server_stop() -> Result<LocalServerStatus, CommandError> {
    require_auth_feature()?;
    let paths = config::resolve_paths()?;
    let root = std::path::PathBuf::from(&paths.root);
    local_server::stop_installed(&root)?;
    Ok(local_server::status(&root))
}

#[tauri::command]
pub fn local_server_set_secrets(store_secrets: bool) -> Result<LocalServerChange, CommandError> {
    require_auth_feature()?;
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
    require_auth_feature()?;
    let paths = config::resolve_paths()?;
    Ok(local_server::export_backup(std::path::Path::new(
        &paths.root,
    ))?)
}

#[tauri::command]
pub fn local_server_import_backup(document: String) -> Result<LocalServerStatus, CommandError> {
    require_auth_feature()?;
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
    require_auth_feature()?;
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

#[cfg(test)]
mod tests {
    use super::validate_source_fields;
    use serde_json::json;
    use std::collections::BTreeMap;

    #[test]
    fn location_is_missing_until_it_is_confirmed() {
        let mut params = BTreeMap::new();
        params.insert(
            "location".into(),
            json!({"confirmed": false, "query": "Austin"}),
        );
        let rejected = validate_source_fields(vec!["location".into()], params, BTreeMap::new());
        assert!(!rejected.ok);
        assert!(rejected.message.contains("location"));

        let mut confirmed = BTreeMap::new();
        confirmed.insert(
            "location".into(),
            json!({
                "confirmed": true,
                "lat": 30.26715,
                "lon": -97.74306,
                "label": "Austin, Texas, United States"
            }),
        );
        let accepted = validate_source_fields(vec!["location".into()], confirmed, BTreeMap::new());
        assert!(accepted.ok);
    }
}
