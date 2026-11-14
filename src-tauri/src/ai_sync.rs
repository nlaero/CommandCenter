//! Caption fixes for the on-device model.
//!
//! The model and the audio stay on this computer. This module only moves the
//! short text corrections through whichever auth-server the user is signed into.

use crate::auth::{AuthError, AuthService, TokenStore};
use crate::config::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::Path;

const MEMORY_FILE: &str = "ai-memory.json";
const CURSOR_FILE: &str = "ai-memory-sync.json";
const MAX_CORRECTIONS: usize = 400;
const MAX_PHRASE: usize = 160;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Correction {
    pub id: String,
    pub heard: String,
    pub says: String,
    #[serde(default = "default_count")]
    pub count: u64,
}

fn default_count() -> u64 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiMemory {
    pub version: u32,
    pub corrections: Vec<Correction>,
}

impl Default for AiMemory {
    fn default() -> Self {
        Self {
            version: 1,
            corrections: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Cursor {
    user_id: String,
    revision: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSyncOutcome {
    pub memory: AiMemory,
    pub revision: Option<u64>,
    pub server: String,
    pub published: bool,
    pub restored: bool,
    pub message: Option<String>,
}

pub fn load(root: &Path) -> AiMemory {
    let Ok(raw) = fs::read_to_string(root.join(MEMORY_FILE)) else {
        return AiMemory::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn store(root: &Path, memory: &AiMemory) -> Result<(), String> {
    let memory = normalize(memory)?;
    let raw = serde_json::to_string_pretty(&memory).map_err(|err| err.to_string())?;
    fs::write(root.join(MEMORY_FILE), raw)
        .map_err(|err| format!("could not save caption fixes: {err}"))
}

pub fn apply_corrections(text: &str, memory: &AiMemory) -> String {
    let mut items: Vec<&Correction> = memory.corrections.iter().collect();
    items.sort_by_key(|item| std::cmp::Reverse(item.heard.chars().count()));
    let mut spans: Vec<(usize, usize, &str)> = Vec::new();
    for item in items {
        let needle = item.heard.trim();
        if needle.is_empty() {
            continue;
        }
        let mut start = 0;
        while start < text.len() {
            if let Some(end) = matches_at(text, start, needle) {
                let before_ok = start == 0 || !is_word(prev_char(text, start));
                let after_ok =
                    end >= text.len() || !is_word(text[end..].chars().next().unwrap_or(' '));
                let overlaps = spans.iter().any(|(from, to, _)| start < *to && end > *from);
                if before_ok && after_ok && !overlaps {
                    spans.push((start, end, item.says.as_str()));
                }
            }
            let Some(ch) = text[start..].chars().next() else {
                break;
            };
            start += ch.len_utf8();
        }
    }
    spans.sort_by_key(|(start, _, _)| std::cmp::Reverse(*start));
    let mut out = text.to_string();
    for (start, end, says) in spans {
        out.replace_range(start..end, says);
    }
    out
}

pub fn prompt_from(memory: &AiMemory) -> String {
    let mut parts = Vec::new();
    let mut used = 0usize;
    for item in &memory.corrections {
        let phrase = item.says.trim();
        if phrase.is_empty() {
            continue;
        }
        if used + phrase.len() > 180 {
            break;
        }
        used += phrase.len() + 2;
        parts.push(phrase);
    }
    parts.join(", ")
}

pub fn reconcile<S: TokenStore>(
    service: &AuthService<S>,
    state: &AppState,
    root: &Path,
) -> Result<AiSyncOutcome, AuthError> {
    let server = state.auth.base_url.clone();
    if !state.auth.enabled {
        return Ok(local_outcome(root, &server, false, false, None));
    }
    let Some(user_id) = service.stored_user_id() else {
        return Err(AuthError::Message(
            "Sign in before syncing caption fixes.".into(),
        ));
    };
    drop_other_user(root, &user_id);
    let local = load(root);
    let (status, body) =
        service.authorized(&state.auth, reqwest::Method::GET, "/ai/memory", None)?;
    match status {
        404 => {
            if local.corrections.is_empty() {
                return Ok(local_outcome(root, &server, false, false, None));
            }
            put(service, state, root, &user_id, &local, None, false)
        }
        200 => {
            let stored = parse_stored(body)?;
            finish_remote(service, state, root, &user_id, &local, stored, false)
        }
        401 => Err(AuthError::Message("Session expired. Sign in again.".into())),
        _ => Err(AuthError::Message(
            "auth-server rejected the caption fixes.".into(),
        )),
    }
}

pub fn save<S: TokenStore>(
    service: &AuthService<S>,
    state: &AppState,
    root: &Path,
    memory: &AiMemory,
) -> Result<AiSyncOutcome, AuthError> {
    let memory = normalize(memory).map_err(AuthError::Message)?;
    if !state.auth.enabled {
        store(root, &memory).map_err(AuthError::Message)?;
        return Ok(local_outcome(
            root,
            &state.auth.base_url,
            false,
            false,
            None,
        ));
    }
    let user_id = service
        .stored_user_id()
        .ok_or_else(|| AuthError::Message("Sign in before syncing caption fixes.".into()))?;
    if read_cursor(root).is_some_and(|cursor| cursor.user_id != user_id) {
        clear_cursor(root);
    }
    store(root, &memory).map_err(AuthError::Message)?;
    reconcile(service, state, root)
}

fn finish_remote<S: TokenStore>(
    service: &AuthService<S>,
    state: &AppState,
    root: &Path,
    user_id: &str,
    local: &AiMemory,
    stored: Stored,
    already_retried: bool,
) -> Result<AiSyncOutcome, AuthError> {
    let server = state.auth.base_url.clone();
    if canonical(local) == canonical(&stored.memory) {
        write_cursor(root, user_id, stored.revision);
        let _ = store(root, &stored.memory);
        return Ok(AiSyncOutcome {
            memory: stored.memory,
            revision: Some(stored.revision),
            server,
            published: false,
            restored: false,
            message: None,
        });
    }
    let cursor = read_cursor(root);
    let edited_here = cursor
        .as_ref()
        .is_some_and(|item| item.user_id == user_id && item.revision == stored.revision);
    let next = if edited_here {
        local.clone()
    } else {
        merge(local, &stored.memory)
    };
    if canonical(&next) == canonical(&stored.memory) {
        write_cursor(root, user_id, stored.revision);
        let _ = store(root, &stored.memory);
        return Ok(AiSyncOutcome {
            memory: stored.memory,
            revision: Some(stored.revision),
            server,
            published: false,
            restored: true,
            message: Some("Restored caption fixes from this account.".into()),
        });
    }
    if already_retried {
        write_cursor(root, user_id, stored.revision);
        let _ = store(root, &stored.memory);
        return Ok(AiSyncOutcome {
            memory: stored.memory,
            revision: Some(stored.revision),
            server,
            published: false,
            restored: true,
            message: Some("Restored caption fixes from this account.".into()),
        });
    }
    put(
        service,
        state,
        root,
        user_id,
        &next,
        Some(stored.revision),
        true,
    )
}

fn put<S: TokenStore>(
    service: &AuthService<S>,
    state: &AppState,
    root: &Path,
    user_id: &str,
    memory: &AiMemory,
    revision: Option<u64>,
    merge_on_conflict: bool,
) -> Result<AiSyncOutcome, AuthError> {
    let memory = normalize(memory).map_err(AuthError::Message)?;
    let mut body = Map::new();
    body.insert(
        "revision".into(),
        revision.map(Value::from).unwrap_or(Value::Null),
    );
    body.insert(
        "document".into(),
        serde_json::to_value(&memory).map_err(|err| AuthError::Message(err.to_string()))?,
    );
    let (status, response) = service.authorized(
        &state.auth,
        reqwest::Method::PUT,
        "/ai/memory",
        Some(Value::Object(body)),
    )?;
    let server = state.auth.base_url.clone();
    match status {
        200 => {
            let stored = parse_stored(response)?;
            write_cursor(root, user_id, stored.revision);
            let _ = store(root, &stored.memory);
            Ok(AiSyncOutcome {
                memory: stored.memory,
                revision: Some(stored.revision),
                server,
                published: true,
                restored: false,
                message: None,
            })
        }
        409 => {
            let stored = parse_stored(response)?;
            if merge_on_conflict {
                finish_remote(service, state, root, user_id, &memory, stored, true)
            } else {
                write_cursor(root, user_id, stored.revision);
                let _ = store(root, &stored.memory);
                Ok(AiSyncOutcome {
                    memory: stored.memory,
                    revision: Some(stored.revision),
                    server,
                    published: false,
                    restored: true,
                    message: Some("Restored caption fixes from this account.".into()),
                })
            }
        }
        404 => Ok(AiSyncOutcome {
            memory,
            revision: None,
            server,
            published: false,
            restored: false,
            message: Some(
                "This server does not keep caption fixes yet. Update it, then try again.".into(),
            ),
        }),
        401 => Err(AuthError::Message("Session expired. Sign in again.".into())),
        _ => Err(AuthError::Message(
            "auth-server rejected the caption fixes.".into(),
        )),
    }
}

struct Stored {
    revision: u64,
    memory: AiMemory,
}

fn parse_stored(body: Option<Value>) -> Result<Stored, AuthError> {
    let body = body.ok_or_else(|| {
        AuthError::Message("auth-server returned caption fixes this app could not read.".into())
    })?;
    let revision = body
        .get("revision")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            AuthError::Message("auth-server returned caption fixes without a revision.".into())
        })?;
    let document = body.get("document").cloned().ok_or_else(|| {
        AuthError::Message("auth-server returned caption fixes this app could not read.".into())
    })?;
    let memory: AiMemory = serde_json::from_value(document).map_err(|_| {
        AuthError::Message("auth-server returned caption fixes this app could not read.".into())
    })?;
    normalize(&memory).map_err(AuthError::Message)?;
    Ok(Stored { revision, memory })
}

fn local_outcome(
    root: &Path,
    server: &str,
    published: bool,
    restored: bool,
    message: Option<String>,
) -> AiSyncOutcome {
    AiSyncOutcome {
        memory: load(root),
        revision: read_cursor(root).map(|cursor| cursor.revision),
        server: server.to_string(),
        published,
        restored,
        message,
    }
}

pub fn merge(local: &AiMemory, remote: &AiMemory) -> AiMemory {
    let mut by_heard: Vec<Correction> = remote.corrections.clone();
    for item in &local.corrections {
        let key = fold(&item.heard);
        if let Some(existing) = by_heard.iter_mut().find(|row| fold(&row.heard) == key) {
            if item.count > existing.count
                || (item.count == existing.count && item.says != existing.says)
            {
                *existing = item.clone();
            }
        } else {
            by_heard.push(item.clone());
        }
    }
    AiMemory {
        version: 1,
        corrections: sort_limit(by_heard),
    }
}

fn normalize(memory: &AiMemory) -> Result<AiMemory, String> {
    if memory.version != 1 {
        return Err("Caption fixes are the wrong version.".into());
    }
    let mut seen_ids = std::collections::BTreeSet::new();
    let mut seen_heard = std::collections::BTreeSet::new();
    let mut corrections = Vec::new();
    for item in &memory.corrections {
        let heard = clean_phrase(&item.heard)?;
        let says = clean_phrase(&item.says)?;
        if fold(&heard) == fold(&says) {
            return Err("Enter what was heard and what it should say.".into());
        }
        if item.id.is_empty()
            || item.id.len() > 64
            || !item
                .id
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
        {
            return Err("A caption fix has an id this server will not store.".into());
        }
        if !seen_ids.insert(item.id.clone()) || !seen_heard.insert(fold(&heard)) {
            return Err("Two caption fixes use the same phrase.".into());
        }
        if !(1..=1_000_000).contains(&item.count) {
            return Err("A caption fix has a bad count.".into());
        }
        corrections.push(Correction {
            id: item.id.clone(),
            heard,
            says,
            count: item.count,
        });
    }
    if corrections.len() > MAX_CORRECTIONS {
        return Err("Too many caption fixes to store.".into());
    }
    Ok(AiMemory {
        version: 1,
        corrections: sort_limit(corrections),
    })
}

fn clean_phrase(value: &str) -> Result<String, String> {
    let text = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() || text.chars().count() > MAX_PHRASE {
        return Err("Keep each phrase under 160 characters.".into());
    }
    if text.chars().any(char::is_control) || text.to_ascii_lowercase().contains("data:") {
        return Err("Caption fixes are text only. Audio stays on this computer.".into());
    }
    Ok(text)
}

fn sort_limit(mut items: Vec<Correction>) -> Vec<Correction> {
    items.sort_by(|left, right| fold(&left.heard).cmp(&fold(&right.heard)));
    items.truncate(MAX_CORRECTIONS);
    items
}

fn fold(value: &str) -> String {
    value.trim().to_lowercase()
}

fn canonical(memory: &AiMemory) -> String {
    serde_json::to_string(memory).unwrap_or_default()
}

fn matches_at(text: &str, start: usize, needle: &str) -> Option<usize> {
    let mut rest = text.get(start..)?.chars();
    let mut consumed = 0usize;
    for expected in needle.chars() {
        let actual = rest.next()?;
        let mut exp = expected.to_lowercase();
        let mut act = actual.to_lowercase();
        if exp.next() != act.next() || exp.next().is_some() || act.next().is_some() {
            return None;
        }
        consumed += actual.len_utf8();
    }
    Some(start + consumed)
}

fn prev_char(text: &str, start: usize) -> char {
    text[..start].chars().next_back().unwrap_or(' ')
}

fn is_word(ch: char) -> bool {
    ch.is_alphanumeric()
}

fn drop_other_user(root: &Path, user_id: &str) {
    if read_cursor(root).is_some_and(|cursor| cursor.user_id != user_id) {
        let _ = fs::remove_file(root.join(MEMORY_FILE));
        clear_cursor(root);
    }
}

fn read_cursor(root: &Path) -> Option<Cursor> {
    let raw = fs::read_to_string(root.join(CURSOR_FILE)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_cursor(root: &Path, user_id: &str, revision: u64) {
    let cursor = Cursor {
        user_id: user_id.to_string(),
        revision,
    };
    if let Ok(raw) = serde_json::to_string(&cursor) {
        let _ = fs::write(root.join(CURSOR_FILE), raw);
    }
}

fn clear_cursor(root: &Path) {
    let _ = fs::remove_file(root.join(CURSOR_FILE));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{AuthError, AuthService};
    use crate::config::{AppState, AuthSettings};
    use std::collections::BTreeMap;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn corrections_replace_whole_words_only() {
        let memory = AiMemory {
            version: 1,
            corrections: vec![
                Correction {
                    id: "c1".into(),
                    heard: "engine twelve".into(),
                    says: "Engine 12".into(),
                    count: 2,
                },
                Correction {
                    id: "c2".into(),
                    heard: "unit".into(),
                    says: "Engine 12".into(),
                    count: 1,
                },
            ],
        };
        assert_eq!(
            apply_corrections("Engine Twelve responding", &memory),
            "Engine 12 responding"
        );
        assert_eq!(
            apply_corrections("the unit is holding", &memory),
            "the Engine 12 is holding"
        );
        assert_eq!(
            apply_corrections("community meeting", &memory),
            "community meeting"
        );
    }

    #[test]
    fn merge_keeps_both_phrases_and_the_stronger_count() {
        let local = AiMemory {
            version: 1,
            corrections: vec![Correction {
                id: "local".into(),
                heard: "medic four".into(),
                says: "Medic 4".into(),
                count: 1,
            }],
        };
        let remote = AiMemory {
            version: 1,
            corrections: vec![Correction {
                id: "remote".into(),
                heard: "engine twelve".into(),
                says: "Engine 12".into(),
                count: 4,
            }],
        };
        let merged = merge(&local, &remote);
        assert_eq!(merged.corrections.len(), 2);
        let contested_local = AiMemory {
            version: 1,
            corrections: vec![Correction {
                id: "new".into(),
                heard: "engine twelve".into(),
                says: "Engine 12".into(),
                count: 1,
            }],
        };
        let kept = merge(&contested_local, &remote);
        assert_eq!(kept.corrections[0].id, "remote");
        assert_eq!(kept.corrections[0].count, 4);
    }

    #[derive(Clone, Default)]
    struct MemoryStore {
        values: Arc<Mutex<BTreeMap<String, String>>>,
    }

    impl TokenStore for MemoryStore {
        fn get(&self, key: &str) -> Result<Option<String>, AuthError> {
            Ok(self.values.lock().unwrap().get(key).cloned())
        }
        fn set(&self, key: &str, value: &str) -> Result<(), AuthError> {
            self.values
                .lock()
                .unwrap()
                .insert(key.to_string(), value.to_string());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), AuthError> {
            self.values.lock().unwrap().remove(key);
            Ok(())
        }
    }

    struct Fake {
        docs: Mutex<BTreeMap<String, (u64, Value)>>,
    }

    fn spawn_fake() -> (String, Arc<Fake>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let fake = Arc::new(Fake {
            docs: Mutex::new(BTreeMap::new()),
        });
        let serve = Arc::clone(&fake);
        thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut stream) = conn else { continue };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let Ok((method, path, headers, body)) = read_http(&mut stream) else {
                    continue;
                };
                let (status, payload) = dispatch(&serve, &method, &path, &headers, &body);
                let raw = payload.unwrap_or_default();
                let head = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
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
        if path != "/ai/memory" {
            return (404, Some(br#"{"error":"not_found"}"#.to_vec()));
        }
        let Some(user) = bearer_user(headers) else {
            return (401, Some(br#"{"error":"invalid_token"}"#.to_vec()));
        };
        let json: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
        let mut docs = fake.docs.lock().unwrap();
        match method {
            "GET" => match docs.get(&user) {
                Some((revision, document)) => (200, Some(doc_body(*revision, document, false))),
                None => (404, Some(br#"{"error":"not_found"}"#.to_vec())),
            },
            "PUT" => {
                let revision = json.get("revision").and_then(Value::as_u64);
                let Some(document) = json.get("document").cloned() else {
                    return (400, Some(br#"{"error":"bad_request"}"#.to_vec()));
                };
                match docs.get(&user).cloned() {
                    None if revision.is_none() => {
                        let raw = doc_body(1, &document, false);
                        docs.insert(user, (1, document));
                        (200, Some(raw))
                    }
                    Some((current, _)) if revision == Some(current) => {
                        let next = current + 1;
                        let raw = doc_body(next, &document, false);
                        docs.insert(user, (next, document));
                        (200, Some(raw))
                    }
                    Some((current, existing)) => (409, Some(doc_body(current, &existing, true))),
                    None => (404, Some(br#"{"error":"not_found"}"#.to_vec())),
                }
            }
            _ => (404, Some(br#"{"error":"not_found"}"#.to_vec())),
        }
    }

    fn doc_body(revision: u64, document: &Value, conflict: bool) -> Vec<u8> {
        let mut value = serde_json::json!({
            "revision": revision,
            "updatedAt": 1,
            "document": document,
        });
        if conflict {
            value["error"] = Value::String("conflict".into());
        }
        serde_json::to_vec(&value).unwrap()
    }

    fn bearer_user(headers: &[(String, String)]) -> Option<String> {
        let header = headers
            .iter()
            .find(|(key, _)| key == "authorization")?
            .1
            .as_str();
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
        };
        let header = String::from_utf8_lossy(&buf[..header_end]).to_string();
        let mut lines = header.split("\r\n");
        let mut parts = lines.next().unwrap_or("").split_whitespace();
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

    fn service() -> AuthService<MemoryStore> {
        let service = AuthService::with_store(MemoryStore::default());
        service.seed_session("ada", "ada", "ada.token");
        service
    }

    fn state(base: &str) -> AppState {
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

    fn sample(id: &str, heard: &str, says: &str, count: u64) -> AiMemory {
        AiMemory {
            version: 1,
            corrections: vec![Correction {
                id: id.into(),
                heard: heard.into(),
                says: says.into(),
                count,
            }],
        }
    }

    #[test]
    fn sync_publishes_to_the_signed_in_server_and_merges() {
        let (base, fake) = spawn_fake();
        let root = std::env::temp_dir().join(format!(
            "cc-ai-sync-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let auth = service();
        let app = state(&base);
        let saved = save(
            &auth,
            &app,
            &root,
            &sample("c1", "engine twelve", "Engine 12", 1),
        )
        .unwrap();
        assert!(saved.published);
        assert_eq!(saved.revision, Some(1));
        assert!(saved.server.starts_with("http://127.0.0.1:"));
        let stored = fake.docs.lock().unwrap().get("ada").unwrap().1.to_string();
        assert!(stored.contains("Engine 12"));
        assert!(!stored.contains("data:"));

        fake.docs.lock().unwrap().insert(
            "ada".into(),
            (
                2,
                serde_json::to_value(sample("remote", "medic four", "Medic 4", 3)).unwrap(),
            ),
        );
        let merged = reconcile(&auth, &app, &root).unwrap();
        assert!(merged.published);
        assert_eq!(merged.memory.corrections.len(), 2);
        let _ = fs::remove_dir_all(root);
    }
}
