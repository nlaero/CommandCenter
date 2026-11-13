use crate::config::{
    self, AppState, ConfigPaths, GridItem, LoadResult, SourceConfig,
};
use crate::secrets;
use crate::sources::{self, SourcePayload};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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
    Ok(loaded.state)
}

#[tauri::command]
pub fn store_secrets(args: StoreSecretsArgs) -> Result<(), CommandError> {
    secrets::set_secrets(&args.secrets)?;
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

    if !loaded.state.sources.contains_key(&args.panel.source) {
        return Err(CommandError {
            message: format!(
                "source {} must exist and be valid before adding to board",
                args.panel.source
            ),
        });
    }

    let source = &loaded.state.sources[&args.panel.source];
    if source.draft {
        return Err(CommandError {
            message: "source is still a draft; finish required fields first".into(),
        });
    }

    board.panels.push(args.panel);
    let paths = config::resolve_paths()?;
    config::save_state(&paths, &loaded.state)?;
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
            if secrets.get(name).map(|s| s.trim().is_empty()).unwrap_or(true) {
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
