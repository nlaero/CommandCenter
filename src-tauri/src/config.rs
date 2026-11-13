use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;

pub const ENV_HOME_OVERRIDE: &str = "COMMAND_CENTER_HOME";
pub const APP_DIR_NAME: &str = "command-center";
pub const CONFIG_FILE: &str = "config.yaml";
pub const LAYOUTS_DIR: &str = "layouts";
pub const BACKUP_SUFFIX: &str = ".bak";

/// Default auth-server for this install. Plain HTTP is allowed for this tailnet address.
pub const DEFAULT_AUTH_BASE_URL: &str = "http://100.101.141.93:8080";

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("yaml error: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Message(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPaths {
    pub root: String,
    pub config_file: String,
    pub layouts_dir: String,
    pub override_active: bool,
    pub override_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSettings {
    pub cols: u32,
    pub row_height: u32,
    pub margin: [i32; 2],
}

impl Default for LayoutSettings {
    fn default() -> Self {
        Self {
            cols: 48,
            row_height: 12,
            margin: [4, 4],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridItem {
    pub i: String,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_w: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_h: Option<i32>,
}

/// Optional timed multi-source rotation inside one board panel (Settings opt-in).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelRotation {
    #[serde(default)]
    pub enabled: bool,
    pub interval_sec: u32,
    #[serde(default)]
    pub source_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Panel {
    pub id: String,
    pub title: String,
    pub widget: String,
    /// Primary / fallback source binding (first rotation entry when rotating).
    pub source: String,
    #[serde(default)]
    pub options: BTreeMap<String, serde_json::Value>,
    pub layout: GridItem,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotation: Option<PanelRotation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub panels: Vec<Panel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceConfig {
    #[serde(rename = "type")]
    pub type_id: String,
    #[serde(default)]
    pub params: BTreeMap<String, serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh: Option<String>,
    #[serde(default)]
    pub secrets: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub draft: bool,
}

fn default_true() -> bool {
    true
}

fn default_auth_base_url() -> String {
    DEFAULT_AUTH_BASE_URL.to_string()
}

/// Username/password session against auth-server. Source API secrets are not part of this.
///
/// Missing `auth` on an existing config stays disabled (`Default`) so older boards still open.
/// A brand-new `AppState::default()` turns sign-in on.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSettings {
    /// When false, the board opens with no session gate.
    #[serde(default)]
    pub enabled: bool,
    /// Auth-server origin. Change this if the server is not the default tailnet host.
    #[serde(default = "default_auth_base_url")]
    pub base_url: String,
    /// Lab only: allow `http://` to localhost or a private LAN. Ignored for the tailnet
    /// address, which is allowed over HTTP in debug and release builds.
    #[serde(default)]
    pub allow_insecure_http: bool,
    /// Optional PEM bundle added to the trust store (mkcert / internal CA).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ca_file: Option<String>,
    /// Optional hex SHA-256 of the server leaf certificate or its SPKI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls_pin_sha256: Option<String>,
}

impl Default for AuthSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            base_url: default_auth_base_url(),
            allow_insecure_http: false,
            ca_file: None,
            tls_pin_sha256: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub version: u32,
    pub active_board_id: String,
    #[serde(default)]
    pub layout: LayoutSettings,
    pub boards: Vec<Board>,
    #[serde(default)]
    pub sources: BTreeMap<String, SourceConfig>,
    #[serde(default)]
    pub edit_mode: bool,
    /// Absent on older configs → sign-in off. New files from `Default` require an account.
    #[serde(default)]
    pub auth: AuthSettings,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            version: 1,
            active_board_id: "home".into(),
            layout: LayoutSettings::default(),
            boards: vec![Board {
                id: "home".into(),
                title: "Home".into(),
                panels: vec![],
            }],
            sources: BTreeMap::new(),
            edit_mode: false,
            auth: AuthSettings {
                enabled: true,
                ..AuthSettings::default()
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadResult {
    pub state: AppState,
    pub paths: ConfigPaths,
    pub created: bool,
}

pub fn resolve_paths() -> Result<ConfigPaths, ConfigError> {
    let (root, override_active, override_source) = if let Ok(home) = env::var(ENV_HOME_OVERRIDE) {
        let trimmed = home.trim();
        if trimmed.is_empty() {
            return Err(ConfigError::Message(
                "COMMAND_CENTER_HOME is set but empty".into(),
            ));
        }
        (
            PathBuf::from(trimmed),
            true,
            Some(ENV_HOME_OVERRIDE.to_string()),
        )
    } else {
        let base = dirs::config_dir().ok_or_else(|| {
            ConfigError::Message("could not resolve OS config directory".into())
        })?;
        (base.join(APP_DIR_NAME), false, None)
    };

    Ok(ConfigPaths {
        root: root.display().to_string(),
        config_file: root.join(CONFIG_FILE).display().to_string(),
        layouts_dir: root.join(LAYOUTS_DIR).display().to_string(),
        override_active,
        override_source,
    })
}

pub fn ensure_dirs(paths: &ConfigPaths) -> Result<(), ConfigError> {
    fs::create_dir_all(&paths.root)?;
    fs::create_dir_all(&paths.layouts_dir)?;
    Ok(())
}

pub fn load_or_create() -> Result<LoadResult, ConfigError> {
    let paths = resolve_paths()?;
    ensure_dirs(&paths)?;
    let config_path = PathBuf::from(&paths.config_file);

    if config_path.exists() {
        let raw = fs::read_to_string(&config_path)?;
        let mut state: AppState = serde_yaml::from_str(&raw)?;
        hydrate_layouts(&paths, &mut state)?;
        Ok(LoadResult {
            state,
            paths,
            created: false,
        })
    } else {
        let state = AppState::default();
        save_state(&paths, &state)?;
        Ok(LoadResult {
            state,
            paths,
            created: true,
        })
    }
}

fn hydrate_layouts(paths: &ConfigPaths, state: &mut AppState) -> Result<(), ConfigError> {
    for board in &mut state.boards {
        let layout_path = Path::new(&paths.layouts_dir).join(format!("{}.json", board.id));
        if !layout_path.exists() {
            continue;
        }
        let raw = fs::read_to_string(&layout_path)?;
        let items: Vec<GridItem> = serde_json::from_str(&raw)?;
        for item in items {
            if let Some(panel) = board.panels.iter_mut().find(|p| p.id == item.i) {
                panel.layout = item;
            }
        }
    }
    Ok(())
}

pub fn save_state(paths: &ConfigPaths, state: &AppState) -> Result<(), ConfigError> {
    ensure_dirs(paths)?;
    let config_path = PathBuf::from(&paths.config_file);
    backup_if_exists(&config_path)?;

    let yaml = serde_yaml::to_string(state)?;
    fs::write(&config_path, yaml)?;

    for board in &state.boards {
        let layout_items: Vec<GridItem> = board.panels.iter().map(|p| p.layout.clone()).collect();
        write_layout(paths, &board.id, &layout_items)?;
    }
    Ok(())
}

pub fn write_layout(
    paths: &ConfigPaths,
    board_id: &str,
    items: &[GridItem],
) -> Result<(), ConfigError> {
    ensure_dirs(paths)?;
    let layout_path = Path::new(&paths.layouts_dir).join(format!("{board_id}.json"));
    backup_if_exists(&layout_path)?;
    let json = serde_json::to_string_pretty(items)?;
    fs::write(layout_path, json)?;
    Ok(())
}

fn backup_if_exists(path: &Path) -> Result<(), ConfigError> {
    if path.exists() {
        let bak_path = PathBuf::from(format!("{}{}", path.display(), BACKUP_SUFFIX));
        fs::copy(path, bak_path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn default_state_is_empty_board() {
        let state = AppState::default();
        assert_eq!(state.boards.len(), 1);
        assert!(state.boards[0].panels.is_empty());
        assert!(state.sources.is_empty());
        assert_eq!(state.layout.cols, 48);
        assert!(state.auth.enabled);
        assert_eq!(state.auth.base_url, DEFAULT_AUTH_BASE_URL);
        assert!(!state.auth.allow_insecure_http);
    }

    #[test]
    fn missing_auth_keeps_existing_boards_open() {
        let yaml = r#"
version: 1
activeBoardId: home
boards:
  - id: home
    title: Home
    panels: []
"#;
        let state: AppState = serde_yaml::from_str(yaml).unwrap();
        assert!(!state.auth.enabled);
        assert_eq!(state.auth.base_url, DEFAULT_AUTH_BASE_URL);
    }

    #[test]
    fn auth_settings_round_trip_yaml() {
        let mut state = AppState::default();
        state.auth.allow_insecure_http = true;
        state.auth.ca_file = Some("/tmp/ca.pem".into());
        let yaml = serde_yaml::to_string(&state).unwrap();
        let back: AppState = serde_yaml::from_str(&yaml).unwrap();
        assert!(back.auth.enabled);
        assert_eq!(back.auth.base_url, DEFAULT_AUTH_BASE_URL);
        assert!(back.auth.allow_insecure_http);
        assert_eq!(back.auth.ca_file.as_deref(), Some("/tmp/ca.pem"));
    }

    #[test]
    fn override_env_sets_root() {
        let _guard = ENV_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("cc-test-{}", uuid::Uuid::new_v4()));
        env::set_var(ENV_HOME_OVERRIDE, &dir);
        let paths = resolve_paths().unwrap();
        assert!(paths.override_active);
        assert_eq!(paths.root, dir.display().to_string());
        env::remove_var(ENV_HOME_OVERRIDE);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn panel_rotation_round_trips_yaml() {
        let panel = Panel {
            id: "panel.rot.1".into(),
            title: "Rotate".into(),
            widget: "rotate".into(),
            source: "src.a".into(),
            options: BTreeMap::new(),
            layout: GridItem {
                i: "panel.rot.1".into(),
                x: 0,
                y: 0,
                w: 16,
                h: 12,
                min_w: Some(8),
                min_h: Some(8),
            },
            rotation: Some(PanelRotation {
                enabled: true,
                interval_sec: 30,
                source_ids: vec!["src.a".into(), "src.b".into()],
            }),
        };
        let yaml = serde_yaml::to_string(&panel).unwrap();
        let back: Panel = serde_yaml::from_str(&yaml).unwrap();
        let rot = back.rotation.expect("rotation present");
        assert!(rot.enabled);
        assert_eq!(rot.interval_sec, 30);
        assert_eq!(rot.source_ids, vec!["src.a", "src.b"]);
    }
}
