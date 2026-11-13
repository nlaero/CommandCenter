//! USGS earthquake summary GeoJSON.
//!
//! Feeds: <https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php>
//! USGS updates them about once a minute and asks clients not to poll faster
//! than that. Responses carry `Cache-Control: max-age=60` (and `Age` behind
//! CloudFront) plus `Last-Modified`, which returns 304 when the body is unchanged.

use crate::config::SourceConfig;
use crate::sources::alerts::SourceAlert;
use crate::sources::incident::{Incident, IncidentSeverity};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const FEED_BASE: &str = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary";
const USER_AGENT: &str =
    "CommandCenter/0.1 (personal USGS earthquake feed; +https://github.com/nlaero/CommandCenter)";

/// USGS asks consumers not to request summary feeds more than once a minute.
pub const MIN_POLL_SECS: u64 = 60;

const ALLOWED_FEEDS: &[&str] = &[
    "all_hour",
    "all_day",
    "2.5_day",
    "4.5_day",
    "4.5_week",
    "significant_hour",
    "significant_day",
    "significant_week",
    "significant_month",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuakeEvent {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mag: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mag_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub place: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub occurred_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    pub lat: f64,
    pub lon: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth_km: Option<f64>,
    pub tsunami: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alert: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub significance: Option<i64>,
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub felt: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mmi: Option<f64>,
    pub severity: IncidentSeverity,
    pub notable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuakePayload {
    pub feed_id: String,
    pub feed_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feed_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_count: Option<u64>,
    pub events: Vec<QuakeEvent>,
    /// Milliseconds until the next HTTP request is allowed.
    pub poll_after_ms: u64,
    pub cache_max_age_sec: u64,
    pub from_cache: bool,
    pub not_modified: bool,
}

#[derive(Debug, Clone)]
pub struct FetchResult {
    pub incidents: Vec<Incident>,
    pub quake: QuakePayload,
    pub alerts: Vec<SourceAlert>,
    pub attribution: String,
    pub fetched_at: String,
    pub note: Option<String>,
}

struct CacheEntry {
    body: Value,
    last_modified: Option<String>,
    etag: Option<String>,
    stored: Instant,
    wait: Duration,
    max_age_secs: u64,
}

struct FeedCache {
    entries: HashMap<String, CacheEntry>,
}

fn cache() -> &'static Mutex<FeedCache> {
    static CACHE: OnceLock<Mutex<FeedCache>> = OnceLock::new();
    CACHE.get_or_init(|| {
        Mutex::new(FeedCache {
            entries: HashMap::new(),
        })
    })
}

fn with_cache<T>(f: impl FnOnce(&mut FeedCache) -> T) -> T {
    let mut guard = cache().lock().unwrap_or_else(|err| err.into_inner());
    f(&mut guard)
}

pub fn feed_url(feed_id: &str) -> Result<String, super::SourceError> {
    if !ALLOWED_FEEDS.contains(&feed_id) {
        return Err(super::SourceError::Message(format!(
            "unknown USGS feed \"{feed_id}\""
        )));
    }
    Ok(format!("{FEED_BASE}/{feed_id}.geojson"))
}

/// How long to wait before the next request.
///
/// `max-age` minus `Age` is the remaining CDN freshness. USGS also asks for at
/// least 60 seconds between requests, so the wait is the larger of the two.
pub fn poll_wait_secs(max_age: Option<u64>, age: u64) -> u64 {
    let max_age = max_age.unwrap_or(MIN_POLL_SECS);
    let remaining = max_age.saturating_sub(age.min(max_age));
    remaining.max(MIN_POLL_SECS)
}

pub fn parse_cache_control(header: &str) -> Option<u64> {
    for part in header.split(',') {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix("max-age=") {
            if let Ok(secs) = rest.trim().parse::<u64>() {
                return Some(secs);
            }
        }
    }
    None
}

pub fn fetch(source_id: &str, source: &SourceConfig) -> Result<FetchResult, super::SourceError> {
    let feed_id = param_str(source, "feed").unwrap_or_else(|| "all_day".into());
    let url = feed_url(&feed_id)?;
    let limit = param_u32(source, "limit").unwrap_or(50).clamp(1, 300);
    let notable_min = param_f64(source, "notableMinMag")
        .unwrap_or(4.5)
        .clamp(0.0, 10.0);

    if let Some(hit) = fresh_hit(&url) {
        return assemble(
            source_id,
            &feed_id,
            &url,
            &hit.body,
            limit,
            notable_min,
            hit.remaining,
            hit.max_age_secs,
            true,
            false,
            None,
        );
    }

    let (last_modified, etag) = with_cache(|cache| {
        cache
            .entries
            .get(&url)
            .map(|entry| (entry.last_modified.clone(), entry.etag.clone()))
    })
    .unwrap_or((None, None));

    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(30))
        .build()?;

    let mut req = client
        .get(&url)
        .header("accept", "application/geo+json, application/json");
    if let Some(value) = &last_modified {
        req = req.header("if-modified-since", value);
    }
    if let Some(value) = &etag {
        req = req.header("if-none-match", value);
    }

    let response = match req.send() {
        Ok(response) => response,
        Err(err) => {
            if let Some(hit) = any_hit(&url) {
                let mut result = assemble(
                    source_id,
                    &feed_id,
                    &url,
                    &hit.body,
                    limit,
                    notable_min,
                    MIN_POLL_SECS * 1000,
                    hit.max_age_secs,
                    true,
                    false,
                    Some(format!(
                        "USGS request failed ({err}). Showing the last feed; next try in {MIN_POLL_SECS}s."
                    )),
                )?;
                result.note = Some(format!(
                    "USGS request failed ({err}). Showing the last feed."
                ));
                return Ok(result);
            }
            return Err(err.into());
        }
    };

    let status = response.status();
    let max_age = header_str(&response, "cache-control")
        .as_deref()
        .and_then(parse_cache_control);
    let age = header_str(&response, "age")
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(0);
    let new_last_modified = header_str(&response, "last-modified").or(last_modified);
    let new_etag = header_str(&response, "etag").or(etag);
    let wait_secs = poll_wait_secs(max_age, age);
    let max_age_secs = max_age.unwrap_or(MIN_POLL_SECS);

    if status.as_u16() == 304 {
        let Some(body) =
            with_cache(|cache| cache.entries.get(&url).map(|entry| entry.body.clone()))
        else {
            return Err(super::SourceError::Message(
                "USGS returned 304 without a cached feed".into(),
            ));
        };
        store_entry(
            &url,
            body.clone(),
            new_last_modified,
            new_etag,
            wait_secs,
            max_age_secs,
        );
        return assemble(
            source_id,
            &feed_id,
            &url,
            &body,
            limit,
            notable_min,
            wait_secs * 1000,
            max_age_secs,
            false,
            true,
            None,
        );
    }

    if status.as_u16() == 429 || status.is_server_error() {
        let retry_secs = header_str(&response, "retry-after")
            .as_deref()
            .map(parse_retry_after)
            .unwrap_or(MIN_POLL_SECS)
            .max(MIN_POLL_SECS);
        if let Some(hit) = any_hit(&url) {
            store_entry(
                &url,
                hit.body.clone(),
                hit.last_modified,
                hit.etag,
                retry_secs,
                hit.max_age_secs,
            );
            return assemble(
                source_id,
                &feed_id,
                &url,
                &hit.body,
                limit,
                notable_min,
                retry_secs * 1000,
                hit.max_age_secs,
                true,
                false,
                Some(format!(
                    "USGS HTTP {status}. Showing the last feed; next try in {retry_secs}s."
                )),
            );
        }
        return Err(super::SourceError::Message(format!(
            "USGS HTTP {status}; retry after {retry_secs}s"
        )));
    }

    if !status.is_success() {
        return Err(super::SourceError::Message(format!(
            "USGS HTTP {status} for {feed_id}"
        )));
    }

    let body: Value = response.json()?;
    store_entry(
        &url,
        body.clone(),
        new_last_modified,
        new_etag,
        wait_secs,
        max_age_secs,
    );
    assemble(
        source_id,
        &feed_id,
        &url,
        &body,
        limit,
        notable_min,
        wait_secs * 1000,
        max_age_secs,
        false,
        false,
        None,
    )
}

struct Hit {
    body: Value,
    remaining: u64,
    max_age_secs: u64,
    last_modified: Option<String>,
    etag: Option<String>,
}

fn fresh_hit(url: &str) -> Option<Hit> {
    with_cache(|cache| {
        let entry = cache.entries.get(url)?;
        let elapsed = entry.stored.elapsed();
        if elapsed + Duration::from_secs(1) >= entry.wait {
            return None;
        }
        let remaining = entry.wait.saturating_sub(elapsed).as_millis() as u64;
        Some(Hit {
            body: entry.body.clone(),
            remaining,
            max_age_secs: entry.max_age_secs,
            last_modified: entry.last_modified.clone(),
            etag: entry.etag.clone(),
        })
    })
}

fn any_hit(url: &str) -> Option<Hit> {
    with_cache(|cache| {
        let entry = cache.entries.get(url)?;
        Some(Hit {
            body: entry.body.clone(),
            remaining: MIN_POLL_SECS * 1000,
            max_age_secs: entry.max_age_secs,
            last_modified: entry.last_modified.clone(),
            etag: entry.etag.clone(),
        })
    })
}

fn store_entry(
    url: &str,
    body: Value,
    last_modified: Option<String>,
    etag: Option<String>,
    wait_secs: u64,
    max_age_secs: u64,
) {
    with_cache(|cache| {
        cache.entries.insert(
            url.to_string(),
            CacheEntry {
                body,
                last_modified,
                etag,
                stored: Instant::now(),
                wait: Duration::from_secs(wait_secs.max(1)),
                max_age_secs,
            },
        );
    });
}

fn assemble(
    source_id: &str,
    feed_id: &str,
    url: &str,
    body: &Value,
    limit: u32,
    notable_min: f64,
    poll_after_ms: u64,
    max_age_secs: u64,
    from_cache: bool,
    not_modified: bool,
    note_override: Option<String>,
) -> Result<FetchResult, super::SourceError> {
    let parsed = parse_feed(body, limit, notable_min)?;
    let incidents = parsed.events.iter().map(event_to_incident).collect();
    let alerts = parsed
        .events
        .iter()
        .filter(|event| event.notable)
        .map(|event| event_to_alert(source_id, event))
        .collect();
    let title = parsed.feed_title.clone();
    let attribution = match &title {
        Some(title) => format!("USGS Earthquake Hazards Program — {title}"),
        None => "USGS Earthquake Hazards Program".into(),
    };
    let note = note_override.or_else(|| {
        Some(
            "Summary GeoJSON. Polled on the USGS cache lifetime, never faster than once a minute. Last-Modified conditional GET."
                .into(),
        )
    });
    Ok(FetchResult {
        incidents,
        quake: QuakePayload {
            feed_id: feed_id.to_string(),
            feed_url: url.to_string(),
            feed_title: title,
            total_count: parsed.total_count,
            events: parsed.events,
            poll_after_ms: poll_after_ms.max(1000),
            cache_max_age_sec: max_age_secs,
            from_cache,
            not_modified,
        },
        alerts,
        attribution,
        fetched_at: chrono_like_now(),
        note,
    })
}

struct ParsedFeed {
    events: Vec<QuakeEvent>,
    feed_title: Option<String>,
    total_count: Option<u64>,
}

fn parse_feed(
    body: &Value,
    limit: u32,
    notable_min_mag: f64,
) -> Result<ParsedFeed, super::SourceError> {
    let features = body
        .get("features")
        .and_then(|value| value.as_array())
        .ok_or_else(|| {
            super::SourceError::Message("USGS payload was not a GeoJSON FeatureCollection".into())
        })?;
    let mut events = Vec::new();
    for (index, feature) in features.iter().enumerate() {
        if let Some(event) = feature_event(feature, index, notable_min_mag) {
            events.push(event);
        }
    }
    events.sort_by(|a, b| match (&b.occurred_at, &a.occurred_at) {
        (Some(left), Some(right)) => left.cmp(right),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => b.id.cmp(&a.id),
    });
    let total_count = body
        .pointer("/metadata/count")
        .and_then(|value| value.as_u64())
        .or(Some(events.len() as u64));
    if events.len() > limit as usize {
        events.truncate(limit as usize);
    }
    let feed_title = body
        .pointer("/metadata/title")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    Ok(ParsedFeed {
        events,
        feed_title,
        total_count,
    })
}

fn feature_event(feature: &Value, index: usize, notable_min_mag: f64) -> Option<QuakeEvent> {
    let props = feature.get("properties")?;
    let coords = feature.pointer("/geometry/coordinates")?.as_array()?;
    if coords.len() < 2 {
        return None;
    }
    let lon = coords[0].as_f64()?;
    let lat = coords[1].as_f64()?;
    if !lon.is_finite() || !lat.is_finite() {
        return None;
    }
    let depth_km = coords
        .get(2)
        .and_then(|value| value.as_f64())
        .filter(|n| n.is_finite());
    let mag = num_field(props, &["mag"]).filter(|n| n.is_finite());
    let event_type = str_field(props, &["type"]).unwrap_or_else(|| "unknown".into());
    let place = str_field(props, &["place"]);
    let pager = str_field(props, &["alert"]);
    let tsunami = int_field(props, "tsunami").unwrap_or(0) == 1;
    let (severity, notable) = assess(mag, tsunami, pager.as_deref(), &event_type, notable_min_mag);
    let title = str_field(props, &["title"]).unwrap_or_else(|| {
        let mag_prefix = mag
            .map(|value| format!("M {value:.1} "))
            .unwrap_or_default();
        let where_text = place.clone().unwrap_or_else(|| "unknown location".into());
        format!("{mag_prefix}{event_type} — {where_text}")
    });
    let id = feature
        .get("id")
        .and_then(|value| match value {
            Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
        .or_else(|| str_field(props, &["code", "ids"]))
        .unwrap_or_else(|| format!("row-{index}"));
    Some(QuakeEvent {
        id,
        title,
        mag,
        mag_type: str_field(props, &["magType"]),
        place,
        occurred_at: int_field(props, "time").and_then(millis_to_rfc3339),
        updated_at: int_field(props, "updated").and_then(millis_to_rfc3339),
        lat,
        lon,
        depth_km,
        tsunami,
        alert: pager,
        significance: int_field(props, "sig"),
        event_type,
        status: str_field(props, &["status"]),
        url: str_field(props, &["url"]),
        felt: int_field(props, "felt"),
        mmi: num_field(props, &["mmi"]),
        severity,
        notable,
    })
}

/// Keep this in sync with `assessQuake` in `src/lib/usgs.ts`.
pub fn assess(
    mag: Option<f64>,
    tsunami: bool,
    pager: Option<&str>,
    event_type: &str,
    notable_min_mag: f64,
) -> (IncidentSeverity, bool) {
    let mag_value = mag.unwrap_or(0.0);
    let pager = pager.unwrap_or("").trim().to_ascii_lowercase();
    let kind = event_type.trim().to_ascii_lowercase();
    let hazard = kind == "landslide" || kind == "volcanic eruption";
    let notable = tsunami
        || hazard
        || pager == "yellow"
        || pager == "orange"
        || pager == "red"
        || mag_value >= notable_min_mag;
    let severity = if tsunami
        || pager == "orange"
        || pager == "red"
        || mag_value >= 6.0
        || kind == "volcanic eruption"
    {
        IncidentSeverity::Alert
    } else if notable {
        IncidentSeverity::Warn
    } else {
        IncidentSeverity::Info
    };
    (severity, notable)
}

fn event_to_incident(event: &QuakeEvent) -> Incident {
    let mut description = summary_text(event);
    if event.tsunami {
        description = format!("Tsunami flag. {description}");
    }
    Incident {
        id: event.id.clone(),
        title: event.title.clone(),
        category: Some(event.event_type.clone()),
        description: Some(description),
        occurred_at: event.occurred_at.clone(),
        address: event.place.clone(),
        lat: Some(event.lat),
        lon: Some(event.lon),
        audio_url: None,
        detail_url: event.url.clone(),
        severity: event.severity,
    }
}

fn event_to_alert(source_id: &str, event: &QuakeEvent) -> SourceAlert {
    let kind = if event.tsunami {
        "tsunami".into()
    } else {
        event.event_type.clone()
    };
    SourceAlert {
        id: format!("{source_id}:{}", event.id),
        source_id: source_id.to_string(),
        source_type: "usgs.earthquake".into(),
        title: event.title.clone(),
        summary: Some(summary_text(event)),
        severity: event.severity,
        occurred_at: event.occurred_at.clone(),
        lat: Some(event.lat),
        lon: Some(event.lon),
        detail_url: event.url.clone(),
        kind,
    }
}

fn summary_text(event: &QuakeEvent) -> String {
    let mut parts = Vec::new();
    if let Some(mag) = event.mag {
        parts.push(format!("M{mag:.1}"));
    }
    parts.push(event.event_type.clone());
    if event.tsunami {
        parts.push("tsunami flag".into());
    }
    if let Some(depth) = event.depth_km {
        parts.push(format!("{depth:.1} km deep"));
    }
    if let Some(place) = &event.place {
        parts.push(place.clone());
    }
    parts.join(" · ")
}

fn parse_retry_after(value: &str) -> u64 {
    let value = value.trim();
    if let Ok(secs) = value.parse::<u64>() {
        return secs;
    }
    if let Ok(when) = chrono::DateTime::parse_from_rfc2822(value) {
        let delta = when.timestamp() - chrono::Utc::now().timestamp();
        return delta.max(0) as u64;
    }
    MIN_POLL_SECS
}

fn header_str(response: &reqwest::blocking::Response, name: &str) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn param_str(source: &SourceConfig, key: &str) -> Option<String> {
    source.params.get(key).and_then(|value| match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    })
}

fn param_u32(source: &SourceConfig, key: &str) -> Option<u32> {
    source.params.get(key).and_then(|value| match value {
        Value::Number(number) => number.as_u64().map(|n| n as u32),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    })
}

fn param_f64(source: &SourceConfig, key: &str) -> Option<f64> {
    source.params.get(key).and_then(|value| match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    })
}

fn str_field(row: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = row.get(*key) {
            match value {
                Value::String(text) if !text.trim().is_empty() => return Some(text.clone()),
                Value::Number(number) => return Some(number.to_string()),
                _ => {}
            }
        }
    }
    None
}

fn num_field(row: &Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(value) = row.get(*key) {
            match value {
                Value::Number(number) => return number.as_f64(),
                Value::String(text) => {
                    if let Ok(number) = text.trim().parse::<f64>() {
                        return Some(number);
                    }
                }
                _ => {}
            }
        }
    }
    None
}

fn int_field(row: &Value, key: &str) -> Option<i64> {
    match row.get(key)? {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|n| n as i64)),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn millis_to_rfc3339(ms: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

fn chrono_like_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_feed() -> Value {
        json!({
            "type": "FeatureCollection",
            "metadata": {
                "generated": 1_700_000_200_000_i64,
                "title": "USGS Magnitude 4.5+ Earthquakes, Past Week",
                "count": 4
            },
            "features": [
                {
                    "type": "Feature",
                    "id": "us-small",
                    "geometry": { "type": "Point", "coordinates": [-122.4, 37.8, 8.2] },
                    "properties": {
                        "mag": 1.4,
                        "place": "3 km W of Berkeley, CA",
                        "time": 1_700_000_100_000_i64,
                        "title": "M 1.4 - 3 km W of Berkeley, CA",
                        "tsunami": 0,
                        "type": "earthquake",
                        "magType": "ml",
                        "url": "https://earthquake.usgs.gov/earthquakes/eventpage/us-small"
                    }
                },
                {
                    "type": "Feature",
                    "id": "us-tsu",
                    "geometry": { "type": "Point", "coordinates": [-128.1, 49.1, 10] },
                    "properties": {
                        "mag": 4.7,
                        "place": "130 km W of Tofino, Canada",
                        "time": 1_700_000_050_000_i64,
                        "title": "M 4.7 - 130 km W of Tofino, Canada",
                        "tsunami": 1,
                        "alert": "green",
                        "type": "earthquake",
                        "sig": 340,
                        "url": "https://earthquake.usgs.gov/earthquakes/eventpage/us-tsu"
                    }
                },
                {
                    "type": "Feature",
                    "id": "ak-slide",
                    "geometry": { "type": "Point", "coordinates": [-151.5, 59.9, 0] },
                    "properties": {
                        "mag": 1.3,
                        "place": "60 km W of Happy Valley, Alaska",
                        "time": 1_700_000_000_000_i64,
                        "title": "M 1.3 Landslide - 60 km W of Happy Valley, Alaska",
                        "tsunami": 0,
                        "type": "landslide"
                    }
                },
                {
                    "type": "Feature",
                    "id": "big",
                    "geometry": { "type": "Point", "coordinates": [149.9, -1.4, 20] },
                    "properties": {
                        "mag": 6.4,
                        "place": "Papua New Guinea",
                        "time": 1_700_000_150_000_i64,
                        "title": "M 6.4 - Papua New Guinea",
                        "tsunami": 0,
                        "alert": "yellow",
                        "type": "earthquake"
                    }
                },
                {
                    "type": "Feature",
                    "id": "no-geom",
                    "properties": { "mag": 5.0, "title": "missing geometry", "type": "earthquake", "time": 1_700_000_180_000_i64 }
                }
            ]
        })
    }

    #[test]
    fn parses_sorts_and_flags_notable_events() {
        let parsed = parse_feed(&sample_feed(), 10, 4.5).unwrap();
        assert_eq!(
            parsed.feed_title.as_deref(),
            Some("USGS Magnitude 4.5+ Earthquakes, Past Week")
        );
        assert_eq!(parsed.total_count, Some(4));
        let ids: Vec<_> = parsed
            .events
            .iter()
            .map(|event| event.id.as_str())
            .collect();
        assert_eq!(ids, vec!["big", "us-small", "us-tsu", "ak-slide"]);
        let by_id = |id: &str| parsed.events.iter().find(|event| event.id == id).unwrap();
        assert!(!by_id("us-small").notable);
        assert_eq!(by_id("us-small").severity, IncidentSeverity::Info);
        assert!(by_id("us-tsu").notable);
        assert!(by_id("us-tsu").tsunami);
        assert_eq!(by_id("us-tsu").severity, IncidentSeverity::Alert);
        assert_eq!(by_id("us-tsu").lat, 49.1);
        assert_eq!(by_id("us-tsu").lon, -128.1);
        assert_eq!(by_id("us-tsu").depth_km, Some(10.0));
        assert!(by_id("ak-slide").notable);
        assert_eq!(by_id("ak-slide").event_type, "landslide");
        assert_eq!(by_id("ak-slide").severity, IncidentSeverity::Warn);
        assert!(by_id("big").notable);
        assert_eq!(by_id("big").severity, IncidentSeverity::Alert);
        assert!(by_id("us-small")
            .occurred_at
            .as_ref()
            .unwrap()
            .starts_with("2023-11-14T22:15:00"));
    }

    #[test]
    fn truncates_to_limit_after_newest_sort() {
        let parsed = parse_feed(&sample_feed(), 2, 4.5).unwrap();
        assert_eq!(parsed.events.len(), 2);
        assert_eq!(parsed.events[0].id, "big");
        assert_eq!(parsed.total_count, Some(4));
    }

    #[test]
    fn poll_wait_respects_age_and_minute_floor() {
        assert_eq!(poll_wait_secs(Some(60), 32), 60);
        assert_eq!(poll_wait_secs(Some(300), 10), 290);
        assert_eq!(poll_wait_secs(Some(30), 0), 60);
        assert_eq!(poll_wait_secs(None, 0), 60);
        assert_eq!(poll_wait_secs(Some(60), 90), 60);
        assert_eq!(parse_cache_control("public, max-age=60"), Some(60));
        assert_eq!(parse_cache_control("no-cache"), None);
    }

    #[test]
    fn feed_url_is_allowlisted() {
        assert!(feed_url("all_day").unwrap().ends_with("/all_day.geojson"));
        assert!(feed_url("4.5_week").unwrap().contains("4.5_week"));
        assert!(feed_url("../secret").is_err());
        assert!(feed_url("https://example.com/feed").is_err());
    }

    #[test]
    fn alerts_keep_tsunami_kind() {
        let parsed = parse_feed(&sample_feed(), 10, 4.5).unwrap();
        let event = parsed
            .events
            .iter()
            .find(|event| event.id == "us-tsu")
            .unwrap();
        let alert = event_to_alert("src.quake", event);
        assert_eq!(alert.kind, "tsunami");
        assert_eq!(alert.source_type, "usgs.earthquake");
        assert!(alert.summary.unwrap().contains("tsunami flag"));
        let incident = event_to_incident(event);
        assert_eq!(
            incident.detail_url.as_deref(),
            Some("https://earthquake.usgs.gov/earthquakes/eventpage/us-tsu")
        );
        assert_eq!(incident.lat, Some(49.1));
    }
}
