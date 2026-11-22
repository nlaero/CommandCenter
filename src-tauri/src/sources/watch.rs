//! Fetches for the situational board sources. Parsers are local; the network
//! calls sit behind the desktop app.

use super::glm;
use super::gtfs;
use super::mqtt;
use super::sheet::{self, Row};
use crate::config::SourceConfig;
use crate::location::lookup_coords;
use crate::sources::SourceError;
use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveTime, TimeZone, Timelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration as StdDuration, Instant};

const UA: &str = "CommandCenter/0.1.11 (personal situational board; +https://github.com/nlaero/CommandCenter)";
const IODA_CREDIT: &str = "Internet Outage Detection and Analysis (IODA), Georgia Tech Research Corporation. All rights reserved.";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchMetric {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchItem {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub severity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub area: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub occurred_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ends_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lat: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lon: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub metrics: Vec<WatchMetric>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub notable: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchPayload {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub place_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub items: Vec<WatchItem>,
    pub poll_after_ms: u64,
}

pub struct FetchResult {
    pub fetched_at: String,
    pub attribution: String,
    pub note: Option<String>,
    pub watch: WatchPayload,
}

pub fn fetch(
    source: &SourceConfig,
    secrets: &BTreeMap<String, String>,
) -> Result<FetchResult, SourceError> {
    match source.type_id.as_str() {
        "rivers.nwps" => fetch_rivers(source),
        "storms.spc" => fetch_storms(source),
        "lightning.glm" => fetch_lightning(source),
        "agency.rss" => fetch_agency(source),
        "transit.gtfs" => fetch_transit(source, secrets),
        "tfr.faa" => fetch_tfr(source),
        "nuclear.nrc" => fetch_nuclear(source),
        "radiation.epa" => fetch_radiation(source),
        "spills.uscg" => fetch_spills(source),
        "disease.who" => fetch_disease(source),
        "internet.ioda" => fetch_ioda(source),
        "alarms.home" => fetch_alarms(source, secrets),
        other => Err(SourceError::Message(format!("unknown watch source: {other}"))),
    }
}

fn fetch_rivers(source: &SourceConfig) -> Result<FetchResult, SourceError> {
    let (lat, lon) = coords(source)?;
    let radius = radius_mi(source, 25.0);
    let (min_lat, min_lon, max_lat, max_lon) = bbox(lat, lon, radius);
    let client = http(30)?;
    let url = format!(
        "https://api.water.noaa.gov/nwps/v1/gauges?bbox.xmin={min_lon}&bbox.ymin={min_lat}&bbox.xmax={max_lon}&bbox.ymax={max_lat}&srid=EPSG_4326"
    );
    let body = get_text(&client, &url, StdDuration::from_secs(60))?;
    let value: Value = serde_json::from_str(&body).map_err(|_| SourceError::Message("River gauges returned data this app could not read.".into()))?;
    let mut gauges = parse_gauges(&value, lat, lon, radius);
    gauges.sort_by(|a, b| a.miles.partial_cmp(&b.miles).unwrap_or(std::cmp::Ordering::Equal));
    gauges.truncate(8);
    let mut items = Vec::new();
    for gauge in gauges {
        let detail_url = format!("https://api.water.noaa.gov/nwps/v1/gauges/{}", gauge.lid);
        let forecast_url = format!("https://api.water.noaa.gov/nwps/v1/gauges/{}/stageflow/forecast", gauge.lid);
        let detail = get_text(&client, &detail_url, StdDuration::from_secs(60)).ok();
        let forecast = get_text(&client, &forecast_url, StdDuration::from_secs(60)).ok();
        let lines = detail.as_deref().and_then(|text| serde_json::from_str::<Value>(text).ok()).map(|value| flood_lines(&value)).unwrap_or_default();
        let crest = forecast.as_deref().and_then(|text| serde_json::from_str::<Value>(text).ok()).and_then(|value| forecast_crest(&value));
        let (severity, notable) = flood_severity(gauge.category.as_deref());
        let mut summary = format!(
            "{} {} · {}",
            gauge.stage.map(|n| format!("{n:.1}")).unwrap_or_else(|| "—".into()),
            gauge.unit.as_deref().unwrap_or("ft"),
            gauge.category.clone().unwrap_or_else(|| "no category".into()).replace('_', " ")
        );
        if let Some(crest) = crest {
            summary = format!("{summary} · crest {crest:.1}");
        }
        items.push(WatchItem {
            id: gauge.lid.clone(),
            title: gauge.name,
            summary: Some(summary),
            body: if lines.is_empty() { None } else { Some(lines) },
            severity: Some(severity.into()),
            category: Some("river".into()),
            area: gauge.state,
            occurred_at: gauge.when,
            ends_at: None,
            detail_url: Some(detail_url),
            lat: Some(gauge.lat),
            lon: Some(gauge.lon),
            metrics: vec![WatchMetric { label: "Miles".into(), value: format!("{:.0}", gauge.miles) }],
            notable,
        });
    }
    Ok(done(
        "rivers.nwps",
        place_label(source),
        if items.is_empty() { Some("No river gauges inside this radius.".into()) } else { None },
        items,
        15 * 60_000,
        "NOAA National Water Prediction Service".into(),
        None,
    ))
}

struct GaugeRow {
    lid: String,
    name: String,
    lat: f64,
    lon: f64,
    miles: f64,
    stage: Option<f64>,
    unit: Option<String>,
    category: Option<String>,
    when: Option<String>,
    state: Option<String>,
}

fn parse_gauges(value: &Value, lat: f64, lon: f64, radius: f64) -> Vec<GaugeRow> {
    let Some(rows) = value.get("gauges").and_then(|item| item.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for row in rows {
        let Some(lid) = row.get("lid").and_then(|item| item.as_str()) else { continue };
        let glat = row.get("latitude").and_then(|item| item.as_f64()).unwrap_or(999.0);
        let glon = row.get("longitude").and_then(|item| item.as_f64()).unwrap_or(999.0);
        let miles = haversine_mi(lat, lon, glat, glon);
        if miles > radius {
            continue;
        }
        let observed = row.pointer("/status/observed");
        out.push(GaugeRow {
            lid: lid.to_string(),
            name: row.get("name").and_then(|item| item.as_str()).unwrap_or(lid).to_string(),
            lat: glat,
            lon: glon,
            miles,
            stage: observed.and_then(|item| item.get("primary")).and_then(|item| item.as_f64()),
            unit: observed.and_then(|item| item.get("primaryUnit")).and_then(|item| item.as_str()).map(str::to_string),
            category: observed.and_then(|item| item.get("floodCategory")).and_then(|item| item.as_str()).map(str::to_string),
            when: observed.and_then(|item| item.get("validTime")).and_then(|item| item.as_str()).map(str::to_string),
            state: row.pointer("/state/abbreviation").and_then(|item| item.as_str()).map(str::to_string),
        });
    }
    out
}

fn flood_lines(value: &Value) -> String {
    let Some(categories) = value.pointer("/flood/categories").and_then(|item| item.as_object()) else {
        return String::new();
    };
    let mut parts = Vec::new();
    for name in ["action", "minor", "moderate", "major"] {
        if let Some(stage) = categories.get(name).and_then(|item| item.get("stage")).and_then(|item| item.as_f64()) {
            if stage > -1000.0 {
                parts.push(format!("{name} {stage:.0} ft"));
            }
        }
    }
    parts.join(" · ")
}

fn forecast_crest(value: &Value) -> Option<f64> {
    value
        .get("data")
        .and_then(|item| item.as_array())
        .and_then(|rows| {
            rows.iter()
                .filter_map(|row| row.get("primary").and_then(|item| item.as_f64()))
                .filter(|value| value.is_finite())
                .max_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
        })
}

fn flood_severity(category: Option<&str>) -> (&'static str, bool) {
    match category.unwrap_or("").to_ascii_lowercase().as_str() {
        "moderate" | "major" => ("alert", true),
        "action" | "minor" => ("warn", true),
        _ => ("info", false),
    }
}

fn fetch_storms(source: &SourceConfig) -> Result<FetchResult, SourceError> {
    let (lat, lon) = coords(source)?;
    let radius = radius_mi(source, 50.0);
    let client = http(30)?;
    let mut items = Vec::new();
    for (kind, file) in [
        ("category", "day1otlk_cat.nolyr.geojson"),
        ("tornado", "day1otlk_torn.nolyr.geojson"),
        ("hail", "day1otlk_hail.nolyr.geojson"),
        ("wind", "day1otlk_wind.nolyr.geojson"),
    ] {
        let url = format!("https://www.spc.noaa.gov/products/outlook/{file}");
        if let Ok(text) = get_text(&client, &url, StdDuration::from_secs(3600)) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                items.extend(outlook_items(&value, kind, lat, lon));
            }
        }
    }
    let (min_lat, min_lon, max_lat, max_lon) = bbox(lat, lon, radius);
    let geometry = serde_json::json!({
        "xmin": min_lon, "ymin": min_lat, "xmax": max_lon, "ymax": max_lat,
        "spatialReference": {"wkid": 4326}
    });
    let geometry_text = geometry.to_string();
    let reports = client
        .get("https://mapservices.weather.noaa.gov/vector/rest/services/obs/nws_local_storm_reports/MapServer/0/query")
        .query(&[
            ("f", "geojson"),
            ("where", "1=1"),
            ("outFields", "descript,loc_desc,state,magnitude,units,remarks,valid_time"),
            ("returnGeometry", "true"),
            ("geometry", geometry_text.as_str()),
            ("geometryType", "esriGeometryEnvelope"),
            ("inSR", "4326"),
            ("spatialRel", "esriSpatialRelIntersects"),
            ("resultRecordCount", "200"),
        ])
        .send()
        .and_then(|response| response.error_for_status())
        .and_then(|response| response.text());
    if let Ok(text) = reports {
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            items.extend(report_items(&value, lat, lon, radius));
        }
    }
    Ok(done(
        "storms.spc",
        place_label(source),
        if items.is_empty() { Some("No outlook covering this place, and no reports inside the radius.".into()) } else { None },
        items,
        15 * 60_000,
        "NOAA Storm Prediction Center".into(),
        None,
    ))
}

fn outlook_items(value: &Value, kind: &str, lat: f64, lon: f64) -> Vec<WatchItem> {
    let Some(features) = value.get("features").and_then(|item| item.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for feature in features {
        if !geometry_covers(feature.get("geometry"), lat, lon) {
            continue;
        }
        let props = feature.get("properties");
        let label = props.and_then(|item| item.get("LABEL")).and_then(|item| item.as_str()).unwrap_or("");
        let label2 = props.and_then(|item| item.get("LABEL2")).and_then(|item| item.as_str()).unwrap_or("");
        if label.is_empty() {
            continue;
        }
        let tstm = label.eq_ignore_ascii_case("TSTM");
        let severe = matches!(label, "MDT" | "HIGH" | "ENH");
        let notable = kind != "category" || !tstm;
        out.push(WatchItem {
            id: format!("outlook-{kind}-{label}"),
            title: if kind == "category" {
                format!("Day 1 {label}")
            } else {
                format!("Day 1 {kind} {label}")
            },
            summary: if label2.is_empty() { None } else { Some(label2.to_string()) },
            body: None,
            severity: Some(if severe { "alert" } else if notable { "warn" } else { "info" }.into()),
            category: Some(kind.into()),
            area: None,
            occurred_at: props.and_then(|item| item.get("VALID_ISO")).and_then(|item| item.as_str()).map(str::to_string),
            ends_at: props.and_then(|item| item.get("EXPIRE_ISO")).and_then(|item| item.as_str()).map(str::to_string),
            detail_url: Some("https://www.spc.noaa.gov/products/outlook/".into()),
            lat: None,
            lon: None,
            metrics: vec![],
            notable,
        });
    }
    out
}

fn report_items(value: &Value, lat: f64, lon: f64, radius: f64) -> Vec<WatchItem> {
    let Some(features) = value.get("features").and_then(|item| item.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for feature in features {
        let coords = feature.pointer("/geometry/coordinates").and_then(|item| item.as_array());
        let (rlon, rlat) = match coords {
            Some(pair) if pair.len() >= 2 => (
                pair[0].as_f64().unwrap_or(999.0),
                pair[1].as_f64().unwrap_or(999.0),
            ),
            _ => continue,
        };
        if haversine_mi(lat, lon, rlat, rlon) > radius {
            continue;
        }
        let props = feature.get("properties");
        let kind = props.and_then(|item| item.get("descript")).and_then(|item| item.as_str()).unwrap_or("Report");
        let place = props.and_then(|item| item.get("loc_desc")).and_then(|item| item.as_str()).unwrap_or("");
        let magnitude = props.and_then(|item| item.get("magnitude")).and_then(|item| item.as_str()).unwrap_or("");
        let units = props.and_then(|item| item.get("units")).and_then(|item| item.as_str()).unwrap_or("");
        let lower = kind.to_ascii_lowercase();
        let notable = lower.contains("tornado") || lower.contains("hail") || lower.contains("wind") || lower.contains("funnel");
        let id = feature.get("id").map(|item| item.to_string()).unwrap_or_else(|| format!("{kind}-{place}-{rlat:.3}"));
        out.push(WatchItem {
            id,
            title: if place.is_empty() { kind.to_string() } else { format!("{kind} · {place}") },
            summary: if magnitude.is_empty() { None } else { Some(format!("{magnitude} {units}").trim().to_string()) },
            body: props.and_then(|item| item.get("remarks")).and_then(|item| item.as_str()).map(str::to_string),
            severity: Some(if notable { "warn" } else { "info" }.into()),
            category: Some("report".into()),
            area: props.and_then(|item| item.get("state")).and_then(|item| item.as_str()).map(str::to_string),
            occurred_at: props.and_then(|item| item.get("valid_time")).and_then(|item| item.as_str()).map(str::to_string),
            ends_at: None,
            detail_url: None,
            lat: Some(rlat),
            lon: Some(rlon),
            metrics: vec![],
            notable,
        });
    }
    out
}

fn fetch_lightning(source: &SourceConfig) -> Result<FetchResult, SourceError> {
    let (lat, lon) = coords(source)?;
    let radius = radius_mi(source, 30.0);
    let client = http(40)?;
    let now = Utc::now();
    let key = latest_glm_key(&client, now)?;
    let url = format!("https://noaa-goes19.s3.amazonaws.com/{key}");
    let bytes = get_bytes(&client, &url, StdDuration::from_secs(30))?;
    let flashes = glm::read_flashes(&bytes).map_err(SourceError::Message)?;
    let count = flashes
        .iter()
        .filter(|(flat, flon)| haversine_mi(lat, lon, *flat as f64, *flon as f64) <= radius)
        .count();
    let when = glm_stamp(&key);
    let mut items = Vec::new();
    if count > 0 {
        items.push(WatchItem {
            id: key.clone(),
            title: format!("{count} lightning flash{} within {:.0} miles", if count == 1 { "" } else { "es" }, radius),
            summary: when.clone(),
            body: Some("GOES-East GLM. Flashes outside the radius are not counted.".into()),
            severity: Some("warn".into()),
            category: Some("lightning".into()),
            area: None,
            occurred_at: when,
            ends_at: None,
            detail_url: Some("https://www.noaa.gov/".into()),
            lat: Some(lat),
            lon: Some(lon),
            metrics: vec![],
            notable: true,
        });
    }
    Ok(done(
        "lightning.glm",
        place_label(source),
        if count == 0 { Some(format!("No flashes within {radius:.0} miles in the newest file.")) } else { None },
        items,
        90_000,
        "NOAA GOES-East Geostationary Lightning Mapper".into(),
        None,
    ))
}

fn latest_glm_key(client: &reqwest::blocking::Client, now: DateTime<Utc>) -> Result<String, SourceError> {
    for shift in [0, 1] {
        let when = now - Duration::hours(shift);
        let prefix = format!("GLM-L2-LCFA/{}/{:03}/{:02}/", when.year(), when.ordinal(), when.hour());
        let url = format!("https://noaa-goes19.s3.amazonaws.com/?list-type=2&prefix={prefix}&max-keys=1000");
        let text = get_text(client, &url, StdDuration::from_secs(30))?;
        let mut keys = xml_values(&text, "Key");
        keys.retain(|key| key.contains("OR_GLM-L2-LCFA"));
        if let Some(key) = keys.into_iter().max() {
            return Ok(key);
        }
    }
    Err(SourceError::Message("No recent GOES-East lightning file was listed.".into()))
}

fn glm_stamp(key: &str) -> Option<String> {
    let start = key.find("_s")? + 2;
    let raw = key.get(start..start + 13)?;
    let year: i32 = raw.get(0..4)?.parse().ok()?;
    let doy: u32 = raw.get(4..7)?.parse().ok()?;
    let hour: u32 = raw.get(7..9)?.parse().ok()?;
    let minute: u32 = raw.get(9..11)?.parse().ok()?;
    let second: u32 = raw.get(11..13)?.parse().ok()?;
    let date = NaiveDate::from_yo_opt(year, doy)?;
    let time = NaiveTime::from_hms_opt(hour, minute, second)?;
    Some(Utc.from_utc_datetime(&date.and_time(time)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

fn fetch_agency(source: &SourceConfig) -> Result<FetchResult, SourceError> {
    let url = param_str(source, "url").ok_or_else(|| SourceError::Message("Paste the agency's public feed URL.".into()))?;
    let client = http(25)?;
    let text = get_text(&client, &url, StdDuration::from_secs(120))?;
    let now = Utc::now();
    let items = rss_items(&text)
        .into_iter()
        .take(30)
        .map(|item| {
            let recent = item.when.as_deref().and_then(parse_time).map(|when| now - when < Duration::hours(48)).unwrap_or(true);
            WatchItem {
                id: item.id,
                title: item.title,
                summary: item.summary.clone(),
                body: item.summary,
                severity: Some(if recent { "warn" } else { "info" }.into()),
                category: Some("agency".into()),
                area: None,
                occurred_at: item.when,
                ends_at: None,
                detail_url: item.link,
                lat: None,
                lon: None,
                metrics: vec![],
                notable: recent,
            }
        })
        .collect();
    Ok(done(
        "agency.rss",
        param_str(source, "label"),
        None,
        items,
        3 * 60_000,
        "Public agency feed".into(),
        None,
    ))
}

fn fetch_transit(source: &SourceConfig, secrets: &BTreeMap<String, String>) -> Result<FetchResult, SourceError> {
    let urls = param_str(source, "urls")
        .unwrap_or_default()
        .split_whitespace()
        .map(str::trim)
        .filter(|item| item.starts_with("http"))
        .map(str::to_string)
        .collect::<Vec<_>>();
    if urls.is_empty() {
        return Err(SourceError::Message("Paste the agency's GTFS-RT alerts URL.".into()));
    }
    let client = http(20)?;
    let token = secrets.get("transit.token").map(|value| value.trim()).filter(|value| !value.is_empty());
    let mut items = Vec::new();
    for url in urls {
        let mut request = client.get(&url);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let bytes = request.send().and_then(|response| response.error_for_status()).and_then(|response| response.bytes()).map_err(|err| SourceError::Message(format!("http error: {}", err.without_url())))?;
        for alert in gtfs::alerts(&bytes) {
            items.push(WatchItem {
                id: format!("{}-{}", url, alert.id),
                title: if alert.header.is_empty() { "Transit alert".into() } else { alert.header },
                summary: if alert.description.is_empty() { None } else { Some(alert.description.clone()) },
                body: if alert.description.is_empty() { None } else { Some(alert.description) },
                severity: Some("warn".into()),
                category: Some("transit".into()),
                area: None,
                occurred_at: None,
                ends_at: None,
                detail_url: if alert.url.is_empty() { Some(url.clone()) } else { Some(alert.url) },
                lat: None,
                lon: None,
                metrics: vec![],
                notable: true,
            });
        }
    }
    Ok(done(
        "transit.gtfs",
        place_label(source),
        if items.is_empty() { Some("No active transit alerts.".into()) } else { None },
        items,
        90_000,
        "GTFS-RT service alerts".into(),
        None,
    ))
}

fn fetch_tfr(source: &SourceConfig) -> Result<FetchResult, SourceError> {
    let (lat, lon) = coords(source)?;
    let radius = radius_mi(source, 80.0);
    let client = http(30)?;
    let admin = reverse_admin(&client, lat, lon);
    let list_text = get_text(&client, "https://tfr.faa.gov/tfrapi/exportTfrList", StdDuration::from_secs(600))?;
    let shape_text = get_text(
        &client,
        "https://tfr.faa.gov/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=TFR:V_TFR_LOC&outputFormat=application/json",
        StdDuration::from_secs(600),
    )?;
    let list: Value = serde_json::from_str(&list_text).unwrap_or(Value::Null);
    let shapes: Value = serde_json::from_str(&shape_text).unwrap_or(Value::Null);
    let items = tfr_items(&list, &shapes, lat, lon, radius, admin.as_ref().map(|item| item.state.as_str()));
    Ok(done(
        "tfr.faa",
        place_label(source),
        None,
        items,
        10 * 60_000,
        "FAA temporary flight restrictions. Informational.".into(),
        None,
    ))
}

fn tfr_items(list: &Value, shapes: &Value, lat: f64, lon: f64, radius: f64, state: Option<&str>) -> Vec<WatchItem> {
    let mut shaped = Vec::new();
    if let Some(features) = shapes.get("features").and_then(|item| item.as_array()) {
        for feature in features {
            let props = feature.get("properties");
            let key = props.and_then(|item| item.get("NOTAM_KEY")).and_then(|item| item.as_str()).unwrap_or("");
            let title = props.and_then(|item| item.get("TITLE")).and_then(|item| item.as_str()).unwrap_or(key);
            let covers = geometry_covers(feature.get("geometry"), lat, lon)
                || geometry_near(feature.get("geometry"), lat, lon, radius);
            if !covers {
                continue;
            }
            shaped.push(WatchItem {
                id: if key.is_empty() { title.to_string() } else { key.to_string() },
                title: title.to_string(),
                summary: props.and_then(|item| item.get("LEGAL")).and_then(|item| item.as_str()).map(str::to_string),
                body: None,
                severity: Some("warn".into()),
                category: Some("tfr".into()),
                area: props.and_then(|item| item.get("STATE")).and_then(|item| item.as_str()).map(str::to_string),
                occurred_at: None,
                ends_at: None,
                detail_url: Some("https://tfr.faa.gov/".into()),
                lat: Some(lat),
                lon: Some(lon),
                metrics: vec![],
                notable: true,
            });
        }
    }
    let mut shapeless = Vec::new();
    if let Some(rows) = list.as_array() {
        for row in rows {
            let id = row.get("notam_id").and_then(|item| item.as_str()).unwrap_or("");
            if id.is_empty() || shaped.iter().any(|item| item.id.contains(id)) {
                continue;
            }
            let row_state = row.get("state").and_then(|item| item.as_str()).unwrap_or("");
            if state.map(|value| value.eq_ignore_ascii_case(row_state)).unwrap_or(false) && shapeless.len() < 8 {
                shapeless.push(WatchItem {
                    id: id.to_string(),
                    title: row.get("description").and_then(|item| item.as_str()).unwrap_or(id).trim().to_string(),
                    summary: Some("No area shape yet.".into()),
                    body: None,
                    severity: Some("info".into()),
                    category: Some(row.get("type").and_then(|item| item.as_str()).unwrap_or("tfr").to_string()),
                    area: Some(row_state.to_string()),
                    occurred_at: row.get("creation_date").and_then(|item| item.as_str()).map(str::to_string),
                    ends_at: None,
                    detail_url: Some("https://tfr.faa.gov/".into()),
                    lat: None,
                    lon: None,
                    metrics: vec![],
                    notable: true,
                });
            }
        }
    }
    shaped.extend(shapeless);
    shaped
}

fn fetch_nuclear(source: &SourceConfig) -> Result<FetchResult, SourceError> {
    let client = http(30)?;
    let text = get_text(&client, "https://www.nrc.gov/public-involve/rss?feed=event", StdDuration::from_secs(1800))?;
    let admin = lookup_coords(&source.params, "lat", "lon").and_then(|(lat, lon)| reverse_admin(&client, lat, lon));
    let state_name = admin.as_ref().map(|item| item.state_name.to_ascii_lowercase());
    let state = admin.as_ref().map(|item| item.state.to_ascii_lowercase());
    let mut items = rss_items(&text)
        .into_iter()
        .take(40)
        .map(|item| {
            let haystack = format!("{} {}", item.title, item.summary.clone().unwrap_or_default()).to_ascii_lowercase();
            let beaver = haystack.contains("beaver valley") || haystack.contains("shippingport");
            let local = state.as_ref().map(|abbr| haystack.contains(abbr)).unwrap_or(false)
                || state_name.as_ref().map(|name| haystack.contains(name.as_str())).unwrap_or(false);
            WatchItem {
                id: item.id,
                title: item.title,
                summary: if beaver { Some("Beaver Valley".into()) } else { item.summary.clone() },
                body: item.summary,
                severity: Some(if beaver { "alert" } else { "info" }.into()),
                category: Some("nuclear".into()),
                area: None,
                occurred_at: item.when,
                ends_at: None,
                detail_url: item.link,
                lat: None,
                lon: None,
                metrics: vec![],
                notable: beaver || local,
            }
        })
        .collect::<Vec<_>>();
    items.sort_by_key(|item| if item.summary.as_deref() == Some("Beaver Valley") { 0 } else { 1 });
    Ok(done(
        "nuclear.nrc",
        place_label(source),
        Some("National event notices. Beaver Valley is pinned when it is in the feed.".into()),
        items,
        30 * 60_000,
        "U.S. Nuclear Regulatory Commission event notices".into(),
        None,
    ))
}

fn fetch_radiation(source: &SourceConfig) -> Result<FetchResult, SourceError> {
    let (lat, lon) = coords(source)?;
    let station = nearest_station(lat, lon).ok_or_else(|| SourceError::Message("No RadNet station is on file.".into()))?;
    let client = http(40)?;
    let year = Utc::now().year();
    let mut text = None;
    for candidate in [year, year - 1] {
        let url = format!(
            "https://radnet.epa.gov/cdx-radnet-rest/api/rest/csv/{candidate}/fixed/{}/{}",
            station.state,
            encode_path(&station.city)
        );
        if let Ok(body) = get_text(&client, &url, StdDuration::from_secs(3600)) {
            if body.to_ascii_lowercase().contains("dose") {
                text = Some(body);
                break;
            }
        }
    }
    let text = text.ok_or_else(|| SourceError::Message(format!("No RadNet file for {} {}.", station.city, station.state)))?;
    let (item, status) = radiation_item(&text, &station.city, &station.state);
    let items = item.into_iter().collect::<Vec<_>>();
    Ok(done(
        "radiation.epa",
        Some(format!("{}, {}", station.city, station.state)),
        status,
        items,
        60 * 60_000,
        "EPA RadNet".into(),
        Some("A gap in the public file is normal. A reading is flagged only against this station's own recent range.".into()),
    ))
}

#[derive(Clone, serde::Deserialize)]
struct Station {
    state: String,
    city: String,
    lat: f64,
    lon: f64,
}

fn nearest_station(lat: f64, lon: f64) -> Option<Station> {
    static CACHE: OnceLock<Vec<Station>> = OnceLock::new();
    let stations = CACHE.get_or_init(|| {
        serde_json::from_str(include_str!("radnet_stations.json")).unwrap_or_default()
    });
    stations
        .iter()
        .min_by(|a, b| {
            haversine_mi(lat, lon, a.lat, a.lon)
                .partial_cmp(&haversine_mi(lat, lon, b.lat, b.lon))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .cloned()
}

fn radiation_item(csv: &str, city: &str, state: &str) -> (Option<WatchItem>, Option<String>) {
    let rows = csv_rows(csv);
    if rows.is_empty() {
        return (None, Some("The station file was empty.".into()));
    }
    let header = &rows[0];
    let dose_col = header.iter().position(|name| name.to_ascii_lowercase().contains("dose equivalent"));
    let gamma_col = header.iter().position(|name| name.to_ascii_lowercase().starts_with("gamma count rate r02"));
    let time_col = header.iter().position(|name| name.to_ascii_lowercase().contains("sample collection"));
    let status_col = header.iter().position(|name| name.eq_ignore_ascii_case("status"));
    let mut approved = Vec::new();
    for row in rows.iter().skip(1) {
        if let Some(index) = status_col {
            if !row.get(index).map(|value| value.eq_ignore_ascii_case("APPROVED")).unwrap_or(false) {
                continue;
            }
        }
        let dose = dose_col.and_then(|index| row.get(index)).and_then(|value| value.parse::<f64>().ok());
        let gamma = gamma_col.and_then(|index| row.get(index)).and_then(|value| value.parse::<f64>().ok());
        let when = time_col.and_then(|index| row.get(index)).cloned();
        if dose.is_some() || gamma.is_some() {
            approved.push((when, dose, gamma));
        }
    }
    let Some((when, dose, gamma)) = approved.last().cloned() else {
        return (None, Some(format!("{city}, {state} has no approved reading in the current file.")));
    };
    let prior = &approved[..approved.len().saturating_sub(1)];
    let window: Vec<_> = prior.iter().rev().take(14 * 24).collect();
    let dose_range = range_of(window.iter().filter_map(|row| row.1));
    let gamma_range = range_of(window.iter().filter_map(|row| row.2));
    let dose_out = dose.and_then(|value| dose_range.map(|(low, high)| value < low || value > high)).unwrap_or(false);
    let gamma_out = gamma.and_then(|value| gamma_range.map(|(low, high)| value < low || value > high)).unwrap_or(false);
    let notable = (dose_out || gamma_out) && window.len() >= 3;
    let mut metrics = Vec::new();
    if let Some(value) = dose {
        metrics.push(WatchMetric { label: "Dose".into(), value: format!("{value:.1} nSv/h") });
    }
    if let Some(value) = gamma {
        metrics.push(WatchMetric { label: "Gamma".into(), value: format!("{value:.1} cpm") });
    }
    let status = if window.len() < 3 {
        Some("Not enough recent readings at this station to compare.".into())
    } else if notable {
        Some("The latest reading is outside this station's recent range.".into())
    } else {
        Some("Inside this station's recent range.".into())
    };
    (
        Some(WatchItem {
            id: format!("{state}-{city}"),
            title: format!("{city}, {state}"),
            summary: status.clone(),
            body: None,
            severity: Some(if notable { "alert" } else { "info" }.into()),
            category: Some("radiation".into()),
            area: Some(format!("{city}, {state}")),
            occurred_at: when,
            ends_at: None,
            detail_url: Some("https://www.epa.gov/radnet".into()),
            lat: None,
            lon: None,
            metrics,
            notable,
        }),
        status,
    )
}

fn range_of(values: impl Iterator<Item = f64>) -> Option<(f64, f64)> {
    let mut low = f64::MAX;
    let mut high = f64::MIN;
    let mut count = 0;
    for value in values {
        if !value.is_finite() {
            continue;
        }
        low = low.min(value);
        high = high.max(value);
        count += 1;
    }
    (count > 0).then_some((low, high))
}

fn fetch_spills(source: &SourceConfig) -> Result<FetchResult, SourceError> {
    let (lat, lon) = coords(source)?;
    let radius = radius_mi(source, 40.0);
    let client = http(120)?;
    let admin_points = spill_places(&client, lat, lon, radius);
    let year = Utc::now().format("%y").to_string();
    let url = format!("https://nrc.uscg.mil/FOIAFiles/CY{year}.xlsx");
    let bytes = get_bytes(&client, &url, StdDuration::from_secs(12 * 3600))?;
    let sheets = sheet::sheets_by_name(&bytes, &["CALLS", "INCIDENT_COMMONS", "MATERIAL_INVOLVED"]).map_err(SourceError::Message)?;
    let items = spill_items(&sheets, &admin_points, lat, lon, radius, Utc::now());
    Ok(done(
        "spills.uscg",
        place_label(source),
        Some("Caller reports to the Coast Guard. Not confirmed spills, and no cleanup status.".into()),
        items,
        12 * 60 * 60_000,
        "U.S. Coast Guard National Response Center".into(),
        Some("County comes from the confirmed place. A report with coordinates inside the radius is kept too.".into()),
    ))
}

struct PlaceBits {
    county: String,
    state: String,
}

fn spill_places(client: &reqwest::blocking::Client, lat: f64, lon: f64, radius: f64) -> Vec<PlaceBits> {
    let mut points = vec![(lat, lon)];
    for bearing in [0.0, 90.0, 180.0, 270.0] {
        points.push(offset_miles(lat, lon, radius * 0.7, bearing));
    }
    let mut out = Vec::new();
    for (plat, plon) in points {
        if let Some(admin) = reverse_admin(client, plat, plon) {
            if !out.iter().any(|item: &PlaceBits| item.county.eq_ignore_ascii_case(&admin.county) && item.state.eq_ignore_ascii_case(&admin.state)) {
                out.push(PlaceBits { county: admin.county, state: admin.state });
            }
        }
    }
    out
}

fn spill_items(
    sheets: &BTreeMap<String, Vec<Row>>,
    places: &[PlaceBits],
    lat: f64,
    lon: f64,
    radius: f64,
    now: DateTime<Utc>,
) -> Vec<WatchItem> {
    let calls = sheets.get("CALLS").map(Vec::as_slice).unwrap_or(&[]);
    let commons = sheets.get("INCIDENT_COMMONS").map(Vec::as_slice).unwrap_or(&[]);
    let materials = sheets.get("MATERIAL_INVOLVED").map(Vec::as_slice).unwrap_or(&[]);
    let mut by_seq: HashMap<&str, &Row> = HashMap::new();
    for row in commons {
        if let Some(seq) = row.get("SEQNOS") {
            by_seq.insert(seq, row);
        }
    }
    let mut material_by_seq: HashMap<&str, Vec<&Row>> = HashMap::new();
    for row in materials {
        if let Some(seq) = row.get("SEQNOS") {
            material_by_seq.entry(seq).or_default().push(row);
        }
    }
    let mut items = Vec::new();
    for call in calls {
        let Some(seq) = call.get("SEQNOS") else { continue };
        let common = by_seq.get(seq.as_str()).copied();
        let county = common.and_then(|row| row.get("LOCATION_COUNTY")).map(|value| normalize_county(value));
        let state = common.and_then(|row| row.get("LOCATION_STATE")).map(|value| value.trim().to_string());
        let coords = common.and_then(row_coords);
        let county_hit = county.as_ref().map(|name| {
            places.iter().any(|place| {
                place.county.eq_ignore_ascii_case(name)
                    && state.as_ref().map(|value| value.eq_ignore_ascii_case(&place.state)).unwrap_or(true)
            })
        }).unwrap_or(false);
        let coord_hit = coords.map(|(clat, clon)| haversine_mi(lat, lon, clat, clon) <= radius).unwrap_or(false);
        if !county_hit && !coord_hit {
            continue;
        }
        let when = call.get("DATE_TIME_RECEIVED").and_then(|value| value.parse::<f64>().ok()).and_then(excel_time);
        let recent = when.map(|stamp| now.signed_duration_since(stamp) < Duration::days(14) && now >= stamp).unwrap_or(false);
        if !recent && !coord_hit {
            continue;
        }
        let material = material_by_seq.get(seq.as_str()).map(|rows| {
            rows.iter().filter_map(|row| {
                let name = row.get("NAME_OF_MATERIAL")?;
                let amount = row.get("AMOUNT_OF_MATERIAL").map(String::as_str).unwrap_or("");
                let unit = row.get("UNIT_OF_MEASURE").map(String::as_str).unwrap_or("");
                Some(format!("{name} {amount} {unit}").trim().to_string())
            }).collect::<Vec<_>>().join("; ")
        }).unwrap_or_default();
        let description = common.and_then(|row| row.get("DESCRIPTION_OF_INCIDENT")).cloned().unwrap_or_default();
        items.push(WatchItem {
            id: seq.clone(),
            title: if description.is_empty() { format!("Report {seq}") } else { description.clone() },
            summary: Some(format!(
                "{} {} · caller report",
                county.clone().unwrap_or_default(),
                state.clone().unwrap_or_default()
            )),
            body: if material.is_empty() { None } else { Some(material) },
            severity: Some(if recent { "warn" } else { "info" }.into()),
            category: Some("spill report".into()),
            area: county,
            occurred_at: when.map(|stamp| stamp.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
            ends_at: None,
            detail_url: Some("https://nrc.uscg.mil/".into()),
            lat: coords.map(|pair| pair.0),
            lon: coords.map(|pair| pair.1),
            metrics: vec![],
            notable: recent,
        });
        if items.len() >= 40 {
            break;
        }
    }
    items
}

fn row_coords(row: &Row) -> Option<(f64, f64)> {
    let lat = dms(row.get("LAT_DEG")?, row.get("LAT_MIN")?, row.get("LAT_SEC")?, row.get("LAT_QUAD")?)?;
    let lon = dms(row.get("LONG_DEG")?, row.get("LONG_MIN")?, row.get("LONG_SEC")?, row.get("LONG_QUAD")?)?;
    Some((lat, lon))
}

fn dms(deg: &str, min: &str, sec: &str, quad: &str) -> Option<f64> {
    let degrees = deg.parse::<f64>().ok()?;
    let minutes = min.parse::<f64>().unwrap_or(0.0);
    let seconds = sec.parse::<f64>().unwrap_or(0.0);
    let sign = if matches!(quad.trim().to_ascii_uppercase().as_str(), "S" | "W") { -1.0 } else { 1.0 };
    Some(sign * (degrees + minutes / 60.0 + seconds / 3600.0))
}

fn excel_time(serial: f64) -> Option<DateTime<Utc>> {
    if !serial.is_finite() || serial < 1.0 {
        return None;
    }
    let days = serial.floor() as i64;
    let seconds = ((serial - days as f64) * 86400.0).round() as i64;
    let date = NaiveDate::from_ymd_opt(1899, 12, 30)?.checked_add_signed(Duration::days(days))?;
    let time = NaiveTime::from_num_seconds_from_midnight_opt(seconds.clamp(0, 86399) as u32, 0)?;
    Some(Utc.from_utc_datetime(&date.and_time(time)))
}

fn fetch_disease(source: &SourceConfig) -> Result<FetchResult, SourceError> {
    let limit = param_f64(source, "limit").unwrap_or(12.0).round().clamp(1.0, 40.0) as u32;
    let client = http(30)?;
    let top = limit.to_string();
    let text = client
        .get("https://www.who.int/api/news/diseaseoutbreaknews")
        .query(&[("$orderby", "PublicationDate desc"), ("$top", top.as_str())])
        .send()
        .and_then(|response| response.error_for_status())
        .and_then(|response| response.text())
        .map_err(|err| SourceError::Message(format!("http error: {}", err.without_url())))?;
    let value: Value = serde_json::from_str(&text).map_err(|_| SourceError::Message("WHO notices returned data this app could not read.".into()))?;
    let rows = value.get("value").and_then(|item| item.as_array()).cloned().unwrap_or_default();
    let now = Utc::now();
    let items = rows.into_iter().map(|row| {
        let title = row.get("Title").and_then(|item| item.as_str()).unwrap_or("Disease notice").to_string();
        let when = row.get("PublicationDate").and_then(|item| item.as_str()).map(str::to_string);
        let recent = when.as_deref().and_then(parse_time).map(|stamp| now - stamp < Duration::days(14)).unwrap_or(false);
        let path = row.get("ItemDefaultUrl").and_then(|item| item.as_str()).unwrap_or("");
        let url = if path.starts_with("http") { path.to_string() } else { format!("https://www.who.int{path}") };
        let summary = row.get("Summary").and_then(|item| item.as_str()).map(strip_html);
        WatchItem {
            id: row.get("DonId").and_then(|item| item.as_str()).unwrap_or(&title).to_string(),
            title,
            summary: summary.clone(),
            body: summary,
            severity: Some("info".into()),
            category: Some("disease".into()),
            area: None,
            occurred_at: when,
            ends_at: None,
            detail_url: Some(url),
            lat: None,
            lon: None,
            metrics: vec![],
            notable: recent,
        }
    }).collect();
    Ok(done(
        "disease.who",
        None,
        Some("Global notices, not a map of local cases.".into()),
        items,
        8 * 60 * 60_000,
        "World Health Organization disease outbreak news".into(),
        None,
    ))
}

fn fetch_ioda(source: &SourceConfig) -> Result<FetchResult, SourceError> {
    let (lat, lon) = coords(source)?;
    let client = http(25)?;
    let admin = reverse_admin(&client, lat, lon).ok_or_else(|| SourceError::Message("Could not tell which state this place is in.".into()))?;
    let lookup = client
        .get("https://api.ioda.inetintel.cc.gatech.edu/v2/entities/query")
        .query(&[
            ("entityType", "region"),
            ("relatedTo", "country/US"),
            ("search", admin.state_name.as_str()),
            ("limit", "5"),
        ])
        .send()
        .and_then(|response| response.error_for_status())
        .and_then(|response| response.text())
        .map_err(|err| SourceError::Message(format!("http error: {}", err.without_url())))?;
    let lookup_value: Value = serde_json::from_str(&lookup).map_err(|_| SourceError::Message("IODA region lookup returned data this app could not read.".into()))?;
    let code = ioda_region_code(&lookup_value, &admin.state_name).ok_or_else(|| SourceError::Message(format!("IODA has no region for {}.", admin.state_name)))?;
    let now = Utc::now().timestamp();
    let from = now - 24 * 3600;
    let mut items = ioda_events(&client, "region", &code, from, now)?;
    if let Some(asn) = param_str(source, "asn").filter(|value| !value.is_empty()) {
        items.extend(ioda_events(&client, "asn", &asn, from, now)?);
    }
    let copyright = lookup_value.get("copyright").and_then(|item| item.as_str()).unwrap_or(IODA_CREDIT);
    Ok(done(
        "internet.ioda",
        Some(admin.state_name.clone()),
        if items.is_empty() { Some(format!("No outage signal for {} in the last day.", admin.state_name)) } else { None },
        items,
        10 * 60_000,
        copyright.to_string(),
        Some("Shown on this computer. The data is not republished.".into()),
    ))
}

fn ioda_region_code(value: &Value, state_name: &str) -> Option<String> {
    value.get("data")?.as_array()?.iter().find_map(|row| {
        let name = row.get("name")?.as_str()?;
        let country = row.pointer("/attrs/country_code").and_then(|item| item.as_str()).unwrap_or("");
        if name.eq_ignore_ascii_case(state_name) && country.eq_ignore_ascii_case("US") {
            row.get("code").and_then(|item| item.as_str()).map(str::to_string)
        } else {
            None
        }
    })
}

fn ioda_events(client: &reqwest::blocking::Client, entity_type: &str, code: &str, from: i64, until: i64) -> Result<Vec<WatchItem>, SourceError> {
    let from_text = from.to_string();
    let until_text = until.to_string();
    let text = client
        .get("https://api.ioda.inetintel.cc.gatech.edu/v2/outages/events")
        .query(&[
            ("entityType", entity_type),
            ("entityCode", code),
            ("from", from_text.as_str()),
            ("until", until_text.as_str()),
            ("format", "ioda"),
        ])
        .send()
        .and_then(|response| response.error_for_status())
        .and_then(|response| response.text())
        .map_err(|err| SourceError::Message(format!("http error: {}", err.without_url())))?;
    let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let now = Utc::now().timestamp();
    let mut items = Vec::new();
    let Some(rows) = value.get("data").and_then(|item| item.as_array()) else {
        return Ok(items);
    };
    for (index, row) in rows.iter().enumerate() {
        let start = row.get("from").and_then(|item| item.as_i64()).unwrap_or(0);
        let end = row.get("until").and_then(|item| item.as_i64());
        let active = start <= now && end.map(|value| value >= now).unwrap_or(true);
        let score = row.get("score").and_then(|item| item.as_f64());
        let source_name = row.get("datasource").and_then(|item| item.as_str()).unwrap_or(entity_type);
        items.push(WatchItem {
            id: format!("{entity_type}-{code}-{index}-{start}"),
            title: format!("{source_name} outage signal"),
            summary: score.map(|value| format!("score {value:.0}")),
            body: None,
            severity: Some(if active { "warn" } else { "info" }.into()),
            category: Some("internet".into()),
            area: Some(code.to_string()),
            occurred_at: DateTime::from_timestamp(start, 0).map(|stamp| stamp.to_rfc3339()),
            ends_at: end.and_then(|value| DateTime::from_timestamp(value, 0)).map(|stamp| stamp.to_rfc3339()),
            detail_url: Some("https://ioda.inetintel.cc.gatech.edu/".into()),
            lat: None,
            lon: None,
            metrics: vec![],
            notable: active,
        });
    }
    Ok(items)
}

fn fetch_alarms(source: &SourceConfig, secrets: &BTreeMap<String, String>) -> Result<FetchResult, SourceError> {
    let link = param_str(source, "link").unwrap_or_else(|| "homeassistant".into());
    let mut items = Vec::new();
    if link == "homeassistant" || link == "both" {
        let base = param_str(source, "baseUrl").ok_or_else(|| SourceError::Message("Enter the Home Assistant URL on this network.".into()))?;
        let token = secrets.get("alarms.token").map(|value| value.trim()).filter(|value| !value.is_empty()).ok_or_else(|| SourceError::Message("The Home Assistant token is missing from the keyring.".into()))?;
        let client = http(20)?;
        let url = format!("{}/api/states", base.trim_end_matches('/'));
        let text = client
            .get(url)
            .bearer_auth(token)
            .send()
            .and_then(|response| response.error_for_status())
            .and_then(|response| response.text())
            .map_err(|_| SourceError::Message("Home Assistant did not answer. Check the hub URL and token.".into()))?;
        let value: Value = serde_json::from_str(&text).map_err(|_| SourceError::Message("Home Assistant returned data this app could not read.".into()))?;
        if let Some(rows) = value.as_array() {
            items.extend(ha_items(rows));
        }
    }
    if link == "mqtt" || link == "both" {
        let host_raw = param_str(source, "mqttHost").ok_or_else(|| SourceError::Message("Enter the MQTT host on this network.".into()))?;
        let (host, port_from_url) = split_mqtt(&host_raw);
        let port = param_f64(source, "mqttPort").map(|value| value as u16).or(port_from_url).unwrap_or(1883);
        let topic = param_str(source, "topic").filter(|value| !value.is_empty()).unwrap_or_else(|| "homeassistant/#".into());
        let messages = mqtt::listen(&host, port, &topic, StdDuration::from_millis(1500)).map_err(SourceError::Message)?;
        items.extend(mqtt_items(&messages));
    }
    let tripped = items.iter().any(|item| item.notable);
    Ok(done(
        "alarms.home",
        param_str(source, "label"),
        if tripped { None } else { Some("No sensors are tripped.".into()) },
        items,
        30_000,
        "Local alarm hub".into(),
        None,
    ))
}

fn ha_items(rows: &[Value]) -> Vec<WatchItem> {
    let mut out = Vec::new();
    for row in rows {
        let class = row.pointer("/attributes/device_class").and_then(|item| item.as_str()).unwrap_or("");
        let name = row.pointer("/attributes/friendly_name").and_then(|item| item.as_str()).unwrap_or("");
        let entity = row.get("entity_id").and_then(|item| item.as_str()).unwrap_or("");
        let state = row.get("state").and_then(|item| item.as_str()).unwrap_or("");
        let Some((severity, notable)) = alarm_level(class, name, entity, state) else { continue };
        out.push(WatchItem {
            id: entity.to_string(),
            title: if name.is_empty() { entity.to_string() } else { name.to_string() },
            summary: Some(state.to_string()),
            body: None,
            severity: Some(severity.into()),
            category: Some(if class.is_empty() { "alarm".into() } else { class.to_string() }),
            area: None,
            occurred_at: row.get("last_changed").and_then(|item| item.as_str()).map(str::to_string),
            ends_at: None,
            detail_url: None,
            lat: None,
            lon: None,
            metrics: vec![],
            notable,
        });
        if out.len() >= 40 {
            break;
        }
    }
    out
}

fn mqtt_items(messages: &[mqtt::MqttMessage]) -> Vec<WatchItem> {
    messages.iter().filter_map(|message| {
        let parsed: Value = serde_json::from_str(&message.payload).unwrap_or(Value::Null);
        let class = parsed.get("device_class").and_then(|item| item.as_str()).unwrap_or("");
        let state = parsed.get("state").and_then(|item| item.as_str()).unwrap_or(message.payload.as_str());
        let name = parsed.get("name").and_then(|item| item.as_str()).unwrap_or(message.topic.as_str());
        let (severity, notable) = alarm_level(class, name, &message.topic, state)?;
        Some(WatchItem {
            id: message.topic.clone(),
            title: name.to_string(),
            summary: Some(state.to_string()),
            body: None,
            severity: Some(severity.into()),
            category: Some("mqtt".into()),
            area: None,
            occurred_at: None,
            ends_at: None,
            detail_url: None,
            lat: None,
            lon: None,
            metrics: vec![],
            notable,
        })
    }).take(40).collect()
}

fn alarm_level(class: &str, name: &str, topic: &str, state: &str) -> Option<(&'static str, bool)> {
    let haystack = format!("{class} {name} {topic}").to_ascii_lowercase();
    let kind = if haystack.contains("carbon_monoxide") || haystack.contains("carbon monoxide") || haystack.contains(" co ") || class == "carbon_monoxide" {
        "alert"
    } else if class == "smoke" || class == "gas" || haystack.contains("smoke") || haystack.contains("gas") {
        "alert"
    } else if matches!(class, "moisture" | "safety" | "door" | "garage_door" | "window" | "opening")
        || haystack.contains("water")
        || haystack.contains("sump")
        || haystack.contains("door")
        || haystack.contains("gate")
    {
        "warn"
    } else {
        return None;
    };
    let lower = state.trim().to_ascii_lowercase();
    let tripped = matches!(lower.as_str(), "on" | "open" | "problem" | "unsafe" | "tripped")
        || lower.parse::<f64>().ok().map(|value| value > 0.0).unwrap_or(false);
    let clear = matches!(lower.as_str(), "off" | "closed" | "ok" | "safe" | "0" | "normal");
    if !tripped && !clear {
        return None;
    }
    Some((if tripped { kind } else { "info" }, tripped))
}

fn geometry_covers(geometry: Option<&Value>, lat: f64, lon: f64) -> bool {
    let Some(geometry) = geometry else { return false };
    match geometry.get("type").and_then(|item| item.as_str()) {
        Some("Polygon") => rings_cover(geometry.get("coordinates"), lat, lon),
        Some("MultiPolygon") => geometry
            .get("coordinates")
            .and_then(|item| item.as_array())
            .map(|polygons| polygons.iter().any(|rings| rings_cover(Some(rings), lat, lon)))
            .unwrap_or(false),
        _ => false,
    }
}

fn rings_cover(coordinates: Option<&Value>, lat: f64, lon: f64) -> bool {
    let Some(rings) = coordinates.and_then(|item| item.as_array()) else { return false };
    let Some(outer) = rings.first().and_then(|item| item.as_array()) else { return false };
    point_in_ring(outer, lon, lat)
}

fn point_in_ring(ring: &[Value], lon: f64, lat: f64) -> bool {
    let mut inside = false;
    let mut previous = match ring.last().and_then(pair) {
        Some(point) => point,
        None => return false,
    };
    for point in ring.iter().filter_map(pair) {
        let (x1, y1) = previous;
        let (x2, y2) = point;
        if ((y1 > lat) != (y2 > lat)) && (lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1) {
            inside = !inside;
        }
        previous = point;
    }
    inside
}

fn geometry_near(geometry: Option<&Value>, lat: f64, lon: f64, radius: f64) -> bool {
    let Some(geometry) = geometry else { return false };
    let mut near = false;
    walk_coords(geometry, &mut |clon, clat| {
        if haversine_mi(lat, lon, clat, clon) <= radius {
            near = true;
        }
    });
    near
}

fn walk_coords(value: &Value, visit: &mut impl FnMut(f64, f64)) {
    if let Some(pair) = pair(value) {
        visit(pair.0, pair.1);
        return;
    }
    if let Some(rows) = value.as_array() {
        if value.get("coordinates").is_some() {
            if let Some(coords) = value.get("coordinates") {
                walk_coords(coords, visit);
            }
            return;
        }
        for row in rows {
            walk_coords(row, visit);
        }
    } else if let Some(coords) = value.get("coordinates") {
        walk_coords(coords, visit);
    }
}

fn pair(value: &Value) -> Option<(f64, f64)> {
    let row = value.as_array()?;
    if row.len() < 2 {
        return None;
    }
    Some((row[0].as_f64()?, row[1].as_f64()?))
}

struct RssRow {
    id: String,
    title: String,
    link: Option<String>,
    when: Option<String>,
    summary: Option<String>,
}

fn rss_items(xml: &str) -> Vec<RssRow> {
    let mut blocks = element_blocks(xml, "item");
    if blocks.is_empty() {
        blocks = element_blocks(xml, "entry");
    }
    blocks.into_iter().filter_map(|block| {
        let title = element_text(block, "title")?;
        let link = element_text(block, "link").or_else(|| attr_from_tag(block, "link", "href"));
        let when = element_text(block, "pubDate").or_else(|| element_text(block, "published")).or_else(|| element_text(block, "updated"));
        let summary = element_text(block, "description").or_else(|| element_text(block, "summary")).map(|text| strip_html(&text));
        let id = element_text(block, "guid").or_else(|| element_text(block, "id")).unwrap_or_else(|| title.clone());
        Some(RssRow { id, title, link, when, summary })
    }).collect()
}

fn element_blocks<'a>(xml: &'a str, name: &str) -> Vec<&'a str> {
    let lower = xml.to_ascii_lowercase();
    let open = format!("<{name}");
    let close = format!("</{name}>");
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(start) = lower[from..].find(&open) {
        let start = from + start;
        let Some(end) = lower[start..].find(&close) else { break };
        let end = start + end + close.len();
        out.push(&xml[start..end]);
        from = end;
        if out.len() >= 80 {
            break;
        }
    }
    out
}

fn element_text(block: &str, name: &str) -> Option<String> {
    let lower = block.to_ascii_lowercase();
    let open = format!("<{name}");
    let start = lower.find(&open)?;
    let after = &block[start..];
    let gt = after.find('>')?;
    if after[..gt].contains("/>") {
        return None;
    }
    let rest = &after[gt + 1..];
    let close = format!("</{name}>");
    let end = rest.to_ascii_lowercase().find(&close)?;
    let text = strip_html(&unescape_basic(&rest[..end]));
    if text.is_empty() { None } else { Some(text) }
}

fn attr_from_tag(block: &str, tag: &str, name: &str) -> Option<String> {
    let lower = block.to_ascii_lowercase();
    let open = format!("<{tag}");
    let start = lower.find(&open)?;
    let after = &block[start..];
    let gt = after.find('>')?;
    let tag_text = &after[..=gt];
    let pattern = format!("{name}=\"");
    let at = tag_text.find(&pattern)?;
    let rest = &tag_text[at + pattern.len()..];
    let end = rest.find('"')?;
    Some(unescape_basic(&rest[..end]))
}

fn unescape_basic(value: &str) -> String {
    value.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'")
}

fn strip_html(value: &str) -> String {
    let mut out = String::new();
    let mut inside = false;
    for ch in value.chars() {
        if ch == '<' {
            inside = true;
            continue;
        }
        if ch == '>' {
            inside = false;
            out.push(' ');
            continue;
        }
        if !inside {
            out.push(ch);
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn xml_values(xml: &str, name: &str) -> Vec<String> {
    element_blocks(xml, name).into_iter().filter_map(|block| element_text(block, name)).collect()
}

struct Admin {
    county: String,
    state: String,
    state_name: String,
}

fn reverse_admin(client: &reqwest::blocking::Client, lat: f64, lon: f64) -> Option<Admin> {
    let value: Value = client
        .get(format!("https://photon.komoot.io/reverse?lat={lat}&lon={lon}"))
        .send()
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .ok()?;
    let props = value.pointer("/features/0/properties")?.as_object()?;
    let state_name = props.get("state")?.as_str()?.trim().to_string();
    let state = state_abbrev(&state_name).unwrap_or(state_name.as_str()).to_string();
    let county = normalize_county(props.get("county").and_then(|item| item.as_str()).unwrap_or(""));
    Some(Admin { county, state, state_name })
}

fn normalize_county(value: &str) -> String {
    value.trim().trim_end_matches('.').trim().trim_end_matches(" County").trim_end_matches(" county").trim().to_string()
}

fn state_abbrev(name: &str) -> Option<&'static str> {
    let pairs = [
        ("Alabama", "AL"), ("Alaska", "AK"), ("Arizona", "AZ"), ("Arkansas", "AR"), ("California", "CA"),
        ("Colorado", "CO"), ("Connecticut", "CT"), ("Delaware", "DE"), ("Florida", "FL"), ("Georgia", "GA"),
        ("Hawaii", "HI"), ("Idaho", "ID"), ("Illinois", "IL"), ("Indiana", "IN"), ("Iowa", "IA"),
        ("Kansas", "KS"), ("Kentucky", "KY"), ("Louisiana", "LA"), ("Maine", "ME"), ("Maryland", "MD"),
        ("Massachusetts", "MA"), ("Michigan", "MI"), ("Minnesota", "MN"), ("Mississippi", "MS"), ("Missouri", "MO"),
        ("Montana", "MT"), ("Nebraska", "NE"), ("Nevada", "NV"), ("New Hampshire", "NH"), ("New Jersey", "NJ"),
        ("New Mexico", "NM"), ("New York", "NY"), ("North Carolina", "NC"), ("North Dakota", "ND"), ("Ohio", "OH"),
        ("Oklahoma", "OK"), ("Oregon", "OR"), ("Pennsylvania", "PA"), ("Rhode Island", "RI"), ("South Carolina", "SC"),
        ("South Dakota", "SD"), ("Tennessee", "TN"), ("Texas", "TX"), ("Utah", "UT"), ("Vermont", "VT"),
        ("Virginia", "VA"), ("Washington", "WA"), ("West Virginia", "WV"), ("Wisconsin", "WI"), ("Wyoming", "WY"),
        ("District of Columbia", "DC"),
    ];
    pairs.iter().find(|(full, _)| full.eq_ignore_ascii_case(name)).map(|(_, abbr)| *abbr)
}

fn split_mqtt(raw: &str) -> (String, Option<u16>) {
    let trimmed = raw.trim().trim_start_matches("mqtt://").trim_start_matches("tcp://");
    if let Some((host, port)) = trimmed.rsplit_once(':') {
        if let Ok(port) = port.parse::<u16>() {
            return (host.to_string(), Some(port));
        }
    }
    (trimmed.to_string(), None)
}

fn encode_path(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | '(' | ')') {
            out.push(ch);
        } else {
            for byte in ch.to_string().into_bytes() {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    out
}

fn csv_rows(text: &str) -> Vec<Vec<String>> {
    text.lines().filter(|line| !line.trim().is_empty()).map(parse_csv_line).collect()
}

fn parse_csv_line(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for ch in line.chars() {
        if ch == '"' {
            quoted = !quoted;
            continue;
        }
        if ch == ',' && !quoted {
            out.push(current.trim().to_string());
            current.clear();
        } else {
            current.push(ch);
        }
    }
    out.push(current.trim().to_string());
    out
}

fn parse_time(value: &str) -> Option<DateTime<Utc>> {
    let text = value.trim();
    if let Ok(when) = DateTime::parse_from_rfc3339(text) {
        return Some(when.with_timezone(&Utc));
    }
    if let Ok(when) = DateTime::parse_from_rfc2822(text) {
        return Some(when.with_timezone(&Utc));
    }
    None
}

fn http(timeout_secs: u64) -> Result<reqwest::blocking::Client, SourceError> {
    reqwest::blocking::Client::builder()
        .user_agent(UA)
        .timeout(StdDuration::from_secs(timeout_secs))
        .build()
        .map_err(|err| SourceError::Message(format!("http error: {}", err.without_url())))
}

fn cache() -> &'static Mutex<HashMap<String, (Instant, Vec<u8>)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, Vec<u8>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn get_bytes(client: &reqwest::blocking::Client, url: &str, max_age: StdDuration) -> Result<Vec<u8>, SourceError> {
    if let Some(hit) = cache().lock().ok().and_then(|guard| {
        guard.get(url).and_then(|(at, bytes)| (at.elapsed() < max_age).then(|| bytes.clone()))
    }) {
        return Ok(hit);
    }
    let response = client.get(url).send().map_err(|err| SourceError::Message(format!("http error: {}", err.without_url())))?;
    let response = response.error_for_status().map_err(|err| SourceError::Message(format!("http error: {}", err.without_url())))?;
    let bytes = response.bytes().map_err(|err| SourceError::Message(format!("http error: {}", err.without_url())))?.to_vec();
    if let Ok(mut guard) = cache().lock() {
        guard.insert(url.to_string(), (Instant::now(), bytes.clone()));
    }
    Ok(bytes)
}

fn get_text(client: &reqwest::blocking::Client, url: &str, max_age: StdDuration) -> Result<String, SourceError> {
    let bytes = get_bytes(client, url, max_age)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn coords(source: &SourceConfig) -> Result<(f64, f64), SourceError> {
    lookup_coords(&source.params, "lat", "lon").ok_or_else(|| SourceError::Message("Confirm a location before this source can load.".into()))
}

fn place_label(source: &SourceConfig) -> Option<String> {
    source
        .params
        .get("location")
        .and_then(|value| value.get("label"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn param_str(source: &SourceConfig, key: &str) -> Option<String> {
    source.params.get(key).and_then(|value| match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
        }
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    })
}

fn param_f64(source: &SourceConfig, key: &str) -> Option<f64> {
    source.params.get(key).and_then(|value| match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.parse().ok(),
        _ => None,
    })
}

fn radius_mi(source: &SourceConfig, fallback: f64) -> f64 {
    param_f64(source, "radiusMi").filter(|value| value.is_finite() && *value > 0.0).unwrap_or(fallback)
}

fn bbox(lat: f64, lon: f64, miles: f64) -> (f64, f64, f64, f64) {
    let dlat = miles / 69.0;
    let dlon = miles / (69.0 * lat.to_radians().cos().abs().max(0.2));
    (lat - dlat, lon - dlon, lat + dlat, lon + dlon)
}

fn haversine_mi(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let r = 3958.8;
    let p1 = lat1.to_radians();
    let p2 = lat2.to_radians();
    let dlat = (lat2 - lat1).to_radians();
    let dlon = (lon2 - lon1).to_radians();
    let a = (dlat / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * r * a.sqrt().asin()
}

fn offset_miles(lat: f64, lon: f64, miles: f64, bearing_deg: f64) -> (f64, f64) {
    let r = 3958.8;
    let bearing = bearing_deg.to_radians();
    let lat1 = lat.to_radians();
    let lon1 = lon.to_radians();
    let lat2 = (lat1.sin() * (miles / r).cos() + lat1.cos() * (miles / r).sin() * bearing.cos()).asin();
    let lon2 = lon1 + (bearing.sin() * (miles / r).sin() * lat1.cos()).atan2((miles / r).cos() - lat1.sin() * lat2.sin());
    (lat2.to_degrees(), lon2.to_degrees())
}

fn done(
    kind: &str,
    place: Option<String>,
    status: Option<String>,
    items: Vec<WatchItem>,
    poll_after_ms: u64,
    attribution: String,
    note: Option<String>,
) -> FetchResult {
    FetchResult {
        fetched_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        attribution,
        note,
        watch: WatchPayload {
            kind: kind.into(),
            place_label: place,
            headline: None,
            status,
            items,
            poll_after_ms,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flood_categories_and_crest() {
        assert_eq!(flood_severity(Some("action")).1, true);
        assert_eq!(flood_severity(Some("moderate")).0, "alert");
        assert!(!flood_severity(Some("no_flooding")).1);
        let forecast = serde_json::json!({"data": [{"primary": 10.2}, {"primary": 12.4}, {"primary": 11.0}]});
        assert_eq!(forecast_crest(&forecast), Some(12.4));
    }

    #[test]
    fn outlook_keeps_thunderstorms_off_the_alert_list() {
        let outlook = serde_json::json!({
            "features": [{
                "geometry": {"type": "Polygon", "coordinates": [[[-80.2, 40.2], [-79.4, 40.2], [-79.4, 40.8], [-80.2, 40.8], [-80.2, 40.2]]]},
                "properties": {"LABEL": "TSTM", "LABEL2": "General Thunderstorms Risk"}
            }, {
                "geometry": {"type": "Polygon", "coordinates": [[[-100.0, 30.0], [-99.0, 30.0], [-99.0, 31.0], [-100.0, 31.0], [-100.0, 30.0]]]},
                "properties": {"LABEL": "MDT", "LABEL2": "Moderate"}
            }]
        });
        let items = outlook_items(&outlook, "category", 40.5, -79.8);
        assert_eq!(items.len(), 1);
        assert!(!items[0].notable);
        assert!(items[0].title.contains("TSTM"));
    }

    #[test]
    fn excel_serial_lands_in_2026() {
        let when = excel_time(46023.5).unwrap();
        assert_eq!(when.year(), 2026);
    }

    #[test]
    fn spill_fixture_joins_the_county_report() {
        let bytes = include_bytes!("fixtures/spills_min.xlsx");
        let sheets = sheet::sheets_by_name(bytes, &["CALLS", "INCIDENT_COMMONS", "MATERIAL_INVOLVED"]).unwrap();
        let when = excel_time(46023.5).unwrap();
        let items = spill_items(
            &sheets,
            &[PlaceBits { county: "Allegheny".into(), state: "PA".into() }],
            40.48,
            -79.95,
            40.0,
            when + Duration::days(1),
        );
        assert_eq!(items.len(), 1);
        assert!(items[0].notable);
        assert!(items[0].body.as_deref().unwrap().contains("Diesel"));
    }

    #[test]
    fn radiation_flags_only_outside_the_station_range() {
        let csv = "LOCATION_NAME,SAMPLE COLLECTION TIME,DOSE EQUIVALENT RATE (nSv/h),GAMMA COUNT RATE R02 (CPM),STATUS\n\
Pittsburgh,2026-11-01 00:00:00,40,100,APPROVED\n\
Pittsburgh,2026-11-02 00:00:00,42,101,APPROVED\n\
Pittsburgh,2026-11-03 00:00:00,41,99,APPROVED\n\
Pittsburgh,2026-11-04 00:00:00,90,100,APPROVED\n";
        let (item, _) = radiation_item(csv, "PITTSBURGH", "PA");
        let item = item.unwrap();
        assert!(item.notable);
        let quiet = "LOCATION_NAME,SAMPLE COLLECTION TIME,DOSE EQUIVALENT RATE (nSv/h),STATUS\n\
A,2026-11-01,40,APPROVED\nA,2026-11-02,42,APPROVED\nA,2026-11-03,41,APPROVED\nA,2026-11-04,41,APPROVED\n";
        let (item, _) = radiation_item(quiet, "PITTSBURGH", "PA");
        assert!(!item.unwrap().notable);
    }

    #[test]
    fn ioda_picks_pennsylvania() {
        let value = serde_json::json!({"data": [{"code": "4455", "name": "Pennsylvania", "attrs": {"country_code": "US"}}]});
        assert_eq!(ioda_region_code(&value, "Pennsylvania").as_deref(), Some("4455"));
    }

    #[test]
    fn alarm_smoke_on_is_an_alert() {
        let (severity, notable) = alarm_level("smoke", "Hall", "binary_sensor.hall", "on").unwrap();
        assert_eq!(severity, "alert");
        assert!(notable);
        let (severity, notable) = alarm_level("moisture", "Sump", "binary_sensor.sump", "on").unwrap();
        assert_eq!(severity, "warn");
        assert!(notable);
        assert!(alarm_level("smoke", "Hall", "binary_sensor.hall", "off").unwrap().0 == "info");
    }
}
