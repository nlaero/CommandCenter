use crate::config::SourceConfig;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::f64::consts::PI;

const OPEN_METEO: &str = "https://api.open-meteo.com/v1/forecast";
const RAINVIEWER_MAPS: &str = "https://api.rainviewer.com/public/weather-maps.json";
const RAINVIEWER_HOST_DEFAULT: &str = "https://tilecache.rainviewer.com";
const BASE_TILE: &str = "https://basemaps.cartocdn.com/dark_all";
/// NOAA GOES-East CONUS GeoColor — public NESDIS imagery (RainViewer IR satellite ended 2026-01-01).
const GOES_CONUS: &str =
    "https://cdn.star.nesdis.noaa.gov/GOES16/ABI/CONUS/GEOCOLOR/latest.jpg";
const GOES_FULL_DISK: &str =
    "https://cdn.star.nesdis.noaa.gov/GOES16/ABI/FD/GEOCOLOR/latest.jpg";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherConditions {
    pub temp_c: f64,
    pub temp_f: f64,
    pub feels_like_c: f64,
    pub feels_like_f: f64,
    pub humidity: f64,
    pub wind_kmh: f64,
    pub wind_mph: f64,
    pub wind_dir: Option<f64>,
    pub pressure_hpa: Option<f64>,
    pub weather_code: i32,
    pub description: String,
    pub lat: f64,
    pub lon: f64,
    pub observed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HourlyPoint {
    pub time: String,
    pub temp_c: f64,
    pub temp_f: f64,
    pub weather_code: i32,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapTile {
    pub x: i32,
    pub y: i32,
    pub z: u32,
    pub base_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub radar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeView {
    pub id: String,
    pub label: String,
    pub zoom: u32,
    pub center_lat: f64,
    pub center_lon: f64,
    pub tiles: Vec<MapTile>,
    pub grid_size: u32,
    /// NOAA GOES still for this scope (full-disk vs CONUS).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub satellite_image_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherLayers {
    pub show_radar: bool,
    pub show_satellite: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub radar_time: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub satellite_image_url: Option<String>,
}

/// NWS active alert at the weather source lat/lon (watches, warnings, advisories).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherAlert {
    pub id: String,
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub severity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub urgency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub area: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub onset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ends: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherPayload {
    pub units: String,
    pub conditions: WeatherConditions,
    pub hourly: Vec<HourlyPoint>,
    pub scopes: Vec<ScopeView>,
    pub layers: WeatherLayers,
    #[serde(default)]
    pub alerts: Vec<WeatherAlert>,
}

#[derive(Debug, Clone)]
pub struct FetchResult {
    pub weather: WeatherPayload,
    pub attribution: String,
    pub fetched_at: String,
    pub note: Option<String>,
}

pub fn fetch(
    source: &SourceConfig,
    secrets: &std::collections::BTreeMap<String, String>,
) -> Result<FetchResult, super::SourceError> {
    let lat = param_f64(source, "lat").ok_or_else(|| {
        super::SourceError::Message("latitude is required".into())
    })?;
    let lon = param_f64(source, "lon").ok_or_else(|| {
        super::SourceError::Message("longitude is required".into())
    })?;
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return Err(super::SourceError::Message(
            "lat/lon out of range".into(),
        ));
    }

    let units = param_str(source, "units")
        .unwrap_or_else(|| "imperial".into())
        .to_ascii_lowercase();
    let scopes = parse_scopes(param_str(source, "scopes").as_deref().unwrap_or("local"));
    if scopes.is_empty() {
        return Err(super::SourceError::Message(
            "at least one scope is required (local, regional, nationwide)".into(),
        ));
    }
    let show_radar = param_bool(source, "showRadar").unwrap_or(true);
    let show_satellite = param_bool(source, "showSatellite").unwrap_or(true);

    let client = reqwest::blocking::Client::builder()
        .user_agent(
            "CommandCenter/0.1 (personal weather; +https://github.com/nlaero/CommandCenter)",
        )
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    let mut conditions_url = format!(
        "{OPEN_METEO}?latitude={lat}&longitude={lon}\
         &current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,\
         wind_speed_10m,wind_direction_10m,surface_pressure\
         &hourly=temperature_2m,weather_code&forecast_hours=12\
         &timezone=auto&wind_speed_unit=kmh"
    );
    if let Some(key) = secrets
        .get("weather.optional_key")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        conditions_url.push_str("&apikey=");
        conditions_url.push_str(key);
    }
    let om_body: Value = client.get(&conditions_url).send()?.error_for_status()?.json()?;
    let conditions = parse_conditions(&om_body, lat, lon)?;
    let hourly = parse_hourly(&om_body)?;

    let mut radar_path: Option<String> = None;
    let mut radar_time: Option<i64> = None;
    let mut radar_host = RAINVIEWER_HOST_DEFAULT.to_string();

    if show_radar {
        match client.get(RAINVIEWER_MAPS).send().and_then(|r| r.error_for_status()) {
            Ok(resp) => {
                if let Ok(maps) = resp.json::<Value>() {
                    if let Some(host) = maps.get("host").and_then(|v| v.as_str()) {
                        radar_host = host.trim_end_matches('/').to_string();
                    }
                    if let Some((t, path)) = latest_frame(&maps, &["radar", "past"]) {
                        radar_time = Some(t);
                        radar_path = Some(path);
                    }
                }
            }
            Err(err) => {
                eprintln!("rainviewer maps fetch failed: {err}");
            }
        }
    }

    let satellite_image_url = if show_satellite {
        Some(GOES_CONUS.to_string())
    } else {
        None
    };

    let scope_views: Vec<ScopeView> = scopes
        .iter()
        .map(|id| {
            build_scope(
                id,
                lat,
                lon,
                radar_host.as_str(),
                radar_path.as_deref(),
                show_satellite,
            )
        })
        .collect();

    let alerts = fetch_nws_alerts(&client, lat, lon);

    Ok(FetchResult {
        weather: WeatherPayload {
            units,
            conditions,
            hourly,
            scopes: scope_views,
            layers: WeatherLayers {
                show_radar,
                show_satellite,
                radar_time,
                satellite_image_url,
            },
            alerts,
        },
        attribution:
            "Open-Meteo · RainViewer radar · NOAA GOES / NESDIS satellite · NWS alerts · CARTO basemap"
                .into(),
        fetched_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        note: Some(
            "Free personal use: Open-Meteo (attribution required; commercial needs a plan). \
             RainViewer public radar tiles (personal/educational; max zoom 7). \
             Satellite via NOAA GOES public imagery (RainViewer IR ended 2026). \
             Local severe weather watches/warnings via api.weather.gov (NWS). \
             Optional weather.optional_key for paid Open-Meteo — OS keyring only, never in config.yaml."
                .into(),
        ),
    })
}

fn fetch_nws_alerts(client: &reqwest::blocking::Client, lat: f64, lon: f64) -> Vec<WeatherAlert> {
    let url = format!("https://api.weather.gov/alerts/active?point={lat},{lon}");
    match client.get(&url).send().and_then(|r| r.error_for_status()) {
        Ok(resp) => match resp.json::<Value>() {
            Ok(body) => parse_nws_alerts(&body),
            Err(err) => {
                eprintln!("nws alerts json failed: {err}");
                vec![]
            }
        },
        Err(err) => {
            eprintln!("nws alerts fetch failed: {err}");
            vec![]
        }
    }
}

pub fn parse_nws_alerts(body: &Value) -> Vec<WeatherAlert> {
    let Some(features) = body.get("features").and_then(|v| v.as_array()) else {
        return vec![];
    };
    let mut out = Vec::new();
    for feature in features {
        let props = feature.get("properties").unwrap_or(feature);
        let id = props
            .get("id")
            .and_then(|v| v.as_str())
            .or_else(|| feature.get("id").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        let event = props
            .get("event")
            .and_then(|v| v.as_str())
            .unwrap_or("Weather alert")
            .to_string();
        let severity = props
            .get("severity")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown")
            .to_string();
        let detail_url = props
            .get("@id")
            .and_then(|v| v.as_str())
            .or_else(|| props.get("id").and_then(|v| v.as_str()))
            .map(|s| s.to_string());
        out.push(WeatherAlert {
            id,
            event,
            headline: str_field(props, &["headline"]),
            description: str_field(props, &["description"]),
            severity,
            urgency: str_field(props, &["urgency"]),
            area: str_field(props, &["areaDesc"]),
            onset: str_field(props, &["onset"]),
            ends: str_field(props, &["ends"]).or_else(|| str_field(props, &["expires"])),
            expires: str_field(props, &["expires"]),
            sender: str_field(props, &["senderName"]),
            detail_url,
        });
    }
    out
}

fn parse_scopes(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    for part in raw.split([',', '+', '|', ' ']) {
        let p = part.trim().to_ascii_lowercase();
        if matches!(p.as_str(), "local" | "regional" | "nationwide") && !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

fn build_scope(
    id: &str,
    lat: f64,
    lon: f64,
    radar_host: &str,
    radar_path: Option<&str>,
    show_satellite: bool,
) -> ScopeView {
    // RainViewer free personal API: max zoom 7 (as of 2026-01-01 transition).
    let (label, zoom, grid, sat_url) = match id {
        "regional" => ("Regional", 5_u32, 3_u32, GOES_CONUS),
        "nationwide" => ("Nationwide", 3, 3, GOES_FULL_DISK),
        _ => ("Local", 7, 3, GOES_CONUS),
    };
    let (cx, cy) = lat_lon_to_tile(lat, lon, zoom);
    let half = (grid as i32) / 2;
    let mut tiles = Vec::with_capacity((grid * grid) as usize);
    for dy in -half..=half {
        for dx in -half..=half {
            let x = cx + dx;
            let y = cy + dy;
            let n = 1_i32 << zoom;
            if y < 0 || y >= n {
                continue;
            }
            let wrapped_x = ((x % n) + n) % n;
            tiles.push(MapTile {
                x: wrapped_x,
                y,
                z: zoom,
                base_url: format!("{BASE_TILE}/{zoom}/{wrapped_x}/{y}.png"),
                radar_url: radar_path.map(|path| {
                    format!("{radar_host}{path}/256/{zoom}/{wrapped_x}/{y}/2/1_1.png")
                }),
            });
        }
    }
    ScopeView {
        id: id.to_string(),
        label: label.to_string(),
        zoom,
        center_lat: lat,
        center_lon: lon,
        tiles,
        grid_size: grid,
        satellite_image_url: if show_satellite {
            Some(sat_url.to_string())
        } else {
            None
        },
    }
}

fn lat_lon_to_tile(lat: f64, lon: f64, zoom: u32) -> (i32, i32) {
    let n = (1_u32 << zoom) as f64;
    let x = ((lon + 180.0) / 360.0 * n).floor() as i32;
    let lat_rad = lat.to_radians().clamp(-85.0511_f64.to_radians(), 85.0511_f64.to_radians());
    let y = ((1.0 - (lat_rad.tan() + 1.0 / lat_rad.cos()).ln() / PI) / 2.0 * n).floor() as i32;
    (x, y)
}

fn latest_frame(maps: &Value, path: &[&str]) -> Option<(i64, String)> {
    let mut cur = maps;
    for key in path {
        cur = cur.get(*key)?;
    }
    let arr = cur.as_array()?;
    let last = arr.last()?;
    let time = last.get("time")?.as_i64()?;
    let path = last.get("path")?.as_str()?.to_string();
    Some((time, path))
}

fn parse_conditions(body: &Value, lat: f64, lon: f64) -> Result<WeatherConditions, super::SourceError> {
    let current = body
        .get("current")
        .ok_or_else(|| super::SourceError::Message("Open-Meteo response missing current".into()))?;
    let temp_c = num_field(current, &["temperature_2m"]).unwrap_or(0.0);
    let feels_c = num_field(current, &["apparent_temperature"]).unwrap_or(temp_c);
    let code = num_field(current, &["weather_code"]).unwrap_or(0.0) as i32;
    Ok(WeatherConditions {
        temp_c,
        temp_f: c_to_f(temp_c),
        feels_like_c: feels_c,
        feels_like_f: c_to_f(feels_c),
        humidity: num_field(current, &["relative_humidity_2m"]).unwrap_or(0.0),
        wind_kmh: num_field(current, &["wind_speed_10m"]).unwrap_or(0.0),
        wind_mph: kmh_to_mph(num_field(current, &["wind_speed_10m"]).unwrap_or(0.0)),
        wind_dir: num_field(current, &["wind_direction_10m"]),
        pressure_hpa: num_field(current, &["surface_pressure"]),
        weather_code: code,
        description: wmo_description(code).to_string(),
        lat,
        lon,
        observed_at: str_field(current, &["time"]),
    })
}

fn parse_hourly(body: &Value) -> Result<Vec<HourlyPoint>, super::SourceError> {
    let hourly = match body.get("hourly") {
        Some(h) => h,
        None => return Ok(vec![]),
    };
    let times = hourly
        .get("time")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let temps = hourly
        .get("temperature_2m")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let codes = hourly
        .get("weather_code")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for i in 0..times.len().min(12) {
        let time = times[i].as_str().unwrap_or("").to_string();
        let temp_c = temps
            .get(i)
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let code = codes
            .get(i)
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0) as i32;
        out.push(HourlyPoint {
            time,
            temp_c,
            temp_f: c_to_f(temp_c),
            weather_code: code,
            description: wmo_description(code).to_string(),
        });
    }
    Ok(out)
}

pub fn wmo_description(code: i32) -> &'static str {
    match code {
        0 => "Clear",
        1 => "Mainly clear",
        2 => "Partly cloudy",
        3 => "Overcast",
        45 | 48 => "Fog",
        51 | 53 | 55 => "Drizzle",
        56 | 57 => "Freezing drizzle",
        61 | 63 | 65 => "Rain",
        66 | 67 => "Freezing rain",
        71 | 73 | 75 => "Snow",
        77 => "Snow grains",
        80 | 81 | 82 => "Rain showers",
        85 | 86 => "Snow showers",
        95 => "Thunderstorm",
        96 | 99 => "Thunderstorm with hail",
        _ => "Unknown",
    }
}

fn c_to_f(c: f64) -> f64 {
    c * 9.0 / 5.0 + 32.0
}

fn kmh_to_mph(kmh: f64) -> f64 {
    kmh * 0.621371
}

fn param_str(source: &SourceConfig, key: &str) -> Option<String> {
    source.params.get(key).and_then(|v| match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    })
}

fn param_f64(source: &SourceConfig, key: &str) -> Option<f64> {
    source.params.get(key).and_then(|v| match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    })
}

fn param_bool(source: &SourceConfig, key: &str) -> Option<bool> {
    source.params.get(key).and_then(|v| match v {
        Value::Bool(b) => Some(*b),
        Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" => Some(true),
            "false" | "0" | "no" => Some(false),
            _ => None,
        },
        _ => None,
    })
}

fn str_field(row: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(Value::String(s)) = row.get(*key) {
            if !s.trim().is_empty() {
                return Some(s.clone());
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_scope_combinations() {
        assert_eq!(
            parse_scopes("local,regional,nationwide"),
            vec!["local", "regional", "nationwide"]
        );
        assert_eq!(parse_scopes("local+regional"), vec!["local", "regional"]);
        assert!(parse_scopes("").is_empty());
    }

    #[test]
    fn parses_open_meteo_current() {
        let body = json!({
            "current": {
                "time": "2026-11-13T12:00",
                "temperature_2m": 22.5,
                "relative_humidity_2m": 55,
                "apparent_temperature": 21.0,
                "weather_code": 2,
                "wind_speed_10m": 12.0,
                "wind_direction_10m": 180,
                "surface_pressure": 1012.0
            },
            "hourly": {
                "time": ["2026-11-13T12:00", "2026-11-13T13:00"],
                "temperature_2m": [22.5, 23.0],
                "weather_code": [2, 3]
            }
        });
        let c = parse_conditions(&body, 30.27, -97.74).unwrap();
        assert_eq!(c.description, "Partly cloudy");
        assert!((c.temp_f - 72.5).abs() < 0.2);
        let h = parse_hourly(&body).unwrap();
        assert_eq!(h.len(), 2);
        assert_eq!(h[1].description, "Overcast");
    }

    #[test]
    fn builds_local_tile_grid() {
        let scope = build_scope(
            "local",
            30.27,
            -97.74,
            RAINVIEWER_HOST_DEFAULT,
            Some("/v2/radar/1"),
            true,
        );
        assert_eq!(scope.zoom, 7);
        assert_eq!(scope.tiles.len(), 9);
        assert!(scope.tiles[0].radar_url.is_some());
        assert!(scope.satellite_image_url.is_some());
        assert!(scope.tiles[0].base_url.contains("basemaps.cartocdn.com"));
    }

    #[test]
    fn wmo_codes_cover_storm() {
        assert_eq!(wmo_description(95), "Thunderstorm");
        assert_eq!(wmo_description(0), "Clear");
    }

    #[test]
    fn parses_nws_active_alerts() {
        let body = json!({
            "features": [{
                "id": "https://api.weather.gov/alerts/urn:oid:1",
                "properties": {
                    "id": "urn:oid:1",
                    "@id": "https://api.weather.gov/alerts/urn:oid:1",
                    "event": "Flood Warning",
                    "headline": "Flood Warning for McMullen",
                    "description": "The Flood Warning continues...",
                    "severity": "Severe",
                    "urgency": "Immediate",
                    "areaDesc": "McMullen, TX",
                    "onset": "2026-11-15T13:00:00-06:00",
                    "ends": "2026-11-18T14:00:00-06:00",
                    "expires": "2026-11-13T23:30:00-06:00",
                    "senderName": "NWS Corpus Christi TX"
                }
            }]
        });
        let alerts = parse_nws_alerts(&body);
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].event, "Flood Warning");
        assert_eq!(alerts[0].severity, "Severe");
        assert_eq!(alerts[0].area.as_deref(), Some("McMullen, TX"));
        assert!(alerts[0]
            .detail_url
            .as_deref()
            .unwrap_or("")
            .contains("api.weather.gov"));
    }

    #[test]
    fn parses_empty_nws_collection() {
        assert!(parse_nws_alerts(&json!({ "features": [] })).is_empty());
        assert!(parse_nws_alerts(&json!({})).is_empty());
    }
}
