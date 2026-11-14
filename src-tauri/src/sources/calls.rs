//! Broadcastify Calls Client API (`https://api.bcfy.io/calls/v1/live/`).
//!
//! Separate from the Feed Owner API. Auth is an HS256 JWT: `kid` in the header,
//! `iss` / `iat` / `exp` in the payload, signed with the app secret from the OS keyring.
//! The live endpoint returns individual call clips. A continuous playlist player is not
//! implemented here.

use crate::config::SourceConfig;
use crate::sources::incident::{Incident, IncidentSeverity};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

const LIVE_URL: &str = "https://api.bcfy.io/calls/v1/live/";
const SECRET_NAME: &str = "broadcastify.calls.secret";
const JWT_TTL_SECS: i64 = 3600;

#[derive(Debug, Clone)]
pub struct FetchResult {
    pub incidents: Vec<Incident>,
    pub attribution: String,
    pub fetched_at: String,
    pub note: Option<String>,
}

pub fn fetch(
    source: &SourceConfig,
    secrets: &BTreeMap<String, String>,
) -> Result<FetchResult, super::SourceError> {
    let key_id = required_param(source, "keyId", "Key ID")?;
    let issuer = required_param(source, "issuer", "Issuer")?;
    validate_app_id(&key_id, "Key ID")?;
    validate_app_id(&issuer, "Issuer")?;
    let secret = secrets
        .get(SECRET_NAME)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            super::SourceError::Message(
                "Broadcastify Calls signing secret missing (secret broadcastify.calls.secret — OS keyring)"
                    .into(),
            )
        })?;

    let selector = param_str(source, "selector").unwrap_or_else(|| "system".into());
    let selector_id = required_param(source, "selectorId", "Selector")?;
    let query = live_query(&selector, &selector_id)?;
    let limit = param_u32(source, "limit").unwrap_or(40).clamp(1, 100);

    let now = chrono::Utc::now().timestamp();
    let token = sign_jwt(&key_id, &issuer, secret, now, now + JWT_TTL_SECS);

    let client = reqwest::blocking::Client::builder()
        .user_agent(
            "CommandCenter/0.1 (personal calls client; +https://github.com/nlaero/CommandCenter)",
        )
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    let response = client
        .get(LIVE_URL)
        .query(&query)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .send()
        .map_err(|err| {
            super::SourceError::Message(format!(
                "Broadcastify Calls request failed: {}",
                sanitize(&err.without_url().to_string(), secret, &token)
            ))
        })?;

    let status = response.status();
    let text = response.text().map_err(|err| {
        super::SourceError::Message(format!(
            "Broadcastify Calls read failed: {}",
            sanitize(&err.without_url().to_string(), secret, &token)
        ))
    })?;
    if !status.is_success() {
        return Err(super::SourceError::Message(format!(
            "Broadcastify Calls HTTP {status}: {}",
            sanitize(&truncate(&text, 180), secret, &token)
        )));
    }

    let value: Value = serde_json::from_str(text.trim()).map_err(|err| {
        super::SourceError::Message(format!(
            "Broadcastify Calls JSON parse error: {err} ({})",
            sanitize(&truncate(text.trim(), 120), secret, &token)
        ))
    })?;
    if let Some(message) = api_error(&value) {
        return Err(super::SourceError::Message(format!(
            "Broadcastify Calls API error: {}",
            sanitize(&message, secret, &token)
        )));
    }

    let mut incidents = parse_calls(&value)?;
    let returned = incidents.len();
    incidents.truncate(limit as usize);
    let note = if incidents.is_empty() {
        Some(
            "No call clips in this window. The Calls API returns individual clips, not a live playlist. Each refresh is a metered read."
                .into(),
        )
    } else if returned > incidents.len() {
        Some(format!(
            "Showing the newest {} of {returned} call clips. Playback starts muted. A live playlist is not played. Each refresh is a metered read.",
            incidents.len()
        ))
    } else {
        Some(
            "Call clips from the Calls API. Playback starts muted. A live playlist is not played. Each refresh is a metered read."
                .into(),
        )
    };

    Ok(FetchResult {
        incidents,
        attribution: "Broadcastify Calls".into(),
        fetched_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        note,
    })
}

#[derive(Serialize)]
struct JwtHeader<'a> {
    alg: &'a str,
    typ: &'a str,
    kid: &'a str,
}

#[derive(Serialize)]
struct JwtClaims<'a> {
    iss: &'a str,
    iat: i64,
    exp: i64,
}

pub fn sign_jwt(key_id: &str, issuer: &str, secret: &str, iat: i64, exp: i64) -> String {
    let header = JwtHeader {
        alg: "HS256",
        typ: "JWT",
        kid: key_id,
    };
    let claims = JwtClaims {
        iss: issuer,
        iat,
        exp,
    };
    let encoded_header = b64url(&serde_json::to_vec(&header).expect("jwt header"));
    let encoded_claims = b64url(&serde_json::to_vec(&claims).expect("jwt claims"));
    let signing_input = format!("{encoded_header}.{encoded_claims}");
    let signature = hmac_sha256(secret.as_bytes(), signing_input.as_bytes());
    format!("{signing_input}.{}", b64url(&signature))
}

fn live_query(
    selector: &str,
    selector_id: &str,
) -> Result<Vec<(String, String)>, super::SourceError> {
    let id = selector_id.trim();
    if id.is_empty() || id.len() > 200 {
        return Err(super::SourceError::Message("Selector is required".into()));
    }
    match selector.trim() {
        "system" => {
            require_digits(id, "System id")?;
            Ok(vec![("sid".into(), id.to_string())])
        }
        "node" => {
            require_digits(id, "Node id")?;
            Ok(vec![
                ("nodeId".into(), id.to_string()),
                ("init".into(), "1".into()),
            ])
        }
        "groups" => {
            let groups = parse_groups(id)?;
            let mut query = vec![("groups".into(), groups.join(","))];
            if groups.len() == 1 {
                query.push(("init".into(), "1".into()));
            }
            Ok(query)
        }
        other => Err(super::SourceError::Message(format!(
            "Unknown Calls selector: {other}"
        ))),
    }
}

fn parse_groups(raw: &str) -> Result<Vec<String>, super::SourceError> {
    let groups: Vec<String> = raw
        .split(',')
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect();
    if !(1..=5).contains(&groups.len()) {
        return Err(super::SourceError::Message(
            "Select between 1 and 5 groups".into(),
        ));
    }
    for group in &groups {
        let conventional = group.starts_with("c-")
            && group[2..].chars().all(|ch| ch.is_ascii_digit())
            && group.len() > 2;
        let trunked = group.split_once('-').is_some_and(|(sid, tg)| {
            !sid.is_empty()
                && !tg.is_empty()
                && sid.chars().all(|ch| ch.is_ascii_digit())
                && tg.chars().all(|ch| ch.is_ascii_digit())
        });
        if !conventional && !trunked {
            return Err(super::SourceError::Message(format!(
                "Group id must look like sid-talkgroup or c-frequency ({group})"
            )));
        }
    }
    Ok(groups)
}

fn parse_calls(body: &Value) -> Result<Vec<Incident>, super::SourceError> {
    let rows = body
        .get("calls")
        .and_then(|v| v.as_array())
        .or_else(|| body.as_array());
    let Some(rows) = rows else {
        return Err(super::SourceError::Message(
            "Broadcastify Calls response missing calls".into(),
        ));
    };
    let mut incidents: Vec<Incident> = rows.iter().filter_map(call_incident).collect();
    incidents.sort_by(|a, b| b.occurred_at.cmp(&a.occurred_at).then(b.id.cmp(&a.id)));
    Ok(incidents)
}

fn call_incident(row: &Value) -> Option<Incident> {
    if !row.is_object() {
        return None;
    }
    let group_id = str_field(row, &["groupId", "group_id"]);
    let ts = num_field(row, &["ts", "start_ts"]);
    let id = match (group_id.as_deref(), ts) {
        (Some(group), Some(stamp)) => format!("{group}-{}", stamp as i64),
        (Some(group), None) => group.to_string(),
        (None, Some(stamp)) => format!("call-{}", stamp as i64),
        (None, None) => return None,
    };
    let display = str_field(row, &["display", "name"]);
    let descr = str_field(row, &["descr", "description"]);
    let grouping = str_field(row, &["grouping"]);
    let title = display
        .clone()
        .or_else(|| descr.clone())
        .or_else(|| group_id.clone())
        .unwrap_or_else(|| "Call".into());
    let mut details: Vec<String> = Vec::new();
    if let Some(text) = descr {
        if text != title {
            details.push(text);
        }
    }
    if let Some(text) = grouping.clone() {
        if text != title {
            details.push(text);
        }
    }
    if let Some(group) = group_id.clone() {
        details.push(format!("Group {group}"));
    }
    if let Some(duration) = num_field(row, &["duration", "callDuration"]) {
        details.push(format_duration(duration));
    }
    if let Some(freq) = num_field(row, &["freq", "frequency"]) {
        details.push(format_mhz(freq));
    }
    if let Some(src) = str_field(row, &["src", "source"])
        .or_else(|| num_field(row, &["src", "source"]).map(|n| format!("{}", n as i64)))
    {
        details.push(format!("Source {src}"));
    }
    let occurred = num_field(row, &["start_ts", "ts"]).and_then(unix_rfc3339);
    let audio = str_field(row, &["url", "audioUrl", "audio"]).filter(|url| {
        let lower = url.to_ascii_lowercase();
        lower.starts_with("https://") && !lower.contains("javascript:")
    });
    Some(Incident {
        id,
        title,
        category: Some("call".into()),
        description: if details.is_empty() {
            None
        } else {
            Some(details.join(" · "))
        },
        occurred_at: occurred,
        address: grouping.or(group_id),
        lat: None,
        lon: None,
        audio_url: audio,
        detail_url: None,
        severity: IncidentSeverity::Info,
    })
}

fn format_mhz(freq: f64) -> String {
    let rounded = (freq * 10_000.0).round() / 10_000.0;
    let text = format!("{rounded:.4}");
    let trimmed = text.trim_end_matches('0').trim_end_matches('.');
    format!("{trimmed} MHz")
}

fn format_duration(seconds: f64) -> String {
    if (seconds - seconds.round()).abs() < 0.05 {
        format!("{}s", seconds.round() as i64)
    } else {
        format!("{seconds:.1}s")
    }
}

fn unix_rfc3339(seconds: f64) -> Option<String> {
    if !seconds.is_finite() {
        return None;
    }
    chrono::DateTime::from_timestamp(seconds as i64, 0)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

fn api_error(body: &Value) -> Option<String> {
    for key in ["error", "Error", "message"] {
        if let Some(text) = body.get(key).and_then(|v| v.as_str()) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn required_param(
    source: &SourceConfig,
    key: &str,
    label: &str,
) -> Result<String, super::SourceError> {
    param_str(source, key)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| super::SourceError::Message(format!("{label} is required")))
}

fn param_str(source: &SourceConfig, key: &str) -> Option<String> {
    source.params.get(key).and_then(|v| match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}

fn param_u32(source: &SourceConfig, key: &str) -> Option<u32> {
    source.params.get(key).and_then(|v| match v {
        Value::Number(n) => n.as_u64().map(|n| n as u32),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    })
}

fn validate_app_id(value: &str, label: &str) -> Result<(), super::SourceError> {
    let ok = !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-');
    if ok {
        Ok(())
    } else {
        Err(super::SourceError::Message(format!(
            "{label} has an unexpected shape"
        )))
    }
}

fn require_digits(value: &str, label: &str) -> Result<(), super::SourceError> {
    if !value.is_empty() && value.chars().all(|ch| ch.is_ascii_digit()) {
        Ok(())
    } else {
        Err(super::SourceError::Message(format!(
            "{label} must be numeric"
        )))
    }
}

fn str_field(row: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(text) = row.get(*key).and_then(|v| v.as_str()) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn num_field(row: &Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        let Some(value) = row.get(*key) else {
            continue;
        };
        if let Some(n) = value.as_f64() {
            if n.is_finite() {
                return Some(n);
            }
        }
        if let Some(text) = value.as_str() {
            if let Ok(n) = text.trim().parse::<f64>() {
                if n.is_finite() {
                    return Some(n);
                }
            }
        }
    }
    None
}

fn sanitize(text: &str, secret: &str, token: &str) -> String {
    let mut out = text.to_string();
    if secret.len() >= 4 {
        out = out.replace(secret, "[redacted]");
    }
    if token.len() >= 8 {
        out = out.replace(token, "[redacted]");
    }
    out
}

fn truncate(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        out.push('…');
    }
    out
}

fn b64url(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | bytes[i + 2] as u32;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push(TABLE[(n & 63) as usize] as char);
        i += 3;
    }
    if i < bytes.len() {
        let remain = bytes.len() - i;
        let mut n = (bytes[i] as u32) << 16;
        if remain == 2 {
            n |= (bytes[i + 1] as u32) << 8;
        }
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        if remain == 2 {
            out.push(TABLE[((n >> 6) & 63) as usize] as char);
        }
    }
    out
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut keyed = [0u8; 64];
    if key.len() > 64 {
        let hashed = Sha256::digest(key);
        keyed[..hashed.len()].copy_from_slice(&hashed);
    } else {
        keyed[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= keyed[i];
        opad[i] ^= keyed[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(message);
    let inner_hash = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_hash);
    let digest = outer.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SourceConfig;
    use serde_json::json;

    #[test]
    fn jwt_matches_hs256_kid_iss_vector() {
        let token = sign_jwt("test-kid", "test-iss", "test-secret", 1000, 4600);
        assert_eq!(
            token,
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InRlc3Qta2lkIn0.eyJpc3MiOiJ0ZXN0LWlzcyIsImlhdCI6MTAwMCwiZXhwIjo0NjAwfQ.W--bYA2voNjtfiErhtqNcejrcKk9d-ZQNKnebb37wAw"
        );
        assert!(!token.contains("test-secret"));
    }

    #[test]
    fn error_text_drops_the_signing_secret_and_token() {
        let secret = "desk-signing-secret";
        let token = sign_jwt("kid", "iss", secret, 1000, 4600);
        let shown = sanitize(
            &format!("HTTP 401 token={token} secret={secret}"),
            secret,
            &token,
        );
        assert!(!shown.contains(secret), "{shown}");
        assert!(!shown.contains(&token), "{shown}");
        assert!(shown.contains("[redacted]"));
    }

    #[test]
    fn live_query_uses_one_selector() {
        assert_eq!(
            live_query("system", "12573").unwrap(),
            vec![("sid".to_string(), "12573".to_string())]
        );
        assert_eq!(
            live_query("groups", "2-3416").unwrap(),
            vec![
                ("groups".to_string(), "2-3416".to_string()),
                ("init".to_string(), "1".to_string())
            ]
        );
        assert_eq!(
            live_query("groups", "2-3416, c-223312").unwrap(),
            vec![("groups".to_string(), "2-3416,c-223312".to_string())]
        );
        assert!(live_query("groups", "2-1,2-2,2-3,2-4,2-5,2-6").is_err());
        assert!(live_query("system", "abc").is_err());
        assert!(live_query("playlist", "uuid").is_err());
    }

    #[test]
    fn parse_keeps_newest_https_clips_and_drops_other_urls() {
        let body = json!({
            "calls": [
                {
                    "groupId": "2-10",
                    "ts": 100,
                    "start_ts": 100,
                    "display": "Older",
                    "descr": "Older detail",
                    "grouping": "City",
                    "duration": 4,
                    "freq": 852.1625,
                    "src": 42,
                    "url": "https://calls.broadcastify.com/older.mp3"
                },
                {
                    "groupId": "2-11",
                    "ts": 300,
                    "start_ts": 300,
                    "display": "Newer",
                    "descr": "Newer",
                    "duration": 2.5,
                    "url": "http://calls.broadcastify.com/not-https.mp3"
                }
            ],
            "lastPos": 300
        });
        let mut incidents = parse_calls(&body).unwrap();
        assert_eq!(incidents.len(), 2);
        incidents.truncate(1);
        assert_eq!(incidents[0].id, "2-11-300");
        assert_eq!(incidents[0].title, "Newer");
        assert!(incidents[0].audio_url.is_none());
        let all = parse_calls(&body).unwrap();
        let older = all.iter().find(|item| item.id == "2-10-100").unwrap();
        assert_eq!(
            older.audio_url.as_deref(),
            Some("https://calls.broadcastify.com/older.mp3")
        );
        assert!(older
            .description
            .as_deref()
            .unwrap()
            .contains("Older detail"));
        assert!(older
            .description
            .as_deref()
            .unwrap()
            .contains("852.1625 MHz"));
        assert!(older.description.as_deref().unwrap().contains("4s"));
        assert_eq!(older.occurred_at.as_deref(), Some("1970-01-01T00:01:40Z"));
    }

    #[test]
    fn missing_secret_names_the_keyring_slot_only() {
        let mut params = BTreeMap::new();
        params.insert("keyId".into(), json!("kid"));
        params.insert("issuer".into(), json!("iss"));
        params.insert("selector".into(), json!("system"));
        params.insert("selectorId".into(), json!("2"));
        let source = SourceConfig {
            type_id: "broadcastify.calls".into(),
            params,
            refresh: None,
            secrets: vec![SECRET_NAME.into()],
            enabled: true,
            draft: false,
        };
        let err = fetch(&source, &BTreeMap::new()).unwrap_err().to_string();
        assert!(err.contains(SECRET_NAME), "{err}");
        assert!(!err.contains("test-secret"));
    }
}
