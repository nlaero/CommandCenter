use crate::config::SourceConfig;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

const CHICAGO_ENDPOINT: &str =
    "https://data.cityofchicago.org/resource/ijzp-q8t2.json?$order=date DESC&$where=latitude IS NOT NULL";
const SEATTLE_ENDPOINT: &str =
    "https://data.seattle.gov/resource/tazs-3rd5.json?$order=offense_date DESC&$where=latitude IS NOT NULL";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Incident {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub occurred_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lat: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lon: Option<f64>,
    /// Optional media URL when a feed provides one (e.g. licensed scanner clip).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail_url: Option<String>,
    #[serde(default)]
    pub severity: IncidentSeverity,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum IncidentSeverity {
    #[default]
    Info,
    Warn,
    Alert,
}

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
    let provider = param_str(source, "provider").unwrap_or_else(|| "custom".into());
    let (endpoint, default_attr, note) = resolve_endpoint(source, &provider)?;
    let attribution = param_str(source, "attribution")
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(default_attr);
    let limit = param_u32(source, "limit").unwrap_or(50).clamp(1, 200);

    let url = with_limit(&endpoint, limit);
    let client = reqwest::blocking::Client::builder()
        .user_agent("CommandCenter/0.1 (personal open-data; +https://github.com/nlaero/CommandCenter)")
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    let mut req = client.get(&url);
    if let Some(token) = secrets
        .get("socrata.app_token")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        req = req.header("X-App-Token", token);
    }

    let response = req.send()?.error_for_status()?;
    let body: Value = response.json()?;
    let mut incidents = normalize_payload(&body)?;
    sort_newest_first(&mut incidents);
    if incidents.len() > limit as usize {
        incidents.truncate(limit as usize);
    }

    Ok(FetchResult {
        incidents,
        attribution,
        fetched_at: chrono_like_now(),
        note,
    })
}

fn resolve_endpoint(
    source: &SourceConfig,
    provider: &str,
) -> Result<(String, String, Option<String>), super::SourceError> {
    match provider {
        "chicago" => Ok((
            CHICAGO_ENDPOINT.to_string(),
            "City of Chicago Open Data — Crimes 2001 to Present".into(),
            Some(
                "Municipal open-data lag (often hours–days). Not a live CAD/scanner feed. No CrimeRadar/Squawster scrape."
                    .into(),
            ),
        )),
        "seattle" => Ok((
            SEATTLE_ENDPOINT.to_string(),
            "City of Seattle Open Data — SPD Crime Data".into(),
            Some(
                "Municipal open-data lag (often hours–days). Not a live CAD/scanner feed. No CrimeRadar/Squawster scrape."
                    .into(),
            ),
        )),
        _ => {
            let endpoint = param_str(source, "endpoint").filter(|s| !s.trim().is_empty());
            let Some(endpoint) = endpoint else {
                return Err(super::SourceError::Message(
                    "custom provider requires endpoint URL".into(),
                ));
            };
            if !(endpoint.starts_with("https://") || endpoint.starts_with("http://")) {
                return Err(super::SourceError::Message(
                    "endpoint must be an http(s) URL".into(),
                ));
            }
            Ok((
                endpoint,
                "User-configured open-data feed".into(),
                Some(
                    "Supports GeoJSON FeatureCollection or JSON arrays (Socrata-style). Optional audioUrl/detailUrl fields surface in the panel when present."
                        .into(),
                ),
            ))
        }
    }
}

fn with_limit(endpoint: &str, limit: u32) -> String {
    // Preserve existing query; append $limit for Socrata-ish endpoints when missing.
    if endpoint.contains("$limit=") || endpoint.contains("limit=") {
        return endpoint.to_string();
    }
    let sep = if endpoint.contains('?') { '&' } else { '?' };
    // Prefer Socrata $limit; harmless on GeoJSON hosts that ignore unknown params.
    format!("{endpoint}{sep}$limit={limit}")
}

pub fn normalize_payload(body: &Value) -> Result<Vec<Incident>, super::SourceError> {
    if let Some(features) = body.get("features").and_then(|v| v.as_array()) {
        return Ok(features
            .iter()
            .enumerate()
            .filter_map(|(i, f)| geojson_feature(f, i))
            .collect());
    }
    if let Some(rows) = body.as_array() {
        return Ok(rows
            .iter()
            .enumerate()
            .filter_map(|(i, row)| row_incident(row, i))
            .collect());
    }
    if body.get("incidents").and_then(|v| v.as_array()).is_some() {
        let rows = body["incidents"].as_array().unwrap();
        return Ok(rows
            .iter()
            .enumerate()
            .filter_map(|(i, row)| row_incident(row, i))
            .collect());
    }
    Err(super::SourceError::Message(
        "unsupported payload: expected GeoJSON FeatureCollection, JSON array, or { incidents: [] }"
            .into(),
    ))
}

fn geojson_feature(feature: &Value, index: usize) -> Option<Incident> {
    let props = feature.get("properties").unwrap_or(feature);
    let mut incident = row_incident(props, index)?;
    if incident.lat.is_none() || incident.lon.is_none() {
        if let Some(coords) = feature
            .pointer("/geometry/coordinates")
            .and_then(|c| c.as_array())
        {
            if coords.len() >= 2 {
                incident.lon = coords[0].as_f64().or_else(|| {
                    coords[0]
                        .as_str()
                        .and_then(|s| s.parse().ok())
                });
                incident.lat = coords[1].as_f64().or_else(|| {
                    coords[1]
                        .as_str()
                        .and_then(|s| s.parse().ok())
                });
            }
        }
    }
    Some(incident)
}

fn row_incident(row: &Value, index: usize) -> Option<Incident> {
    if !row.is_object() {
        return None;
    }

    // Chicago Crimes
    if row.get("primary_type").is_some() || row.get("case_number").is_some() {
        let primary = str_field(row, &["primary_type"]).unwrap_or_else(|| "Incident".into());
        let desc = str_field(row, &["description"]);
        let title = match &desc {
            Some(d) if !d.is_empty() => format!("{primary} — {d}"),
            _ => primary.clone(),
        };
        let severity = severity_for(&primary);
        return Some(Incident {
            id: str_field(row, &["id", "case_number"]).unwrap_or_else(|| format!("row-{index}")),
            title,
            category: Some(primary),
            description: desc,
            occurred_at: str_field(row, &["date", "updated_on"]),
            address: str_field(row, &["block", "location_description"]),
            lat: num_field(row, &["latitude"]),
            lon: num_field(row, &["longitude"]),
            audio_url: str_field(row, &["audio_url", "audioUrl", "audio"]),
            detail_url: str_field(row, &["detail_url", "detailUrl", "url"]),
            severity,
        });
    }

    // Seattle SPD crime. `offense_category` is often a coarse bucket ("ALL OTHER")
    // even when the NIBRS text is an assault, so severity uses the specific fields.
    if row.get("offense_category").is_some() || row.get("report_number").is_some() {
        let specific = str_field(
            row,
            &["offense_sub_category", "nibrs_offense_code_description"],
        );
        let category = specific
            .clone()
            .or_else(|| str_field(row, &["offense_category"]))
            .unwrap_or_else(|| "Incident".into());
        let desc = str_field(
            row,
            &["nibrs_offense_code_description", "offense_sub_category"],
        );
        let title = desc.clone().unwrap_or_else(|| category.clone());
        let severity_text = format!("{category} {}", desc.clone().unwrap_or_default());
        return Some(Incident {
            id: str_field(row, &["offense_id", "report_number"])
                .unwrap_or_else(|| format!("row-{index}")),
            title,
            category: Some(category),
            description: desc,
            occurred_at: str_field(row, &["offense_date", "report_date_time"]),
            address: str_field(row, &["block_address", "neighborhood"]),
            lat: num_field(row, &["latitude"]),
            lon: num_field(row, &["longitude"]),
            audio_url: str_field(row, &["audio_url", "audioUrl", "audio"]),
            detail_url: str_field(row, &["detail_url", "detailUrl", "url"]),
            severity: severity_for(&severity_text),
        });
    }

    // Generic / recipe shape
    let title = str_field(
        row,
        &[
            "title",
            "name",
            "incident",
            "type",
            "offense",
            "call_type",
            "callType",
        ],
    )?;
    Some(Incident {
        id: str_field(row, &["id", "incident_id", "incidentId", "case_number"])
            .unwrap_or_else(|| format!("row-{index}")),
        title: title.clone(),
        category: str_field(row, &["category", "type", "offense", "call_type"]),
        description: str_field(row, &["description", "summary", "details"]),
        occurred_at: str_field(
            row,
            &["occurred_at", "occurredAt", "datetime", "date", "time", "when"],
        ),
        address: str_field(row, &["address", "block", "location", "place"]),
        lat: num_field(row, &["lat", "latitude", "y"]),
        lon: num_field(row, &["lon", "lng", "longitude", "x"]),
        audio_url: str_field(row, &["audio_url", "audioUrl", "audio"]),
        detail_url: str_field(row, &["detail_url", "detailUrl", "url", "link"]),
        severity: severity_for(&title),
    })
}

fn severity_for(text: &str) -> IncidentSeverity {
    let t = text.to_ascii_uppercase();
    const ALERT: &[&str] = &[
        "HOMICIDE",
        "MURDER",
        "SHOOTING",
        "ROBBERY",
        "ASSAULT",
        "KIDNAP",
        "RAPE",
        "SEX OFFENSE",
        "WEAPON",
    ];
    const WARN: &[&str] = &[
        "BURGLARY",
        "THEFT",
        "MOTOR VEHICLE",
        "ARSON",
        "BATTERY",
        "CRIMINAL DAMAGE",
        "PROPERTY",
    ];
    if ALERT.iter().any(|k| t.contains(k)) {
        IncidentSeverity::Alert
    } else if WARN.iter().any(|k| t.contains(k)) {
        IncidentSeverity::Warn
    } else {
        IncidentSeverity::Info
    }
}

fn sort_newest_first(incidents: &mut [Incident]) {
    incidents.sort_by(|a, b| match (&b.occurred_at, &a.occurred_at) {
        (Some(x), Some(y)) => x.cmp(y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => b.id.cmp(&a.id),
    });
}

fn param_str(source: &SourceConfig, key: &str) -> Option<String> {
    source.params.get(key).and_then(|v| match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    })
}

fn param_u32(source: &SourceConfig, key: &str) -> Option<u32> {
    source.params.get(key).and_then(|v| match v {
        Value::Number(n) => n.as_u64().map(|x| x as u32),
        Value::String(s) => s.parse().ok(),
        _ => None,
    })
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

fn chrono_like_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_chicago_rows() {
        let body = json!([{
            "id": "1",
            "case_number": "XX",
            "date": "2026-11-05T00:00:00.000",
            "block": "100 N STATE",
            "primary_type": "THEFT",
            "description": "OVER $500",
            "latitude": "41.88",
            "longitude": "-87.62"
        }]);
        let rows = normalize_payload(&body).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].category.as_deref(), Some("THEFT"));
        assert_eq!(rows[0].severity, IncidentSeverity::Warn);
        assert!(rows[0].lat.is_some());
    }

    #[test]
    fn seattle_assault_is_not_buried_in_all_other() {
        let body = json!([{
            "report_number": "2026-338014",
            "offense_id": "74814795469",
            "offense_date": "2026-11-12T22:16:00.000",
            "offense_category": "ALL OTHER",
            "offense_sub_category": "ASSAULT OFFENSES",
            "nibrs_offense_code_description": "Simple Assault",
            "block_address": "64XX BLOCK OF CALIFORNIA AVE SW",
            "latitude": "47.54",
            "longitude": "-122.38"
        }]);
        let rows = normalize_payload(&body).unwrap();
        assert_eq!(rows[0].title, "Simple Assault");
        assert_eq!(rows[0].category.as_deref(), Some("ASSAULT OFFENSES"));
        assert_eq!(rows[0].severity, IncidentSeverity::Alert);
    }

    #[test]
    fn normalizes_geojson_and_audio() {
        let body = json!({
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature",
                "geometry": { "type": "Point", "coordinates": [-122.3, 47.6] },
                "properties": {
                    "id": "a1",
                    "title": "Shooting",
                    "audioUrl": "https://example.com/clip.mp3",
                    "detailUrl": "https://example.com/i/a1"
                }
            }]
        });
        let rows = normalize_payload(&body).unwrap();
        assert_eq!(rows[0].audio_url.as_deref(), Some("https://example.com/clip.mp3"));
        assert_eq!(rows[0].lat, Some(47.6));
        assert_eq!(rows[0].severity, IncidentSeverity::Alert);
    }

    #[test]
    fn sorts_newest_first() {
        let mut rows = vec![
            Incident {
                id: "1".into(),
                title: "Older".into(),
                category: None,
                description: None,
                occurred_at: Some("2024-01-01".into()),
                address: None,
                lat: None,
                lon: None,
                audio_url: None,
                detail_url: None,
                severity: IncidentSeverity::Info,
            },
            Incident {
                id: "2".into(),
                title: "Newer".into(),
                category: None,
                description: None,
                occurred_at: Some("2025-01-01".into()),
                address: None,
                lat: None,
                lon: None,
                audio_url: None,
                detail_url: None,
                severity: IncidentSeverity::Info,
            },
        ];
        sort_newest_first(&mut rows);
        assert_eq!(rows[0].id, "2");
    }
}
