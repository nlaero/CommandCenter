//! Broadcastify Feed Owner API (`https://api.broadcastify.com/owner/`).
//!
//! Personal use for the feed owner only. Archives may not be redistributed.
//! Does not implement Catalog ($2500) or Calls commercial APIs.

use crate::config::SourceConfig;
use crate::sources::incident::{Incident, IncidentSeverity};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

const OWNER_API: &str = "https://api.broadcastify.com/owner/";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FeedStatus {
    pub feed_id: String,
    pub online: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listeners: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub descr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitrate: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mount: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lat: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lon: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub county: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FetchResult {
    pub feed: FeedStatus,
    pub incidents: Vec<Incident>,
    pub attribution: String,
    pub fetched_at: String,
    pub note: Option<String>,
}

pub fn fetch(
    source: &SourceConfig,
    secrets: &BTreeMap<String, String>,
    overrides: &BTreeMap<String, Value>,
) -> Result<FetchResult, super::SourceError> {
    let feed_id = param_str(source, "feedId")
        .or_else(|| override_str(overrides, "feedId"))
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| super::SourceError::Message("feedId is required".into()))?;

    let username = secrets
        .get("broadcastify.username")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            super::SourceError::Message(
                "Broadcastify username missing (secret broadcastify.username)".into(),
            )
        })?;
    let password = secrets
        .get("broadcastify.password")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            super::SourceError::Message(
                "Broadcastify password missing (secret broadcastify.password — OS keyring)".into(),
            )
        })?;

    let include_archives = param_bool(source, "includeArchives").unwrap_or(true);
    let archive_day = override_str(overrides, "archiveDay")
        .or_else(|| param_str(source, "archiveDay"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    if let Some(day) = &archive_day {
        validate_day(day)?;
    }

    let client = reqwest::blocking::Client::builder()
        .user_agent("CommandCenter/0.1 (personal feed-owner; +https://github.com/nlaero/CommandCenter)")
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    let feed_body = owner_get(
        &client,
        &[
            ("a", "feed"),
            ("type", "json"),
            ("feedId", feed_id.as_str()),
            ("u", username),
            ("p", password),
        ],
    )?;
    let feed = parse_feed(&feed_body, &feed_id)?;

    let mut incidents = Vec::new();
    // Lead with a status row so the panel list always has a primary alert.
    incidents.push(status_incident(&feed));

    let mut note = Some(
        "Feed Owner API — personal use only. Archives must not be redistributed or used commercially."
            .into(),
    );

    if include_archives {
        let mut archive_params: Vec<(&str, &str)> = vec![
            ("a", "archives"),
            ("type", "json"),
            ("feedId", feed_id.as_str()),
            ("u", username),
            ("p", password),
        ];
        if let Some(day) = &archive_day {
            archive_params.push(("day", day.as_str()));
        }
        let archive_body = owner_get(&client, &archive_params)?;
        let archive_items = parse_archives(&archive_body, archive_day.as_deref())?;
        if archive_day.is_none() {
            note = Some(
                "Archive date listing (personal use). Pick a day (YYYY-MM-DD) to load clip URLs."
                    .into(),
            );
        } else if archive_items.is_empty() {
            note = Some(format!(
                "No archive clips returned for {}. Archives are personal-use only.",
                archive_day.as_deref().unwrap_or("")
            ));
        }
        incidents.extend(archive_items);
    }

    let attribution = format!("Broadcastify Feed Owner · feed {}", feed.feed_id);
    Ok(FetchResult {
        feed,
        incidents,
        attribution,
        fetched_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        note,
    })
}

fn owner_get(
    client: &reqwest::blocking::Client,
    params: &[(&str, &str)],
) -> Result<Value, super::SourceError> {
    let response = client
        .get(OWNER_API)
        .query(params)
        .send()
        .map_err(|e| {
            super::SourceError::Message(format!(
                "Broadcastify request failed: {}",
                e.without_url()
            ))
        })?;

    let status = response.status();
    let text = response
        .text()
        .map_err(|e| super::SourceError::Message(format!("read body: {e}")))?;

    if !status.is_success() {
        return Err(super::SourceError::Message(format!(
            "Broadcastify HTTP {status}: {}",
            truncate(&text, 180)
        )));
    }

    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(super::SourceError::Message(
            "Broadcastify returned an empty body".into(),
        ));
    }
    if trimmed.starts_with("ERROR:") || trimmed.starts_with("Error:") {
        return Err(super::SourceError::Message(trimmed.to_string()));
    }

    let value: Value = serde_json::from_str(trimmed).map_err(|e| {
        super::SourceError::Message(format!(
            "Broadcastify JSON parse error: {e} ({})",
            truncate(trimmed, 120)
        ))
    })?;

    if let Some(err) = value.get("error").and_then(|v| v.as_str()) {
        return Err(super::SourceError::Message(format!(
            "Broadcastify API error: {err}"
        )));
    }
    if let Some(err) = value.get("Error").and_then(|v| v.as_str()) {
        return Err(super::SourceError::Message(format!(
            "Broadcastify API error: {err}"
        )));
    }

    Ok(value)
}

pub fn parse_feed(body: &Value, fallback_id: &str) -> Result<FeedStatus, super::SourceError> {
    let row = body
        .get("Feed")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .or_else(|| body.get("feed"))
        .or_else(|| body.as_object().map(|_| body))
        .ok_or_else(|| {
            super::SourceError::Message("Feed Owner response missing Feed object".into())
        })?;

    if row.get("error").is_some() {
        return Err(super::SourceError::Message(format!(
            "Broadcastify API error: {}",
            row.get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
        )));
    }

    let id = str_field(row, &["id", "feedId", "feed_id"])
        .unwrap_or_else(|| fallback_id.to_string());
    let status_num = num_field(row, &["status"]).map(|n| n as i64);
    let online = match status_num {
        Some(0) => false,
        Some(_) => true,
        None => str_field(row, &["status"])
            .map(|s| {
                let t = s.to_ascii_lowercase();
                t == "1" || t == "online" || t == "up" || t == "true"
            })
            .unwrap_or(false),
    };

    let (lat, lon, county, state) = county_geo(row);

    Ok(FeedStatus {
        feed_id: id,
        online,
        listeners: num_field(row, &["listeners", "listenerCount"]).map(|n| n as u32),
        descr: str_field(row, &["descr", "description", "name", "title"]),
        genre: str_field(row, &["genre", "category"]),
        bitrate: num_field(row, &["bitrate"]).map(|n| n as u32),
        mount: str_field(row, &["mount"]),
        lat,
        lon,
        county,
        state,
    })
}

fn county_geo(row: &Value) -> (Option<f64>, Option<f64>, Option<String>, Option<String>) {
    let county_row = row
        .get("Counties")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .or_else(|| row.get("counties").and_then(|v| v.as_array()).and_then(|a| a.first()));

    let lat = num_field(row, &["lat", "latitude"]).or_else(|| {
        county_row.and_then(|c| num_field(c, &["lat", "latitude"]))
    });
    let lon = num_field(row, &["lon", "lng", "longitude"]).or_else(|| {
        county_row.and_then(|c| num_field(c, &["lon", "lng", "longitude"]))
    });
    let county = county_row.and_then(|c| str_field(c, &["name", "county"]));
    let state = county_row.and_then(|c| str_field(c, &["stateName", "stateCode", "state"]));
    (lat, lon, county, state)
}

pub fn parse_archives(
    body: &Value,
    day: Option<&str>,
) -> Result<Vec<Incident>, super::SourceError> {
    // Day listing: dates only (no clip URLs yet).
    if day.is_none() {
        let dates = extract_dates(body);
        if !dates.is_empty() {
            let mut out: Vec<Incident> = dates
                .into_iter()
                .enumerate()
                .map(|(i, d)| Incident {
                    id: format!("archive-day-{d}"),
                    title: format!("Archives · {d}"),
                    category: Some("archive-day".into()),
                    description: Some(
                        "Select this day in Settings (archiveDay) or the panel date control to load clip URLs."
                            .into(),
                    ),
                    occurred_at: Some(format!("{d}T00:00:00Z")),
                    address: None,
                    lat: None,
                    lon: None,
                    audio_url: None,
                    detail_url: None,
                    severity: if i == 0 {
                        IncidentSeverity::Warn
                    } else {
                        IncidentSeverity::Info
                    },
                })
                .collect();
            out.sort_by(|a, b| b.occurred_at.cmp(&a.occurred_at));
            return Ok(out);
        }
    }

    let rows = extract_archive_rows(body);
    let mut out = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        if let Some(incident) = archive_row_incident(row, i, day) {
            out.push(incident);
        }
    }
    out.sort_by(|a, b| b.occurred_at.cmp(&a.occurred_at));
    Ok(out)
}

fn extract_dates(body: &Value) -> Vec<String> {
    let mut dates = Vec::new();

    let push_date = |dates: &mut Vec<String>, s: &str| {
        let t = s.trim();
        if looks_like_day(t) && !dates.iter().any(|d| d == t) {
            dates.push(t.to_string());
        }
    };

    for key in ["Archives", "Archive", "Dates", "dates", "Days", "days"] {
        if let Some(arr) = body.get(key).and_then(|v| v.as_array()) {
            for item in arr {
                if let Some(s) = item.as_str() {
                    push_date(&mut dates, s);
                } else if let Some(s) = str_field(item, &["date", "day", "Date", "Day"]) {
                    push_date(&mut dates, &s);
                }
            }
        }
    }

    if let Some(arr) = body.as_array() {
        for item in arr {
            if let Some(s) = item.as_str() {
                push_date(&mut dates, s);
            } else if let Some(s) = str_field(item, &["date", "day", "Date", "Day"]) {
                push_date(&mut dates, &s);
            }
        }
    }

    dates
}

fn extract_archive_rows(body: &Value) -> Vec<Value> {
    for key in ["Archives", "Archive", "archives", "Files", "files", "Clips", "clips"] {
        if let Some(arr) = body.get(key).and_then(|v| v.as_array()) {
            return arr.clone();
        }
    }
    if let Some(arr) = body.as_array() {
        return arr.clone();
    }
    Vec::new()
}

fn archive_row_incident(row: &Value, index: usize, day: Option<&str>) -> Option<Incident> {
    // Pure date rows (when day listing nested oddly).
    if let Some(d) = str_field(row, &["date", "day", "Date", "Day"]) {
        if looks_like_day(&d)
            && str_field(
                row,
                &["url", "URL", "link", "download", "downloadUrl", "path", "file"],
            )
            .is_none()
        {
            return Some(Incident {
                id: format!("archive-day-{d}"),
                title: format!("Archives · {d}"),
                category: Some("archive-day".into()),
                description: Some(
                    "Set archiveDay to this date to load personal-use clip URLs.".into(),
                ),
                occurred_at: Some(format!("{d}T00:00:00Z")),
                address: None,
                lat: None,
                lon: None,
                audio_url: None,
                detail_url: None,
                severity: IncidentSeverity::Info,
            });
        }
    }

    let start = str_field(
        row,
        &[
            "start",
            "startTime",
            "start_time",
            "begin",
            "ts",
            "timestamp",
            "timeframe",
            "from",
        ],
    );
    let end = str_field(
        row,
        &["end", "endTime", "end_time", "finish", "to", "until"],
    );
    let url = str_field(
        row,
        &[
            "url",
            "URL",
            "link",
            "download",
            "downloadUrl",
            "download_url",
            "path",
            "file",
            "mp3",
            "src",
        ],
    );

    // Some payloads nest the link.
    let url = url.or_else(|| {
        row.get("File")
            .and_then(|f| str_field(f, &["url", "URL", "path", "link"]))
    });

    let title = match (&start, &end) {
        (Some(s), Some(e)) => format!("Archive {s} – {e}"),
        (Some(s), None) => format!("Archive {s}"),
        _ => str_field(row, &["title", "name", "descr", "filename"])
            .unwrap_or_else(|| format!("Archive clip {}", index + 1)),
    };

    let occurred = start
        .clone()
        .or_else(|| day.map(|d| format!("{d}T00:00:00Z")))
        .or_else(|| str_field(row, &["date", "day"]));

    // Skip empty shells.
    if url.is_none() && start.is_none() && end.is_none() {
        return None;
    }

    let id = str_field(row, &["id", "archiveId", "fileId", "filename"])
        .or_else(|| url.clone())
        .unwrap_or_else(|| format!("archive-{index}"));

    Some(Incident {
        id,
        title,
        category: Some("archive".into()),
        description: end.map(|e| format!("Ends {e}")),
        occurred_at: occurred,
        address: day.map(|d| d.to_string()),
        lat: None,
        lon: None,
        audio_url: url.clone(),
        detail_url: url,
        severity: IncidentSeverity::Info,
    })
}

fn status_incident(feed: &FeedStatus) -> Incident {
    let title = feed
        .descr
        .clone()
        .unwrap_or_else(|| format!("Feed {}", feed.feed_id));
    let severity = if feed.online {
        IncidentSeverity::Info
    } else {
        IncidentSeverity::Alert
    };
    let listeners = feed
        .listeners
        .map(|n| format!("{n} listeners"))
        .unwrap_or_else(|| "listeners n/a".into());
    let location = match (&feed.county, &feed.state) {
        (Some(c), Some(s)) => Some(format!("{c}, {s}")),
        (Some(c), None) => Some(c.clone()),
        (None, Some(s)) => Some(s.clone()),
        _ => None,
    };
    Incident {
        id: format!("feed-status-{}", feed.feed_id),
        title: if feed.online {
            format!("Online · {title}")
        } else {
            format!("Offline · {title}")
        },
        category: feed.genre.clone().or_else(|| Some("feed-status".into())),
        description: Some(format!(
            "{listeners}{}",
            feed.bitrate
                .map(|b| format!(" · {b} kbps"))
                .unwrap_or_default()
        )),
        occurred_at: Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
        address: location,
        lat: feed.lat,
        lon: feed.lon,
        audio_url: None,
        detail_url: Some(format!(
            "https://www.broadcastify.com/listen/feed/{}",
            feed.feed_id
        )),
        severity,
    }
}

fn validate_day(day: &str) -> Result<(), super::SourceError> {
    if looks_like_day(day) {
        Ok(())
    } else {
        Err(super::SourceError::Message(
            "archiveDay must be YYYY-MM-DD".into(),
        ))
    }
}

fn looks_like_day(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b[0..4].iter().all(|c| c.is_ascii_digit())
        && b[5..7].iter().all(|c| c.is_ascii_digit())
        && b[8..10].iter().all(|c| c.is_ascii_digit())
}

fn param_str(source: &SourceConfig, key: &str) -> Option<String> {
    source.params.get(key).and_then(value_to_string)
}

fn override_str(overrides: &BTreeMap<String, Value>, key: &str) -> Option<String> {
    overrides.get(key).and_then(value_to_string)
}

fn param_bool(source: &SourceConfig, key: &str) -> Option<bool> {
    source.params.get(key).and_then(|v| match v {
        Value::Bool(b) => Some(*b),
        Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        },
        Value::Number(n) => n.as_i64().map(|x| x != 0),
        _ => None,
    })
}

fn value_to_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn str_field(row: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(v) = row.get(*key) {
            match v {
                Value::String(s) if !s.trim().is_empty() => return Some(s.clone()),
                Value::Number(n) => return Some(n.to_string()),
                Value::Bool(b) => return Some(b.to_string()),
                _ => {}
            }
        }
    }
    None
}

fn num_field(row: &Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(v) = row.get(*key) {
            match v {
                Value::Number(n) => return n.as_f64(),
                Value::String(s) => {
                    if let Ok(n) = s.parse::<f64>() {
                        return Some(n);
                    }
                }
                _ => {}
            }
        }
    }
    None
}

fn truncate(s: &str, max: usize) -> String {
    let mut t = s.chars().take(max).collect::<String>();
    if s.chars().count() > max {
        t.push('…');
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_feed_status_online() {
        let body = json!({
            "Feed": [{
                "id": 14693,
                "status": 1,
                "listeners": 12,
                "descr": "Franklin County Fire and EMS Dispatch 1",
                "genre": "Public Safety",
                "mount": "/136068518",
                "bitrate": 16,
                "Counties": [{
                    "name": "Franklin",
                    "stateName": "Massachusetts",
                    "lat": "42.582748",
                    "lon": "-72.606354"
                }]
            }]
        });
        let feed = parse_feed(&body, "14693").unwrap();
        assert!(feed.online);
        assert_eq!(feed.listeners, Some(12));
        assert_eq!(feed.county.as_deref(), Some("Franklin"));
        assert_eq!(feed.lat, Some(42.582748));
    }

    #[test]
    fn parses_feed_offline() {
        let body = json!({ "Feed": [{ "id": "9", "status": 0, "descr": "Test" }] });
        let feed = parse_feed(&body, "9").unwrap();
        assert!(!feed.online);
    }

    #[test]
    fn parses_archive_date_listing() {
        let body = json!({
            "Archives": [
                { "date": "2026-11-12" },
                { "date": "2026-11-11" },
                "2026-11-10"
            ]
        });
        let rows = parse_archives(&body, None).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].category.as_deref(), Some("archive-day"));
        assert!(rows[0].audio_url.is_none());
    }

    #[test]
    fn parses_archive_clips_for_day() {
        let body = json!({
            "Archives": [{
                "start": "2026-11-12T10:00:00",
                "end": "2026-11-12T10:30:00",
                "url": "https://example.com/clip.mp3"
            }, {
                "startTime": "2026-11-12T09:30:00",
                "endTime": "2026-11-12T10:00:00",
                "downloadUrl": "https://example.com/clip2.mp3"
            }]
        });
        let rows = parse_archives(&body, Some("2026-11-12")).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].category.as_deref(), Some("archive"));
        assert!(rows.iter().all(|r| r.audio_url.is_some()));
    }

    #[test]
    fn rejects_bad_day() {
        assert!(validate_day("11-12-2026").is_err());
        assert!(validate_day("2026-11-12").is_ok());
    }
}
