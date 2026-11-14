//! NOAA SWPC space weather and aurora.
//!
//! Public products, no key: <https://services.swpc.noaa.gov/>
//! Alerts, R/S/G scales, planetary Kp, 10.7 cm flux, GOES X-ray, OVATION aurora.
//! The panel pairs bands from a saved `ham.swpc` source in the UI. This module
//! does not read or change that source.

use crate::config::SourceConfig;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const ALERTS: &str = "https://services.swpc.noaa.gov/products/alerts.json";
const SCALES: &str = "https://services.swpc.noaa.gov/products/noaa-scales.json";
const KP: &str = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json";
const KP_NOW: &str = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json";
const FLUX: &str = "https://services.swpc.noaa.gov/json/f107_cm_flux.json";
const XRAY: &str = "https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json";
const OVATION: &str = "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json";
const ALERTS_PAGE: &str = "https://www.swpc.noaa.gov/products/alerts-watches-and-warnings";
const SCALES_PAGE: &str = "https://www.swpc.noaa.gov/noaa-scales-explanation";
const USER_AGENT: &str =
    "CommandCenter/0.1 (personal space weather; +https://github.com/nlaero/CommandCenter)";

/// A personal board does not poll these products faster than every 5 minutes.
pub const MIN_POLL: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceScale {
    pub level: u8,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceScales {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_at: Option<String>,
    pub radio: SpaceScale,
    pub solar: SpaceScale,
    pub geomagnetic: SpaceScale,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceAlert {
    pub id: String,
    pub code: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issued_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_until: Option<String>,
    pub severity: String,
    pub notable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuroraPoint {
    pub lon: f64,
    pub lat: f64,
    pub chance: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpacePayload {
    pub lat: f64,
    pub lon: f64,
    pub hemisphere: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kp: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kp_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_kp: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_kp_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solar_flux: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solar_flux_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub xray_class: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub xray_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aurora_chance: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aurora_observed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aurora_forecast_at: Option<String>,
    pub aurora_points: Vec<AuroraPoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scales: Option<SpaceScales>,
    pub alerts: Vec<SpaceAlert>,
    pub poll_after_ms: u64,
}

#[derive(Debug, Clone)]
pub struct FetchResult {
    pub space: SpacePayload,
    pub attribution: String,
    pub fetched_at: String,
    pub note: Option<String>,
}

#[derive(Clone)]
struct Products {
    fetched: Instant,
    alerts: Option<Value>,
    scales: Option<Value>,
    kp: Option<Value>,
    kp_now: Option<Value>,
    flux: Option<Value>,
    xray: Option<Value>,
    ovation: Option<Value>,
}

impl Products {
    fn any(&self) -> bool {
        self.alerts.is_some()
            || self.scales.is_some()
            || self.kp.is_some()
            || self.kp_now.is_some()
            || self.flux.is_some()
            || self.xray.is_some()
            || self.ovation.is_some()
    }
}

fn cache() -> &'static Mutex<Option<Products>> {
    static CACHE: OnceLock<Mutex<Option<Products>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn cache_lock() -> std::sync::MutexGuard<'static, Option<Products>> {
    cache().lock().unwrap_or_else(|err| err.into_inner())
}

pub fn fetch(source: &SourceConfig) -> Result<FetchResult, super::SourceError> {
    let (lat, lon) = crate::location::lookup_coords(&source.params, "lat", "lon")
        .ok_or_else(|| super::SourceError::Message("latitude and longitude are required".into()))?;
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return Err(super::SourceError::Message("lat/lon out of range".into()));
    }
    let hemisphere = map_hemisphere(param_str(source, "hemisphere").as_deref(), lat);
    let show_aurora = param_bool(source, "showAurora").unwrap_or(true);

    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(30))
        .build()?;
    let products = load_products(&client)?;
    let built = build_snapshot(lat, lon, &hemisphere, show_aurora, &products);
    Ok(FetchResult {
        space: built.space,
        attribution: "NOAA SWPC · alerts, scales, Kp, 10.7 cm flux, GOES X-ray, OVATION aurora"
            .into(),
        fetched_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        note: Some(built.note),
    })
}

fn load_products(client: &reqwest::blocking::Client) -> Result<Products, super::SourceError> {
    {
        let guard = cache_lock();
        if let Some(existing) = guard.as_ref() {
            if existing.fetched.elapsed() < MIN_POLL && existing.any() {
                return Ok(existing.clone());
            }
        }
    }
    let previous = cache_lock().clone();
    let next = fetch_all(client, previous.as_ref());
    if !next.any() {
        return Err(super::SourceError::Message(
            "Couldn't reach NOAA SWPC.".into(),
        ));
    }
    *cache_lock() = Some(next.clone());
    Ok(next)
}

fn fetch_all(client: &reqwest::blocking::Client, previous: Option<&Products>) -> Products {
    Products {
        fetched: Instant::now(),
        alerts: get_json(client, ALERTS).or_else(|| previous.and_then(|p| p.alerts.clone())),
        scales: get_json(client, SCALES).or_else(|| previous.and_then(|p| p.scales.clone())),
        kp: get_json(client, KP).or_else(|| previous.and_then(|p| p.kp.clone())),
        kp_now: get_json(client, KP_NOW).or_else(|| previous.and_then(|p| p.kp_now.clone())),
        flux: get_json(client, FLUX).or_else(|| previous.and_then(|p| p.flux.clone())),
        xray: get_json(client, XRAY).or_else(|| previous.and_then(|p| p.xray.clone())),
        ovation: get_json(client, OVATION).or_else(|| previous.and_then(|p| p.ovation.clone())),
    }
}

fn get_json(client: &reqwest::blocking::Client, url: &str) -> Option<Value> {
    let response = client.get(url).send().ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json().ok()
}

struct Built {
    space: SpacePayload,
    note: String,
}

fn build_snapshot(
    lat: f64,
    lon: f64,
    hemisphere: &str,
    show_aurora: bool,
    products: &Products,
) -> Built {
    let scales = products.scales.as_ref().and_then(parse_scales);
    let planetary = products.kp.as_ref().and_then(parse_planetary_kp);
    let estimated = products.kp_now.as_ref().and_then(parse_estimated_kp);
    let flux = products.flux.as_ref().and_then(parse_solar_flux);
    let xray = products.xray.as_ref().and_then(parse_xray);
    let ovation = products.ovation.as_ref().and_then(parse_ovation);
    let mut alerts = scales.as_ref().map(scale_alerts).unwrap_or_default();
    if let Some(body) = products.alerts.as_ref() {
        alerts.extend(parse_alerts(body));
    }
    let chance = ovation
        .as_ref()
        .and_then(|grid| nearest_aurora(&grid.coordinates, lat, lon));
    let points = if show_aurora {
        ovation
            .as_ref()
            .map(|grid| select_aurora_points(&grid.coordinates, hemisphere))
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let mut gaps = Vec::new();
    if products.alerts.is_none() {
        gaps.push("alerts");
    }
    if scales.is_none() {
        gaps.push("scales");
    }
    if planetary.is_none() && estimated.is_none() {
        gaps.push("Kp");
    }
    if flux.is_none() {
        gaps.push("10.7 cm flux");
    }
    if xray.is_none() {
        gaps.push("X-ray");
    }
    if ovation.is_none() {
        gaps.push("aurora forecast");
    }
    let note = if gaps.is_empty() {
        "Polled no faster than every 5 minutes. Aurora chance is the nearest OVATION grid point."
            .to_string()
    } else {
        format!(
            "Some NOAA SWPC products did not load: {}. Polled no faster than every 5 minutes.",
            gaps.join(", ")
        )
    };
    let remain = MIN_POLL.saturating_sub(products.fetched.elapsed());
    Built {
        note,
        space: SpacePayload {
            lat,
            lon,
            hemisphere: hemisphere.to_string(),
            kp: planetary.as_ref().map(|row| row.value),
            kp_time: planetary.and_then(|row| row.time),
            estimated_kp: estimated.as_ref().map(|row| row.value),
            estimated_kp_time: estimated.and_then(|row| row.time),
            solar_flux: flux.as_ref().map(|row| row.value),
            solar_flux_time: flux.and_then(|row| row.time),
            xray_class: xray.as_ref().map(|row| row.class_name.clone()),
            xray_time: xray.and_then(|row| row.time),
            aurora_chance: chance,
            aurora_observed_at: ovation.as_ref().and_then(|grid| grid.observed_at.clone()),
            aurora_forecast_at: ovation.as_ref().and_then(|grid| grid.forecast_at.clone()),
            aurora_points: points,
            scales,
            alerts,
            poll_after_ms: remain.as_millis().max(1000) as u64,
        },
    }
}

struct Timed {
    value: f64,
    time: Option<String>,
}

struct Xray {
    class_name: String,
    time: Option<String>,
}

struct Grid {
    observed_at: Option<String>,
    forecast_at: Option<String>,
    coordinates: Vec<(f64, f64, f64)>,
}

pub(crate) fn xray_class(flux: f64) -> Option<String> {
    if !flux.is_finite() || flux <= 0.0 {
        return None;
    }
    let bands = [
        ("X", 1e-4),
        ("M", 1e-5),
        ("C", 1e-6),
        ("B", 1e-7),
        ("A", 1e-8),
    ];
    for (letter, floor) in bands {
        if flux >= floor {
            return Some(format_class(letter, flux / floor));
        }
    }
    Some(format_class("A", flux / 1e-8))
}

fn format_class(letter: &str, magnitude: f64) -> String {
    if magnitude >= 10.0 {
        format!("{letter}{magnitude:.0}")
    } else {
        format!("{letter}{magnitude:.1}")
    }
}

pub(crate) fn map_hemisphere(setting: Option<&str>, lat: f64) -> String {
    match setting
        .unwrap_or("auto")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "north" | "south" | "both" => setting.unwrap_or("auto").trim().to_ascii_lowercase(),
        _ => {
            if lat > 0.0 {
                "north".into()
            } else if lat < 0.0 {
                "south".into()
            } else {
                "both".into()
            }
        }
    }
}

fn parse_scales(body: &Value) -> Option<SpaceScales> {
    let current = body.get("0")?;
    let date = text_field(current, &["DateStamp", "dateStamp"]);
    let time = text_field(current, &["TimeStamp", "timeStamp"]);
    let observed_at = match (date.as_deref(), time.as_deref()) {
        (Some(date), Some(time)) => parse_swpc_time(&format!("{date} {time}")).map(iso),
        (Some(date), None) => parse_swpc_time(&format!("{date} 00:00:00")).map(iso),
        _ => None,
    };
    Some(SpaceScales {
        observed_at,
        radio: read_scale(current.get("R").or_else(|| current.get("r"))),
        solar: read_scale(current.get("S").or_else(|| current.get("s"))),
        geomagnetic: read_scale(current.get("G").or_else(|| current.get("g"))),
    })
}

fn read_scale(value: Option<&Value>) -> SpaceScale {
    let raw = value.and_then(|row| text_field(row, &["Scale", "scale"]));
    let level = raw
        .as_deref()
        .and_then(|text| text.parse::<u8>().ok())
        .filter(|level| *level <= 5)
        .unwrap_or(0);
    let text = value
        .and_then(|row| text_field(row, &["Text", "text"]))
        .unwrap_or_else(|| "none".into());
    SpaceScale { level, text }
}

fn parse_planetary_kp(body: &Value) -> Option<Timed> {
    let row = latest_row(body, |candidate| {
        num_field(candidate, &["Kp", "kp"]).is_some()
    })?;
    Some(Timed {
        value: num_field(&row, &["Kp", "kp"])?,
        time: stamp(&row),
    })
}

fn parse_estimated_kp(body: &Value) -> Option<Timed> {
    let row = latest_row(body, |candidate| {
        num_field(candidate, &["estimated_kp", "estimatedKp"]).is_some()
    })?;
    Some(Timed {
        value: num_field(&row, &["estimated_kp", "estimatedKp"])?,
        time: stamp(&row),
    })
}

fn parse_solar_flux(body: &Value) -> Option<Timed> {
    let row = latest_row(body, |candidate| num_field(candidate, &["flux"]).is_some())?;
    Some(Timed {
        value: num_field(&row, &["flux"])?,
        time: stamp(&row),
    })
}

fn parse_xray(body: &Value) -> Option<Xray> {
    let row = latest_row(body, |candidate| {
        text_field(candidate, &["energy"])
            .map(|energy| energy.eq_ignore_ascii_case("0.1-0.8nm"))
            .unwrap_or(false)
            && num_field(candidate, &["flux"]).is_some()
    })?;
    let flux = num_field(&row, &["flux"])?;
    Some(Xray {
        class_name: xray_class(flux)?,
        time: stamp(&row),
    })
}

fn stamp(row: &Value) -> Option<String> {
    let raw = text_field(row, &["time_tag", "timeTag", "time"])?;
    Some(parse_swpc_time(&raw).map(iso).unwrap_or(raw))
}

fn parse_ovation(body: &Value) -> Option<Grid> {
    let coords = body.get("coordinates")?.as_array()?;
    let mut coordinates = Vec::new();
    for item in coords {
        let Some(row) = item.as_array() else { continue };
        if row.len() < 3 {
            continue;
        }
        let (Some(lon), Some(lat), Some(chance)) =
            (row[0].as_f64(), row[1].as_f64(), row[2].as_f64())
        else {
            continue;
        };
        coordinates.push((lon, lat, chance));
    }
    if coordinates.is_empty() {
        return None;
    }
    let observed = text_field(body, &["Observation Time", "observationTime"]);
    let forecast = text_field(body, &["Forecast Time", "forecastTime"]);
    Some(Grid {
        observed_at: observed
            .as_deref()
            .and_then(|value| parse_swpc_time(value).map(iso).or(Some(value.to_string()))),
        forecast_at: forecast
            .as_deref()
            .and_then(|value| parse_swpc_time(value).map(iso).or(Some(value.to_string()))),
        coordinates,
    })
}

fn nearest_aurora(coordinates: &[(f64, f64, f64)], lat: f64, lon: f64) -> Option<f64> {
    let mut best = f64::INFINITY;
    let mut chance = None;
    for (point_lon, point_lat, value) in coordinates {
        let d_lat = point_lat - lat;
        let mut d_lon = point_lon - lon;
        d_lon = ((d_lon + 540.0) % 360.0) - 180.0;
        let dist = d_lat * d_lat + d_lon * d_lon;
        if dist < best {
            best = dist;
            chance = Some(*value);
        }
    }
    chance
}

fn select_aurora_points(coordinates: &[(f64, f64, f64)], hemisphere: &str) -> Vec<AuroraPoint> {
    for threshold in [5.0, 10.0, 20.0] {
        let points = collect_aurora(coordinates, hemisphere, threshold);
        if points.len() <= 6000 {
            return points;
        }
    }
    collect_aurora(coordinates, hemisphere, 20.0)
        .into_iter()
        .take(6000)
        .collect()
}

fn collect_aurora(
    coordinates: &[(f64, f64, f64)],
    hemisphere: &str,
    threshold: f64,
) -> Vec<AuroraPoint> {
    let mut points = Vec::new();
    for (lon, lat, chance) in coordinates {
        if *chance < threshold {
            continue;
        }
        if hemisphere == "north" && *lat < 0.0 {
            continue;
        }
        if hemisphere == "south" && *lat > 0.0 {
            continue;
        }
        if lat.abs() == 90.0 && *lon != 0.0 {
            continue;
        }
        if lat.round() as i32 % 2 != 0 || lon.round() as i32 % 2 != 0 {
            continue;
        }
        points.push(AuroraPoint {
            lon: *lon,
            lat: *lat,
            chance: *chance,
        });
    }
    points
}

fn scale_alerts(scales: &SpaceScales) -> Vec<SpaceAlert> {
    let rows = [
        ("G", "Geomagnetic storm", &scales.geomagnetic),
        ("S", "Solar radiation storm", &scales.solar),
        ("R", "Radio blackout", &scales.radio),
    ];
    rows.iter()
        .filter(|(_, _, scale)| scale.level >= 1)
        .map(|(letter, name, scale)| SpaceAlert {
            id: format!("scale-{letter}"),
            code: format!("{letter}{}", scale.level),
            title: format!("{name} {letter}{} — {}", scale.level, scale.text),
            summary: Some("Current NOAA scale".into()),
            body: None,
            issued_at: scales.observed_at.clone(),
            valid_until: None,
            severity: if scale.level >= 3 { "alert" } else { "warn" }.into(),
            notable: true,
            detail_url: Some(SCALES_PAGE.into()),
        })
        .collect()
}

fn parse_alerts(body: &Value) -> Vec<SpaceAlert> {
    let mut parsed = Vec::new();
    for raw in raw_messages(body) {
        let code = message_field(&raw.message, "Space Weather Message Code")
            .filter(|value| !value.is_empty())
            .or_else(|| {
                if raw.product_id.is_empty() {
                    None
                } else {
                    Some(raw.product_id.clone())
                }
            })
            .unwrap_or_else(|| "SWPC".into());
        let serial = message_field(&raw.message, "Serial Number");
        let title = message_title(&raw.message);
        let kind = message_kind(&title, &code);
        let scale = noaa_scale(&raw.message);
        let k = k_from_code(&code);
        let (severity, notable) = assess_message(&code, kind, scale, k);
        let issued = parse_swpc_time(&raw.issued);
        let until_raw = message_field(&raw.message, "Now Valid Until")
            .or_else(|| message_field(&raw.message, "Valid To"));
        let until = until_raw.as_deref().and_then(parse_human_time);
        let summary = impacts(&raw.message)
            .or_else(|| scale.map(|level| format!("NOAA scale {level}")))
            .or_else(|| k.map(|level| format!("K-index {level}")));
        let body_text = raw.message.replace("\r\n", "\n");
        let body_text = body_text.trim();
        let body_text = if body_text.len() > 2500 {
            body_text.chars().take(2500).collect()
        } else {
            body_text.to_string()
        };
        let id_tail = serial
            .clone()
            .filter(|value| !value.is_empty())
            .or_else(|| {
                if raw.issued.is_empty() {
                    None
                } else {
                    Some(raw.issued.clone())
                }
            })
            .or_else(|| {
                if raw.product_id.is_empty() {
                    None
                } else {
                    Some(raw.product_id.clone())
                }
            })
            .unwrap_or_else(|| title.clone());
        parsed.push((
            issued.map(|dt| dt.timestamp_millis()).unwrap_or(0),
            SpaceAlert {
                id: format!("{code}-{id_tail}"),
                code,
                title,
                summary,
                body: if body_text.is_empty() {
                    None
                } else {
                    Some(body_text)
                },
                issued_at: issued.map(iso),
                valid_until: until.map(iso),
                severity,
                notable,
                detail_url: Some(ALERTS_PAGE.into()),
            },
        ));
    }
    parsed.sort_by(|a, b| b.0.cmp(&a.0));
    let mut seen = std::collections::BTreeSet::new();
    let mut unique = Vec::new();
    for (_, alert) in parsed {
        if !seen.insert(alert.code.clone()) {
            continue;
        }
        unique.push(alert);
    }
    unique
}

struct RawMessage {
    product_id: String,
    issued: String,
    message: String,
}

fn raw_messages(body: &Value) -> Vec<RawMessage> {
    let Some(rows) = body.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut legacy_header = false;
    for item in rows {
        if item.is_object() {
            let Some(message) = text_field(item, &["message"]) else {
                continue;
            };
            out.push(RawMessage {
                product_id: text_field(item, &["product_id", "productId"]).unwrap_or_default(),
                issued: text_field(item, &["issue_datetime", "issueDatetime"]).unwrap_or_default(),
                message,
            });
            continue;
        }
        let Some(row) = item.as_array() else { continue };
        if row.len() < 3 {
            continue;
        }
        let cells_are_strings = row.iter().all(|cell| cell.is_string());
        let message = row[2].as_str().unwrap_or("");
        if !legacy_header
            && cells_are_strings
            && !message.contains("Space Weather")
            && !message.contains("Message Code")
        {
            legacy_header = true;
            continue;
        }
        if !message.contains("Space Weather") && !message.contains("Message Code") {
            continue;
        }
        out.push(RawMessage {
            product_id: row[0].as_str().unwrap_or("").to_string(),
            issued: row[1].as_str().unwrap_or("").to_string(),
            message: message.to_string(),
        });
    }
    out
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Alert,
    Warning,
    Watch,
    Summary,
    Other,
}

fn message_kind(title: &str, code: &str) -> Kind {
    let text = title.to_ascii_lowercase();
    let code = code.to_ascii_uppercase();
    if text.contains("watch") || code.starts_with("WAT") {
        Kind::Watch
    } else if text.contains("warning") || code.starts_with("WAR") {
        Kind::Warning
    } else if text.contains("summary") || code.starts_with("SUM") {
        Kind::Summary
    } else if text.contains("alert") || code.starts_with("ALT") {
        Kind::Alert
    } else {
        Kind::Other
    }
}

fn assess_message(code: &str, kind: Kind, scale: Option<u8>, k: Option<u8>) -> (String, bool) {
    let code_up = code.to_ascii_uppercase();
    if code_up.starts_with("ALTEF") || code_up.starts_with("SUM") || code_up.starts_with("ALTTP") {
        return ("info".into(), false);
    }
    if kind == Kind::Summary {
        return ("info".into(), false);
    }
    let level = scale.unwrap_or(0);
    let k = k.unwrap_or(0);
    if kind == Kind::Alert && level < 1 && k < 5 {
        return ("info".into(), false);
    }
    if level >= 3 || k >= 7 {
        return ("alert".into(), true);
    }
    if level >= 1 || k >= 5 || kind == Kind::Watch || kind == Kind::Warning {
        return ("warn".into(), true);
    }
    ("info".into(), false)
}

fn k_from_code(code: &str) -> Option<u8> {
    let upper = code.to_ascii_uppercase();
    let rest = upper
        .strip_prefix("ALTK")
        .or_else(|| upper.strip_prefix("WARK"))?;
    if rest.len() != 2 {
        return None;
    }
    rest.parse::<u8>().ok().filter(|n| *n <= 9)
}

fn noaa_scale(message: &str) -> Option<u8> {
    let lower = message.to_ascii_lowercase();
    for marker in ["noaa scale:", "category "] {
        let Some(idx) = lower.find(marker) else {
            continue;
        };
        let rest = message[idx + marker.len()..].trim_start();
        let mut chars = rest.chars();
        let Some(first) = chars.next() else { continue };
        let digits = if matches!(first, 'G' | 'S' | 'R' | 'g' | 's' | 'r') {
            chars.as_str().trim_start()
        } else if first.is_ascii_digit() {
            rest
        } else {
            continue;
        };
        let digit = digits.chars().next()?;
        if digit.is_ascii_digit() {
            let level = digit as u8 - b'0';
            if level <= 5 {
                return Some(level);
            }
        }
    }
    None
}

fn message_title(message: &str) -> String {
    for line in message.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("space weather message code:")
            || lower.starts_with("serial number:")
            || lower.starts_with("issue time:")
        {
            continue;
        }
        return trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
    }
    "Space weather message".into()
}

fn message_field(message: &str, label: &str) -> Option<String> {
    let prefix = format!("{}:", label.to_ascii_lowercase());
    for line in message.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        let Some(rest) = lower.strip_prefix(&prefix) else {
            continue;
        };
        let value = rest.trim();
        if value.is_empty() {
            continue;
        }
        // Slice the original line so the value keeps its case.
        let start = trimmed.len() - rest.len();
        return Some(trimmed[start..].trim().to_string());
    }
    None
}

fn impacts(message: &str) -> Option<String> {
    let lower = message.to_ascii_lowercase();
    let idx = lower.find("potential impacts:")?;
    let text = message[idx..].replace('\r', "");
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn parse_swpc_time(value: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut iso = if trimmed.contains('T') {
        trimmed.to_string()
    } else {
        trimmed.replacen(' ', "T", 1)
    };
    if !has_zone(&iso) {
        iso.push('Z');
    }
    chrono::DateTime::parse_from_rfc3339(&iso)
        .ok()
        .map(|dt| dt.with_timezone(&chrono::Utc))
}

fn has_zone(iso: &str) -> bool {
    if iso.ends_with('Z') || iso.ends_with('z') {
        return true;
    }
    let bytes = iso.as_bytes();
    if bytes.len() < 6 {
        return false;
    }
    let sign_at = bytes.len() - 6;
    (bytes[sign_at] == b'+' || bytes[sign_at] == b'-')
        && bytes[sign_at + 1..]
            .iter()
            .all(|b| b.is_ascii_digit() || *b == b':')
}

fn parse_human_time(value: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    let parts: Vec<&str> = value.split_whitespace().collect();
    if parts.len() < 4 {
        return None;
    }
    let year: i32 = parts[0].parse().ok()?;
    let month = month_num(parts[1])?;
    let day: u32 = parts[2].parse().ok()?;
    if parts[3].len() != 4 {
        return None;
    }
    let hour: u32 = parts[3][..2].parse().ok()?;
    let minute: u32 = parts[3][2..].parse().ok()?;
    Some(
        chrono::NaiveDate::from_ymd_opt(year, month, day)?
            .and_hms_opt(hour, minute, 0)?
            .and_utc(),
    )
}

fn month_num(name: &str) -> Option<u32> {
    Some(match name.get(..3)?.to_ascii_lowercase().as_str() {
        "jan" => 1,
        "feb" => 2,
        "mar" => 3,
        "apr" => 4,
        "may" => 5,
        "jun" => 6,
        "jul" => 7,
        "aug" => 8,
        "sep" => 9,
        "oct" => 10,
        "nov" => 11,
        "dec" => 12,
        _ => return None,
    })
}

fn iso(dt: chrono::DateTime<chrono::Utc>) -> String {
    dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        .replace(".000Z", "Z")
}

fn latest_row(body: &Value, accept: impl Fn(&Value) -> bool) -> Option<Value> {
    let rows = body.as_array()?;
    let mut best: Option<(i64, Value)> = None;
    let mut saw_object = false;
    for item in rows {
        if !item.is_object() {
            continue;
        }
        saw_object = true;
        if !accept(item) {
            continue;
        }
        let ms = text_field(item, &["time_tag", "timeTag", "time"])
            .as_deref()
            .and_then(parse_swpc_time)
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(0);
        if best.as_ref().map(|(at, _)| ms >= *at).unwrap_or(true) {
            best = Some((ms, item.clone()));
        }
    }
    if saw_object {
        return best.map(|(_, row)| row);
    }
    let mut header: Option<Vec<String>> = None;
    for item in rows {
        let Some(cells) = item.as_array() else {
            continue;
        };
        if header.is_none() && cells.iter().all(|cell| cell.is_string()) {
            header = Some(
                cells
                    .iter()
                    .map(|cell| cell.as_str().unwrap_or("").to_string())
                    .collect(),
            );
            continue;
        }
        let Some(keys) = header.as_ref() else {
            continue;
        };
        let mut row = serde_json::Map::new();
        for (index, key) in keys.iter().enumerate() {
            if let Some(value) = cells.get(index) {
                row.insert(key.clone(), value.clone());
            }
        }
        let row = Value::Object(row);
        if !accept(&row) {
            continue;
        }
        let ms = text_field(&row, &["time_tag", "timeTag", "time"])
            .as_deref()
            .and_then(parse_swpc_time)
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(0);
        if best.as_ref().map(|(at, _)| ms >= *at).unwrap_or(true) {
            best = Some((ms, row));
        }
    }
    best.map(|(_, row)| row)
}

fn text_field(row: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        match row.get(*key) {
            Some(Value::String(value)) if !value.trim().is_empty() => {
                return Some(value.trim().to_string());
            }
            Some(Value::Number(value)) => return Some(value.to_string()),
            _ => {}
        }
    }
    None
}

fn num_field(row: &Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        match row.get(*key) {
            Some(Value::Number(value)) => return value.as_f64(),
            Some(Value::String(value)) => return value.trim().parse().ok(),
            _ => {}
        }
    }
    None
}

fn param_str(source: &SourceConfig, key: &str) -> Option<String> {
    source.params.get(key).and_then(|value| match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    })
}

fn param_bool(source: &SourceConfig, key: &str) -> Option<bool> {
    source.params.get(key).and_then(|value| match value {
        Value::Bool(flag) => Some(*flag),
        Value::String(text) => match text.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => Some(true),
            "false" | "0" | "no" | "off" => Some(false),
            _ => None,
        },
        Value::Number(n) => n.as_i64().map(|n| n != 0),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn xray_classes_match_the_goes_scale() {
        assert_eq!(xray_class(5.601458497039857e-7).as_deref(), Some("B5.6"));
        assert_eq!(xray_class(5.6e-6).as_deref(), Some("C5.6"));
        assert_eq!(xray_class(2.5e-5).as_deref(), Some("M2.5"));
        assert_eq!(xray_class(1e-4).as_deref(), Some("X1.0"));
        assert_eq!(xray_class(1.5e-3).as_deref(), Some("X15"));
        assert_eq!(xray_class(0.0), None);
    }

    #[test]
    fn scales_kp_flux_and_xray_use_the_latest_row() {
        let scales = parse_scales(&json!({
            "0": {
                "DateStamp": "2026-11-14",
                "TimeStamp": "08:46:00",
                "R": { "Scale": "1", "Text": "minor" },
                "S": { "Scale": "0", "Text": "none" },
                "G": { "Scale": "2", "Text": "moderate" }
            }
        }))
        .unwrap();
        assert_eq!(scales.radio.level, 1);
        assert_eq!(scales.geomagnetic.level, 2);
        assert_eq!(scales.observed_at.as_deref(), Some("2026-11-14T08:46:00Z"));

        let kp = parse_planetary_kp(&json!([
            { "time_tag": "2026-11-13T21:00:00", "Kp": 1.33 },
            { "time_tag": "2026-11-14T03:00:00", "Kp": 0.67 }
        ]))
        .unwrap();
        assert!((kp.value - 0.67).abs() < 1e-9);

        let legacy = parse_planetary_kp(&json!([
            ["time_tag", "Kp"],
            ["2026-11-13T00:00:00", "2.00"],
            ["2026-11-14T03:00:00", "1.33"]
        ]))
        .unwrap();
        assert!((legacy.value - 1.33).abs() < 1e-9);

        let flux = parse_solar_flux(&json!([
            { "time_tag": "2026-10-04T17:00:00", "flux": 93 },
            { "time_tag": "2026-11-13T22:00:00", "flux": 118 }
        ]))
        .unwrap();
        assert!((flux.value - 118.0).abs() < 1e-9);

        let xray = parse_xray(&json!([
            { "time_tag": "2026-11-14T08:45:00Z", "flux": 1e-6, "energy": "0.05-0.4nm" },
            { "time_tag": "2026-11-14T08:40:00Z", "flux": 1e-6, "energy": "0.1-0.8nm" },
            { "time_tag": "2026-11-14T08:45:00Z", "flux": 5.601e-7, "energy": "0.1-0.8nm" }
        ]))
        .unwrap();
        assert_eq!(xray.class_name, "B5.6");
    }

    #[test]
    fn alerts_keep_the_newest_of_each_code_and_mark_storms() {
        let alerts = parse_alerts(&json!([
            {
                "product_id": "EF3A",
                "issue_datetime": "2026-11-14 05:03:51.727",
                "message": "Space Weather Message Code: ALTEF3\nSerial Number: 3775\nIssue Time: 2026 Nov 14 0503 UTC\n\nCONTINUED ALERT: Electron 2MeV Integral Flux exceeded 1,000pfu"
            },
            {
                "product_id": "EF3A",
                "issue_datetime": "2026-11-13 05:05:40.730",
                "message": "Space Weather Message Code: ALTEF3\nSerial Number: 3774\nIssue Time: 2026 Nov 13 0505 UTC\n\nCONTINUED ALERT: Electron 2MeV Integral Flux exceeded 1,000pfu"
            },
            {
                "product_id": "K04A",
                "issue_datetime": "2026-11-07 19:20:00",
                "message": "Space Weather Message Code: ALTK04\nSerial Number: 2697\nIssue Time: 2026 Nov 07 1920 UTC\n\nALERT: Geomagnetic K-index of 4"
            },
            {
                "product_id": "K05A",
                "issue_datetime": "2026-11-08 02:03:00",
                "message": "Space Weather Message Code: ALTK05\nSerial Number: 2062\nIssue Time: 2026 Nov 08 0203 UTC\n\nALERT: Geomagnetic K-index of 5\nNOAA Scale: G1 - Minor\n\nPotential Impacts: Aurora may be visible at high latitudes."
            },
            {
                "product_id": "K07A",
                "issue_datetime": "2026-11-14 00:00:00",
                "message": "Space Weather Message Code: ALTK07\nSerial Number: 9\nIssue Time: 2026 Nov 14 0000 UTC\n\nALERT: Geomagnetic K-index of 7\nNOAA Scale: G3 - Strong"
            }
        ]));
        let electron = alerts.iter().find(|alert| alert.code == "ALTEF3").unwrap();
        assert_eq!(electron.id, "ALTEF3-3775");
        assert!(!electron.notable);
        assert!(!alerts
            .iter()
            .any(|alert| alert.code == "ALTK04" && alert.notable));
        let g1 = alerts.iter().find(|alert| alert.code == "ALTK05").unwrap();
        assert_eq!(g1.severity, "warn");
        assert!(g1.summary.as_deref().unwrap().contains("Potential Impacts"));
        assert_eq!(
            alerts
                .iter()
                .find(|alert| alert.code == "ALTK07")
                .unwrap()
                .severity,
            "alert"
        );
    }

    #[test]
    fn ovation_chance_is_the_nearest_grid_point() {
        let grid = parse_ovation(&json!({
            "Observation Time": "2026-11-14T08:43:00Z",
            "Forecast Time": "2026-11-14T09:48:00Z",
            "coordinates": [
                [0, 0, 2],
                [280, 40, 8],
                [279, 40, 4],
                [200, -70, 30],
                [0, 90, 9],
                [10, 90, 9]
            ]
        }))
        .unwrap();
        assert!((nearest_aurora(&grid.coordinates, 40.2, -79.5).unwrap() - 8.0).abs() < 1e-9);
        let points = select_aurora_points(&grid.coordinates, "north");
        assert!(points
            .iter()
            .any(|point| point.lat == 40.0 && point.chance == 8.0));
        assert!(points.iter().all(|point| point.lat >= 0.0));
        assert!(!points
            .iter()
            .any(|point| point.lon == 10.0 && point.lat == 90.0));
        assert_eq!(map_hemisphere(Some("auto"), 40.0), "north");
        assert_eq!(map_hemisphere(Some("south"), 40.0), "south");
    }
}
