//! Board and source setup stored on auth-server for the signed-in account.
//!
//! Secret values stay in the keyring. Auth-server URL and "require sign-in"
//! stay on this computer. `cargo test` talks only to 127.0.0.1 and refuses the
//! tailnet address.

use crate::auth::{AuthError, AuthService, TokenStore};
use crate::config::{self, AppState, Board, LayoutSettings, SourceConfig};
use crate::secrets;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

pub const MAX_DOCUMENT_BYTES: usize = 512 * 1024;
const CURSOR_FILE: &str = "settings-sync.json";

/// Param names that must never be uploaded, even if they are not listed under
/// `source.secrets`. Matched case-insensitively, with or without underscores.
const SECRET_KEYS: &[&str] = &[
    "password",
    "secret",
    "token",
    "apikey",
    "api_key",
    "apptoken",
    "app_token",
    "refreshtoken",
    "refresh_token",
    "accesstoken",
    "access_token",
    "authorization",
    "clientsecret",
    "client_secret",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardDocument {
    pub version: u32,
    pub active_board_id: String,
    #[serde(default)]
    pub layout: LayoutSettings,
    pub boards: Vec<Board>,
    #[serde(default)]
    pub sources: BTreeMap<String, SourceConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncCursor {
    pub user_id: String,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub state: AppState,
    pub restored: bool,
    pub published: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SyncWork {
    pub state: AppState,
    pub restored: bool,
    pub published: bool,
    pub cursor: Option<SyncCursor>,
}

struct StoredSettings {
    revision: u64,
    document: BoardDocument,
}

enum GetResult {
    Found(StoredSettings),
    Missing,
}

enum PutResult {
    Saved(StoredSettings),
    Conflict(StoredSettings),
    Missing,
}

pub fn read_cursor(root: &str) -> Option<SyncCursor> {
    let raw = fs::read_to_string(Path::new(root).join(CURSOR_FILE)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn write_cursor(root: &str, cursor: &SyncCursor) -> Result<(), config::ConfigError> {
    let path = Path::new(root).join(CURSOR_FILE);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_string_pretty(cursor)?)?;
    Ok(())
}

/// Keyring values that must not appear in an uploaded board.
pub fn secret_values(state: &AppState) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();
    for source in state.sources.values() {
        for name in &source.secrets {
            if let Ok(Some(value)) = secrets::get_secret(name) {
                if !value.is_empty() {
                    values.insert(name.clone(), value);
                }
            }
        }
    }
    for name in ["auth.access_token", "auth.refresh_token"] {
        if let Ok(Some(value)) = secrets::get_secret(name) {
            if value.len() >= 8 {
                values.insert(name.to_string(), value);
            }
        }
    }
    values
}

pub fn has_local_content(state: &AppState) -> bool {
    if !state.sources.is_empty() {
        return true;
    }
    if state.boards.len() != 1 {
        return true;
    }
    let Some(board) = state.boards.first() else {
        return false;
    };
    if !board.panels.is_empty() || board.id != "home" || board.title != "Home" {
        return true;
    }
    if state.active_board_id != "home" {
        return true;
    }
    state.layout != LayoutSettings::default()
}

pub fn document_from_state(
    state: &AppState,
    secret_values: &BTreeMap<String, String>,
) -> BoardDocument {
    let names: BTreeSet<String> = state
        .sources
        .values()
        .flat_map(|source| source.secrets.iter().cloned())
        .collect();
    let mut sources = BTreeMap::new();
    for (id, source) in &state.sources {
        let mut source = source.clone();
        source.params = scrub_map(&source.params, &source.secrets, secret_values);
        sources.insert(id.clone(), source);
    }
    let mut document = BoardDocument {
        version: state.version,
        active_board_id: state.active_board_id.clone(),
        layout: state.layout.clone(),
        boards: state.boards.clone(),
        sources,
    };
    redact_document(&mut document, secret_values, &names);
    document
}

pub fn apply_document(state: &mut AppState, document: BoardDocument) {
    state.version = document.version;
    state.layout = document.layout;
    state.sources = document.sources;
    if document.boards.is_empty() {
        return;
    }
    state.boards = document.boards;
    if state
        .boards
        .iter()
        .any(|board| board.id == document.active_board_id)
    {
        state.active_board_id = document.active_board_id;
    } else if let Some(first) = state.boards.first() {
        state.active_board_id = first.id.clone();
    }
}

/// Login / online restore. A stored account board replaces this computer's
/// boards and sources. If this computer's cursor is still on that revision
/// and the local board has edits that never uploaded, those edits are published
/// instead of discarded. Auth settings and edit mode stay local.
pub fn reconcile<S: TokenStore>(
    service: &AuthService<S>,
    state: &AppState,
    secret_values: &BTreeMap<String, String>,
    cursor: Option<SyncCursor>,
) -> Result<SyncWork, AuthError> {
    if !state.auth.enabled {
        return Ok(unchanged(state, None));
    }
    let Some(user_id) = service.stored_user_id() else {
        return Ok(unchanged(state, None));
    };
    match get_settings(service, state)? {
        GetResult::Missing => {
            if !has_local_content(state) {
                return Ok(unchanged(state, None));
            }
            let document = document_from_state(state, secret_values);
            match put_settings(service, state, &document, None)? {
                PutResult::Saved(saved) => Ok(SyncWork {
                    state: state.clone(),
                    restored: false,
                    published: true,
                    cursor: Some(SyncCursor {
                        user_id,
                        revision: saved.revision,
                    }),
                }),
                PutResult::Conflict(remote) => Ok(applied(state, remote, &user_id)),
                PutResult::Missing => Ok(unchanged(state, None)),
            }
        }
        GetResult::Found(remote) => {
            let local = document_from_state(state, secret_values);
            if documents_equal(&local, &remote.document) {
                Ok(SyncWork {
                    state: state.clone(),
                    restored: false,
                    published: false,
                    cursor: Some(SyncCursor {
                        user_id,
                        revision: remote.revision,
                    }),
                })
            } else if cursor.as_ref().is_some_and(|item| {
                item.user_id == user_id && item.revision == remote.revision
            }) {
                // This computer already had this revision and then edited.
                // A failed upload must not be thrown away on the next launch.
                match put_settings(service, state, &local, Some(remote.revision))? {
                    PutResult::Saved(saved) => Ok(SyncWork {
                        state: state.clone(),
                        restored: false,
                        published: true,
                        cursor: Some(SyncCursor {
                            user_id,
                            revision: saved.revision,
                        }),
                    }),
                    PutResult::Conflict(newer) => Ok(applied(state, newer, &user_id)),
                    PutResult::Missing => Ok(unchanged(state, cursor)),
                }
            } else {
                Ok(applied(state, remote, &user_id))
            }
        }
    }
}

/// Push the board after a local edit. On a revision conflict, retry once so
/// this edit wins. A down server does not roll back the local save.
pub fn publish<S: TokenStore>(
    service: &AuthService<S>,
    state: &AppState,
    secret_values: &BTreeMap<String, String>,
    cursor: Option<SyncCursor>,
) -> Result<SyncWork, AuthError> {
    if !state.auth.enabled {
        return Ok(unchanged(state, cursor));
    }
    let Some(user_id) = service.stored_user_id() else {
        return Ok(unchanged(state, None));
    };
    let cursor = cursor.filter(|item| item.user_id == user_id);
    let document = document_from_state(state, secret_values);
    let revision = cursor.as_ref().map(|item| item.revision);
    match put_settings(service, state, &document, revision)? {
        PutResult::Saved(saved) => Ok(SyncWork {
            state: state.clone(),
            restored: false,
            published: true,
            cursor: Some(SyncCursor {
                user_id,
                revision: saved.revision,
            }),
        }),
        PutResult::Missing => Ok(unchanged(state, None)),
        PutResult::Conflict(remote) => match put_settings(service, state, &document, Some(remote.revision))?
        {
            PutResult::Saved(saved) => Ok(SyncWork {
                state: state.clone(),
                restored: false,
                published: true,
                cursor: Some(SyncCursor {
                    user_id,
                    revision: saved.revision,
                }),
            }),
            PutResult::Conflict(_) | PutResult::Missing => Ok(unchanged(state, cursor)),
        },
    }
}

fn unchanged(state: &AppState, cursor: Option<SyncCursor>) -> SyncWork {
    SyncWork {
        state: state.clone(),
        restored: false,
        published: false,
        cursor,
    }
}

fn applied(state: &AppState, remote: StoredSettings, user_id: &str) -> SyncWork {
    let mut next = state.clone();
    let revision = remote.revision;
    apply_document(&mut next, remote.document);
    SyncWork {
        state: next,
        restored: true,
        published: false,
        cursor: Some(SyncCursor {
            user_id: user_id.to_string(),
            revision,
        }),
    }
}

fn documents_equal(left: &BoardDocument, right: &BoardDocument) -> bool {
    serde_json::to_value(left).ok() == serde_json::to_value(right).ok()
}

fn get_settings<S: TokenStore>(
    service: &AuthService<S>,
    state: &AppState,
) -> Result<GetResult, AuthError> {
    let (status, body) =
        service.authorized(&state.auth, reqwest::Method::GET, "/settings", None)?;
    match status {
        200 => {
            let body = body.ok_or_else(|| {
                AuthError::Message("auth-server returned an empty board.".into())
            })?;
            Ok(GetResult::Found(parse_stored(&body)?))
        }
        404 => Ok(GetResult::Missing),
        _ => Err(status_error(status, body.as_ref())),
    }
}

fn put_settings<S: TokenStore>(
    service: &AuthService<S>,
    state: &AppState,
    document: &BoardDocument,
    revision: Option<u64>,
) -> Result<PutResult, AuthError> {
    let encoded = encode_document(document)?;
    let mut body = Map::new();
    body.insert(
        "revision".into(),
        revision.map(Value::from).unwrap_or(Value::Null),
    );
    body.insert("document".into(), encoded);
    let (status, response) = service.authorized(
        &state.auth,
        reqwest::Method::PUT,
        "/settings",
        Some(Value::Object(body)),
    )?;
    match status {
        200 => {
            let response = response.ok_or_else(|| {
                AuthError::Message("auth-server returned an empty board.".into())
            })?;
            Ok(PutResult::Saved(parse_stored(&response)?))
        }
        409 => {
            let response = response.ok_or_else(|| {
                AuthError::Message("auth-server reported a conflict without the current board.".into())
            })?;
            Ok(PutResult::Conflict(parse_stored(&response)?))
        }
        404 => Ok(PutResult::Missing),
        _ => Err(status_error(status, response.as_ref())),
    }
}

fn encode_document(document: &BoardDocument) -> Result<Value, AuthError> {
    let value = serde_json::to_value(document)
        .map_err(|err| AuthError::Message(format!("could not encode the board: {err}")))?;
    let raw = serde_json::to_vec(&value)
        .map_err(|err| AuthError::Message(format!("could not encode the board: {err}")))?;
    if raw.len() > MAX_DOCUMENT_BYTES {
        return Err(AuthError::Message(format!(
            "Board setup is too large to sync ({} bytes; limit is {MAX_DOCUMENT_BYTES}).",
            raw.len()
        )));
    }
    Ok(value)
}

fn parse_stored(body: &Value) -> Result<StoredSettings, AuthError> {
    let revision = body
        .get("revision")
        .and_then(Value::as_u64)
        .ok_or_else(|| AuthError::Message("auth-server returned settings without a revision.".into()))?;
    let document = body.get("document").cloned().ok_or_else(|| {
        AuthError::Message("auth-server returned settings without a board.".into())
    })?;
    let document = serde_json::from_value(document).map_err(|_| {
        AuthError::Message("auth-server returned a board this app could not read.".into())
    })?;
    Ok(StoredSettings { revision, document })
}

fn status_error(status: u16, body: Option<&Value>) -> AuthError {
    let code = body
        .and_then(|value| value.get("error"))
        .and_then(Value::as_str)
        .unwrap_or(if status == 401 {
            "invalid_token"
        } else {
            "bad_request"
        });
    let message = match code {
        "invalid_token" => "Session expired. Sign in again.".to_string(),
        "conflict" => "The account board was updated on another computer.".to_string(),
        "bad_request" => "auth-server rejected the board setup.".to_string(),
        other => format!("auth-server rejected the board setup ({other})."),
    };
    AuthError::Api {
        status,
        code: code.to_string(),
        message,
    }
}

fn scrub_map(
    params: &BTreeMap<String, Value>,
    secret_names: &[String],
    secret_values: &BTreeMap<String, String>,
) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    for (key, value) in params {
        if secret_names.iter().any(|name| name.eq_ignore_ascii_case(key)) || is_secret_key(key) {
            continue;
        }
        if let Some(cleaned) = scrub_value(value, secret_names, secret_values) {
            out.insert(key.clone(), cleaned);
        }
    }
    out
}

fn scrub_value(
    value: &Value,
    secret_names: &[String],
    secret_values: &BTreeMap<String, String>,
) -> Option<Value> {
    match value {
        Value::String(text) => {
            if secret_values
                .values()
                .any(|secret| !secret.is_empty() && secret == text)
            {
                None
            } else {
                Some(Value::String(text.clone()))
            }
        }
        Value::Array(items) => Some(Value::Array(
            items
                .iter()
                .filter_map(|item| scrub_value(item, secret_names, secret_values))
                .collect(),
        )),
        Value::Object(map) => {
            let shaped = map
                .iter()
                .map(|(key, item)| (key.clone(), item.clone()))
                .collect();
            let cleaned = scrub_map(&shaped, secret_names, secret_values);
            Some(Value::Object(cleaned.into_iter().collect()))
        }
        other => Some(other.clone()),
    }
}

fn redact_document(
    document: &mut BoardDocument,
    secret_values: &BTreeMap<String, String>,
    secret_names: &BTreeSet<String>,
) {
    let Ok(mut value) = serde_json::to_value(&*document) else {
        return;
    };
    strip_secret_keys(&mut value);
    for secret in secret_values.values() {
        if secret.len() >= 8 {
            redact_value(&mut value, secret, secret_names);
        }
    }
    if let Ok(next) = serde_json::from_value(value) {
        *document = next;
    }
}

fn redact_value(value: &mut Value, secret: &str, secret_names: &BTreeSet<String>) {
    match value {
        Value::String(text) => {
            if secret_names.contains(text.as_str()) {
                return;
            }
            if text.contains(secret) {
                *text = text.replace(secret, "");
            }
        }
        Value::Array(items) => {
            for item in items {
                redact_value(item, secret, secret_names);
            }
        }
        Value::Object(map) => {
            for (key, child) in map {
                if key == "secrets" {
                    continue;
                }
                redact_value(child, secret, secret_names);
            }
        }
        _ => {}
    }
}

fn strip_secret_keys(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.retain(|key, child| {
                if key != "secrets" && is_secret_key(key) {
                    return false;
                }
                if key != "secrets" {
                    strip_secret_keys(child);
                }
                true
            });
        }
        Value::Array(items) => {
            for item in items {
                strip_secret_keys(item);
            }
        }
        _ => {}
    }
}

fn is_secret_key(key: &str) -> bool {
    let normalized: String = key
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
        .flat_map(|ch| ch.to_lowercase())
        .collect();
    let flat = normalized.replace('_', "");
    SECRET_KEYS.iter().any(|item| {
        *item == normalized.as_str() || item.replace('_', "") == flat
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{AuthError, AuthService};
    use crate::config::{AppState, AuthSettings, GridItem, Panel, SourceConfig};
    use serde_json::Value;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    #[derive(Clone, Default)]
    struct MemoryStore {
        values: Arc<Mutex<BTreeMap<String, String>>>,
    }

    impl TokenStore for MemoryStore {
        fn get(&self, key: &str) -> Result<Option<String>, AuthError> {
            Ok(self
                .values
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .get(key)
                .cloned())
        }

        fn set(&self, key: &str, value: &str) -> Result<(), AuthError> {
            self.values
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .insert(key.to_string(), value.to_string());
            Ok(())
        }

        fn delete(&self, key: &str) -> Result<(), AuthError> {
            self.values
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .remove(key);
            Ok(())
        }
    }

    #[derive(Clone)]
    struct Stored {
        revision: u64,
        document: Value,
    }

    struct Fake {
        docs: Mutex<BTreeMap<String, Stored>>,
        seen: Mutex<Vec<(String, String)>>,
        unauthorized: Mutex<bool>,
        settings_enabled: Mutex<bool>,
        /// First N GETs report not_found even when a document is stored.
        hide_gets: Mutex<u32>,
    }

    impl Fake {
        fn new() -> Self {
            Self {
                docs: Mutex::new(BTreeMap::new()),
                seen: Mutex::new(Vec::new()),
                unauthorized: Mutex::new(false),
                settings_enabled: Mutex::new(true),
                hide_gets: Mutex::new(0),
            }
        }
    }

    fn spawn_fake() -> (String, Arc<Fake>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let fake = Arc::new(Fake::new());
        let serve = Arc::clone(&fake);
        thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut stream) = conn else { continue };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let Ok((method, path, headers, body)) = read_http(&mut stream) else {
                    continue;
                };
                serve.seen.lock().unwrap().push((
                    method.clone(),
                    String::from_utf8_lossy(&body).to_string(),
                ));
                let (status, payload) = dispatch(&serve, &method, &path, &headers, &body);
                let raw = payload.unwrap_or_default();
                let reason = match status {
                    200 => "OK",
                    401 => "Unauthorized",
                    404 => "Not Found",
                    409 => "Conflict",
                    _ => "Error",
                };
                let head = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    raw.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&raw);
            }
        });
        (format!("http://127.0.0.1:{port}"), fake)
    }

    fn dispatch(
        fake: &Fake,
        method: &str,
        path: &str,
        headers: &[(String, String)],
        body: &[u8],
    ) -> (u16, Option<Vec<u8>>) {
        if path != "/settings" || !*fake.settings_enabled.lock().unwrap() {
            return (404, Some(br#"{"error":"not_found"}"#.to_vec()));
        }
        if *fake.unauthorized.lock().unwrap() {
            return (401, Some(br#"{"error":"invalid_token"}"#.to_vec()));
        }
        let Some(user) = bearer_user(headers) else {
            return (401, Some(br#"{"error":"invalid_token"}"#.to_vec()));
        };
        let json: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
        match method {
            "GET" => {
                let mut hidden = fake.hide_gets.lock().unwrap();
                if *hidden > 0 {
                    *hidden -= 1;
                    return (404, Some(br#"{"error":"not_found"}"#.to_vec()));
                }
                drop(hidden);
                match fake.docs.lock().unwrap().get(&user) {
                    Some(stored) => (200, Some(stored_body(stored, false))),
                    None => (404, Some(br#"{"error":"not_found"}"#.to_vec())),
                }
            }
            "PUT" => {
                let revision = match json.get("revision") {
                    Some(Value::Number(number)) => number.as_u64(),
                    _ => None,
                };
                let Some(document) = json.get("document").cloned() else {
                    return (400, Some(br#"{"error":"bad_request"}"#.to_vec()));
                };
                let mut docs = fake.docs.lock().unwrap();
                match docs.get(&user).cloned() {
                    None if revision.is_none() => {
                        let stored = Stored {
                            revision: 1,
                            document,
                        };
                        let raw = stored_body(&stored, false);
                        docs.insert(user, stored);
                        (200, Some(raw))
                    }
                    Some(current) if revision == Some(current.revision) => {
                        let stored = Stored {
                            revision: current.revision + 1,
                            document,
                        };
                        let raw = stored_body(&stored, false);
                        docs.insert(user, stored);
                        (200, Some(raw))
                    }
                    Some(current) => (409, Some(stored_body(&current, true))),
                    None => (404, Some(br#"{"error":"not_found"}"#.to_vec())),
                }
            }
            _ => (404, Some(br#"{"error":"not_found"}"#.to_vec())),
        }
    }

    fn stored_body(stored: &Stored, conflict: bool) -> Vec<u8> {
        let mut value = serde_json::json!({
            "revision": stored.revision,
            "updatedAt": 1_700_000_000,
            "document": stored.document,
        });
        if conflict {
            value["error"] = Value::String("conflict".into());
        }
        serde_json::to_vec(&value).unwrap()
    }

    fn bearer_user(headers: &[(String, String)]) -> Option<String> {
        let header = headers
            .iter()
            .find(|(key, _)| key == "authorization")
            .map(|(_, value)| value.as_str())?;
        let token = header.strip_prefix("Bearer ")?;
        token.split('.').next().map(str::to_string)
    }

    fn read_http(
        stream: &mut std::net::TcpStream,
    ) -> std::io::Result<(String, String, Vec<(String, String)>, Vec<u8>)> {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 4096];
        let header_end = loop {
            let n = stream.read(&mut tmp)?;
            if n == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "closed",
                ));
            }
            buf.extend_from_slice(&tmp[..n]);
            if let Some(pos) = buf.windows(4).position(|window| window == b"\r\n\r\n") {
                break pos;
            }
            if buf.len() > 1_048_576 {
                return Err(std::io::Error::other("headers too large"));
            }
        };
        let header = String::from_utf8_lossy(&buf[..header_end]).to_string();
        let mut lines = header.split("\r\n");
        let request = lines.next().unwrap_or("");
        let mut parts = request.split_whitespace();
        let method = parts.next().unwrap_or("").to_string();
        let path = parts.next().unwrap_or("/").to_string();
        let mut headers = Vec::new();
        let mut length = 0usize;
        for line in lines {
            if let Some((key, value)) = line.split_once(':') {
                let key = key.trim().to_ascii_lowercase();
                let value = value.trim().to_string();
                if key == "content-length" {
                    length = value.parse().unwrap_or(0);
                }
                headers.push((key, value));
            }
        }
        let mut body = buf[header_end + 4..].to_vec();
        while body.len() < length {
            let n = stream.read(&mut tmp)?;
            if n == 0 {
                break;
            }
            body.extend_from_slice(&tmp[..n]);
        }
        body.truncate(length);
        Ok((method, path, headers, body))
    }

    fn service(user: &str, access: &str) -> AuthService<MemoryStore> {
        let store = MemoryStore::default();
        let service = AuthService::with_store(store);
        service.seed_session(user, "ada", access);
        service
    }

    fn signed_state(base: &str) -> AppState {
        let mut state = AppState::default();
        state.auth = AuthSettings {
            enabled: true,
            base_url: base.into(),
            allow_insecure_http: true,
            ca_file: None,
            tls_pin_sha256: None,
        };
        state
    }

    fn with_ops(base: &str) -> (AppState, BTreeMap<String, String>) {
        let mut state = signed_state(base);
        state.edit_mode = true;
        state.boards[0].title = "Ops".into();
        state.boards[0].panels.push(Panel {
            id: "p1".into(),
            title: "Calls".into(),
            widget: "audio".into(),
            source: "feed".into(),
            options: BTreeMap::from([(
                "password".into(),
                Value::String("panel-secret-value".into()),
            )]),
            layout: GridItem {
                i: "p1".into(),
                x: 0,
                y: 0,
                w: 8,
                h: 6,
                min_w: None,
                min_h: None,
            },
            rotation: None,
        });
        let mut params = BTreeMap::new();
        params.insert("feedId".into(), Value::String("42".into()));
        params.insert("password".into(), Value::String("super-secret-value".into()));
        params.insert(
            "note".into(),
            Value::String("desk token is super-secret-value today".into()),
        );
        params.insert(
            "nested".into(),
            serde_json::json!({"apiKey": "abcd1234efgh", "label": "visible"}),
        );
        state.sources.insert(
            "feed".into(),
            SourceConfig {
                type_id: "broadcastify.calls".into(),
                params,
                refresh: Some("60s".into()),
                secrets: vec!["broadcastify.password".into()],
                enabled: true,
                draft: false,
            },
        );
        let mut secrets = BTreeMap::new();
        secrets.insert("broadcastify.password".into(), "super-secret-value".into());
        secrets.insert("socrata.app_token".into(), "abcd1234efgh".into());
        (state, secrets)
    }

    #[test]
    fn default_board_is_not_content() {
        assert!(!has_local_content(&AppState::default()));
        let mut titled = AppState::default();
        titled.boards[0].title = "Ops".into();
        assert!(has_local_content(&titled));
    }

    #[test]
    fn scrub_keeps_secret_names_and_drops_values() {
        let (state, secrets) = with_ops("http://127.0.0.1:9");
        let document = document_from_state(&state, &secrets);
        let raw = serde_json::to_string(&document).unwrap();
        assert!(!raw.contains("super-secret-value"));
        assert!(!raw.contains("panel-secret-value"));
        assert!(!raw.contains("abcd1234efgh"));
        assert!(!raw.contains("editMode"));
        assert!(!raw.contains("baseUrl"));
        assert!(!raw.contains("allowInsecureHttp"));
        let source = document.sources.get("feed").unwrap();
        assert_eq!(source.secrets, vec!["broadcastify.password".to_string()]);
        assert_eq!(source.params.get("feedId").unwrap(), "42");
        assert!(source.params.get("password").is_none());
        assert_eq!(
            source.params.get("nested").unwrap()["label"],
            "visible"
        );
        assert!(source.params.get("nested").unwrap().get("apiKey").is_none());
        assert_eq!(source.params.get("note").unwrap(), "desk token is  today");
    }

    #[test]
    fn second_device_restores_the_board_without_secrets() {
        let (base, fake) = spawn_fake();
        let (state, secrets) = with_ops(&base);
        let first = service("user-1", "user-1.device-a");
        let published = publish(&first, &state, &secrets, None).unwrap();
        assert!(published.published);
        assert_eq!(published.cursor.unwrap().revision, 1);
        let body = fake.seen.lock().unwrap()[0].1.clone();
        assert!(!body.contains("super-secret-value"));
        assert!(body.contains("broadcastify.password"));
        assert!(body.contains("\"feedId\":\"42\"") || body.contains("\"feedId\": \"42\""));

        let mut other = signed_state(&base);
        other.edit_mode = false;
        other.auth.allow_insecure_http = true;
        let second = service("user-1", "user-1.device-b");
        let restored = reconcile(&second, &other, &BTreeMap::new(), None).unwrap();
        assert!(restored.restored);
        assert_eq!(restored.state.boards[0].title, "Ops");
        assert_eq!(restored.state.boards[0].panels[0].title, "Calls");
        let source = restored.state.sources.get("feed").unwrap();
        assert_eq!(source.secrets, vec!["broadcastify.password".to_string()]);
        assert!(source.params.get("password").is_none());
        assert_eq!(source.params.get("feedId").unwrap(), "42");
        assert!(!restored.state.edit_mode);
        assert!(restored.state.auth.allow_insecure_http);
        assert!(restored.state.auth.enabled);
        assert_eq!(restored.state.auth.base_url.trim_end_matches('/'), base);
        let dumped = serde_json::to_string(&restored.state).unwrap();
        assert!(!dumped.contains("super-secret-value"));
        assert!(second
            .stored_user_id()
            .as_deref()
            == Some("user-1"));
    }

    #[test]
    fn login_prefers_the_account_board() {
        let (base, _) = spawn_fake();
        let (remote_state, secrets) = with_ops(&base);
        let first = service("user-1", "user-1.device-a");
        publish(&first, &remote_state, &secrets, None).unwrap();

        let mut local = signed_state(&base);
        local.boards[0].title = "Desk".into();
        local.boards[0].panels.push(Panel {
            id: "local".into(),
            title: "Local".into(),
            widget: "note".into(),
            source: "feed".into(),
            options: BTreeMap::new(),
            layout: GridItem {
                i: "local".into(),
                x: 0,
                y: 0,
                w: 4,
                h: 4,
                min_w: None,
                min_h: None,
            },
            rotation: None,
        });
        let second = service("user-1", "user-1.device-b");
        let restored = reconcile(&second, &local, &BTreeMap::new(), None).unwrap();
        assert!(restored.restored);
        assert_eq!(restored.state.boards[0].title, "Ops");
        assert_eq!(restored.state.boards[0].panels[0].id, "p1");
    }

    #[test]
    fn same_revision_publishes_unpublished_local_edits() {
        let (base, fake) = spawn_fake();
        let (state, secrets) = with_ops(&base);
        let client = service("user-1", "user-1.a");
        let published = publish(&client, &state, &secrets, None).unwrap();
        let cursor = published.cursor.clone();
        let mut edited = state.clone();
        edited.boards[0].title = "Desk edit".into();
        let result = reconcile(&client, &edited, &secrets, cursor).unwrap();
        assert!(result.published);
        assert!(!result.restored);
        assert_eq!(result.state.boards[0].title, "Desk edit");
        let stored = fake.docs.lock().unwrap().get("user-1").unwrap().clone();
        assert_eq!(stored.document["boards"][0]["title"], "Desk edit");
        assert_eq!(stored.revision, 2);
        assert!(!serde_json::to_string(&stored.document)
            .unwrap()
            .contains("super-secret-value"));
    }

    #[test]
    fn older_cursor_yields_to_a_newer_account_board() {
        let (base, fake) = spawn_fake();
        let (state, secrets) = with_ops(&base);
        let client = service("user-1", "user-1.a");
        let published = publish(&client, &state, &secrets, None).unwrap();
        let cursor = published.cursor.unwrap();
        fake.docs.lock().unwrap().insert(
            "user-1".into(),
            Stored {
                revision: cursor.revision + 2,
                document: serde_json::json!({
                    "version": 1,
                    "activeBoardId": "home",
                    "layout": {"cols": 48, "rowHeight": 12, "margin": [4, 4]},
                    "boards": [{"id": "home", "title": "Other computer", "panels": []}],
                    "sources": {}
                }),
            },
        );
        let mut local = state;
        local.boards[0].title = "Desk edit".into();
        let result = reconcile(&client, &local, &secrets, Some(cursor)).unwrap();
        assert!(result.restored);
        assert!(!result.published);
        assert_eq!(result.state.boards[0].title, "Other computer");
    }

    #[test]
    fn empty_account_keeps_an_empty_local_board() {
        let (base, fake) = spawn_fake();
        let state = signed_state(&base);
        let client = service("user-1", "user-1.a");
        let result = reconcile(&client, &state, &BTreeMap::new(), None).unwrap();
        assert!(!result.published);
        assert!(!result.restored);
        assert!(fake
            .seen
            .lock()
            .unwrap()
            .iter()
            .all(|(method, _)| method == "GET"));
    }

    #[test]
    fn first_login_with_a_board_seeds_the_account() {
        let (base, fake) = spawn_fake();
        let (state, secrets) = with_ops(&base);
        let client = service("user-1", "user-1.a");
        let result = reconcile(&client, &state, &secrets, None).unwrap();
        assert!(result.published);
        assert!(!result.restored);
        assert_eq!(result.state.boards[0].title, "Ops");
        let methods: Vec<_> = fake
            .seen
            .lock()
            .unwrap()
            .iter()
            .map(|(method, _)| method.clone())
            .collect();
        assert_eq!(methods, vec!["GET".to_string(), "PUT".to_string()]);
    }

    #[test]
    fn stale_revision_retries_once_and_keeps_the_local_edit() {
        let (base, fake) = spawn_fake();
        let (state, secrets) = with_ops(&base);
        let client = service("user-1", "user-1.a");
        let first = publish(&client, &state, &secrets, None).unwrap();
        fake.docs.lock().unwrap().insert(
            "user-1".into(),
            Stored {
                revision: 4,
                document: serde_json::json!({
                    "version": 1,
                    "activeBoardId": "home",
                    "layout": {"cols": 48, "rowHeight": 12, "margin": [4, 4]},
                    "boards": [{"id": "home", "title": "Remote", "panels": []}],
                    "sources": {}
                }),
            },
        );
        let mut edited = state.clone();
        edited.boards[0].title = "Local edit".into();
        let cursor = SyncCursor {
            user_id: "user-1".into(),
            revision: first.cursor.unwrap().revision,
        };
        let saved = publish(&client, &edited, &secrets, Some(cursor)).unwrap();
        assert!(saved.published);
        assert_eq!(saved.state.boards[0].title, "Local edit");
        assert_eq!(saved.cursor.unwrap().revision, 5);
        let stored = fake.docs.lock().unwrap().get("user-1").unwrap().clone();
        assert_eq!(stored.revision, 5);
        assert_eq!(stored.document["boards"][0]["title"], "Local edit");
        assert!(!serde_json::to_string(&stored.document)
            .unwrap()
            .contains("super-secret-value"));
    }

    #[test]
    fn hidden_get_conflict_keeps_the_account_board() {
        let (base, fake) = spawn_fake();
        let (remote, secrets) = with_ops(&base);
        let owner = service("user-1", "user-1.a");
        publish(&owner, &remote, &secrets, None).unwrap();
        *fake.hide_gets.lock().unwrap() = 1;
        let mut local = signed_state(&base);
        local.boards[0].title = "Desk".into();
        let other = service("user-1", "user-1.b");
        let result = reconcile(&other, &local, &BTreeMap::new(), None).unwrap();
        assert!(result.restored);
        assert_eq!(result.state.boards[0].title, "Ops");
        assert_eq!(
            fake.docs.lock().unwrap().get("user-1").unwrap().document["boards"][0]["title"],
            "Ops"
        );
    }

    #[test]
    fn unreachable_server_leaves_the_local_board() {
        let mut state = signed_state("http://127.0.0.1:1");
        state.boards[0].title = "Desk".into();
        let client = service("user-1", "user-1.a");
        let err = reconcile(&client, &state, &BTreeMap::new(), None).unwrap_err();
        assert!(err.is_unreachable());
        assert_eq!(state.boards[0].title, "Desk");
    }

    #[test]
    fn rejected_session_does_not_replace_the_board() {
        let (base, fake) = spawn_fake();
        *fake.unauthorized.lock().unwrap() = true;
        let mut state = signed_state(&base);
        state.boards[0].title = "Desk".into();
        let client = service("user-1", "user-1.a");
        let err = reconcile(&client, &state, &BTreeMap::new(), None).unwrap_err();
        match err {
            AuthError::Api { status: 401, .. } => {}
            other => panic!("expected 401, got {other}"),
        }
        assert_eq!(state.boards[0].title, "Desk");
    }

    #[test]
    fn missing_settings_route_keeps_the_local_board() {
        let (base, fake) = spawn_fake();
        *fake.settings_enabled.lock().unwrap() = false;
        let (state, secrets) = with_ops(&base);
        let client = service("user-1", "user-1.a");
        let result = reconcile(&client, &state, &secrets, None).unwrap();
        assert!(!result.published);
        assert!(!result.restored);
        assert_eq!(result.state.boards[0].title, "Ops");
        assert!(result.cursor.is_none());
    }

    #[test]
    fn oversized_board_is_not_uploaded() {
        let (base, fake) = spawn_fake();
        let (mut state, secrets) = with_ops(&base);
        state
            .sources
            .get_mut("feed")
            .unwrap()
            .params
            .insert("blurb".into(), Value::String("x".repeat(MAX_DOCUMENT_BYTES + 1)));
        let client = service("user-1", "user-1.a");
        let err = publish(&client, &state, &secrets, None).unwrap_err();
        assert!(err.to_string().contains("too large"));
        assert!(fake.seen.lock().unwrap().is_empty());
    }

    #[test]
    #[should_panic(expected = "refusing to contact a tailnet auth-server")]
    fn sync_refuses_the_tailnet_address() {
        let client = service("user-1", "user-1.a");
        let state = AppState::default();
        let _ = reconcile(&client, &state, &BTreeMap::new(), None);
    }
}
