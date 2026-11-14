//! Resolve a source's place from GPS, network location, another device
//! location service, or an address the user typed.
//!
//! A result is returned only when coordinates are in range. Callers treat that
//! as confirmation that a location was found.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::process::{Command, Output, Stdio};
use std::time::Duration;

const UA: &str =
    "CommandCenter/0.1 (personal location lookup; +https://github.com/nlaero/CommandCenter)";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationRequest {
    pub provider: String,
    #[serde(default)]
    pub address: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLocation {
    pub lat: f64,
    pub lon: f64,
    pub label: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accuracy_m: Option<f64>,
    pub confirmed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationLookup {
    pub matches: Vec<ResolvedLocation>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Provider {
    Gps,
    Network,
    Device,
    Address,
}

#[derive(Debug)]
struct Fix {
    lat: f64,
    lon: f64,
    accuracy_m: Option<f64>,
    label: Option<String>,
}

pub fn resolve(request: LocationRequest) -> Result<LocationLookup, String> {
    let provider = parse_provider(&request.provider)?;
    let matches = match provider {
        Provider::Address => {
            let query = normalize_address(request.address.as_deref().unwrap_or(""))?;
            geocode(&query)?
        }
        Provider::Gps => vec![describe_fix(gps_fix()?, "gps")],
        Provider::Network => vec![describe_fix(network_fix()?, "network")],
        Provider::Device => vec![describe_fix(device_fix()?, "device")],
    };
    if matches.is_empty() {
        return Err("Command Center could not confirm a location.".into());
    }
    Ok(LocationLookup { matches })
}

/// Direct lat/lon keys win. Otherwise a confirmed `location` object.
pub fn lookup_coords(
    params: &BTreeMap<String, Value>,
    lat_key: &str,
    lon_key: &str,
) -> Option<(f64, f64)> {
    if let (Some(lat), Some(lon)) = (
        number_at(params.get(lat_key)),
        number_at(params.get(lon_key)),
    ) {
        if in_range(lat, lon) {
            return Some((lat, lon));
        }
    }
    let obj = params.get("location")?.as_object()?;
    if obj.get("confirmed").and_then(|v| v.as_bool()) != Some(true) {
        return None;
    }
    let lat = number_at(obj.get("lat"))?;
    let lon = number_at(obj.get("lon"))?;
    in_range(lat, lon).then_some((lat, lon))
}

/// Empty strings and unconfirmed location objects count as missing.
pub fn value_missing(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.trim().is_empty(),
        Value::Number(number) => number.as_f64().map(|n| !n.is_finite()).unwrap_or(true),
        Value::Object(map) => {
            if !map.contains_key("confirmed") {
                return false;
            }
            if map.get("confirmed").and_then(|v| v.as_bool()) != Some(true) {
                return true;
            }
            match (
                number_at(map.get("lat")).filter(|lat| (-90.0..=90.0).contains(lat)),
                number_at(map.get("lon")).filter(|lon| (-180.0..=180.0).contains(lon)),
            ) {
                (Some(_), Some(_)) => false,
                _ => true,
            }
        }
        Value::Bool(_) | Value::Array(_) => false,
    }
}

fn parse_provider(raw: &str) -> Result<Provider, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "gps" => Ok(Provider::Gps),
        "network" => Ok(Provider::Network),
        "device" => Ok(Provider::Device),
        "address" => Ok(Provider::Address),
        _ => Err("Unknown location source.".into()),
    }
}

fn normalize_address(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Type an address first.".into());
    }
    if trimmed.chars().count() > 200 {
        return Err("That address is too long.".into());
    }
    Ok(trimmed.to_string())
}

fn geocode(query: &str) -> Result<Vec<ResolvedLocation>, String> {
    let client = http_client()?;
    let mut saw_empty = false;
    let mut last_err: Option<String> = None;

    match fetch_matches(&client, &photon_search_url(query), parse_photon_body) {
        Ok(matches) if !matches.is_empty() => return Ok(matches),
        Ok(_) => saw_empty = true,
        Err(err) => last_err = Some(err),
    }
    match fetch_matches(&client, &nominatim_search_url(query), parse_nominatim_body) {
        Ok(matches) if !matches.is_empty() => return Ok(matches),
        Ok(_) => saw_empty = true,
        Err(err) => last_err = Some(err),
    }
    match fetch_matches(&client, &meteo_search_url(query), parse_meteo_body) {
        Ok(matches) if !matches.is_empty() => return Ok(matches),
        Ok(_) => saw_empty = true,
        Err(err) => last_err = Some(err),
    }

    if saw_empty {
        Err("No place matched that address. Try a street, city, and region.".into())
    } else {
        Err(last_err.unwrap_or_else(|| {
            "No place matched that address. Try a street, city, and region.".into()
        }))
    }
}

fn fetch_matches(
    client: &reqwest::blocking::Client,
    url: &str,
    parse: fn(&str) -> Result<Vec<ResolvedLocation>, String>,
) -> Result<Vec<ResolvedLocation>, String> {
    let body = get_text(client, url)?;
    parse(&body)
}

fn gps_fix() -> Result<Fix, String> {
    if let Some(fix) = try_gpsd() {
        return Ok(fix);
    }
    match geoclue_fix(8) {
        Ok(fix) => {
            if let Some(accuracy) = fix.accuracy_m {
                if accuracy > 1000.0 {
                    return Err(format!(
                        "No GPS fix. The only reading was {}, which is too coarse for GPS.",
                        format_accuracy(accuracy)
                    ));
                }
            }
            Ok(fix)
        }
        Err(_) => Err("No GPS fix. This device did not report a satellite position.".into()),
    }
}

fn network_fix() -> Result<Fix, String> {
    if let Ok(fix) = geoclue_fix(4) {
        return Ok(fix);
    }
    let client = http_client()?;
    let body = get_text(&client, "https://ipwho.is/")?;
    let loc = parse_ipwho_body(&body)?;
    Ok(Fix {
        lat: loc.lat,
        lon: loc.lon,
        accuracy_m: None,
        label: Some(loc.label),
    })
}

fn device_fix() -> Result<Fix, String> {
    geoclue_fix(6).map_err(|_| "No other location service on this device responded.".to_string())
}

fn describe_fix(fix: Fix, source: &str) -> ResolvedLocation {
    let label = fix
        .label
        .clone()
        .filter(|text| !text.trim().is_empty())
        .or_else(|| {
            let client = http_client().ok()?;
            reverse_label(&client, fix.lat, fix.lon)
        });
    ResolvedLocation {
        lat: fix.lat,
        lon: fix.lon,
        label: label.unwrap_or_else(|| format_coords(fix.lat, fix.lon)),
        source: source.to_string(),
        accuracy_m: fix.accuracy_m.filter(|n| n.is_finite() && *n >= 0.0),
        confirmed: true,
    }
}

fn reverse_label(client: &reqwest::blocking::Client, lat: f64, lon: f64) -> Option<String> {
    let url = format!("https://photon.komoot.io/reverse?lat={lat}&lon={lon}");
    let body = get_text(client, &url).ok()?;
    parse_photon_body(&body)
        .ok()?
        .into_iter()
        .next()
        .map(|item| item.label)
}

fn try_gpsd() -> Option<Fix> {
    let output = run_cmd("gpspipe", &["-w", "-n", "8"], Duration::from_secs(8)).ok()?;
    if output.stdout.is_empty() {
        return None;
    }
    parse_gpsd_stream(&String::from_utf8_lossy(&output.stdout)).ok()
}

fn geoclue_fix(accuracy_level: u32) -> Result<Fix, String> {
    let client_path = busctl_object(&[
        "--system".into(),
        "call".into(),
        "org.freedesktop.GeoClue2".into(),
        "/org/freedesktop/GeoClue2/Manager".into(),
        "org.freedesktop.GeoClue2.Manager".into(),
        "CreateClient".into(),
    ])?;
    let _ = busctl_text(
        &[
            "--system".into(),
            "set-property".into(),
            "org.freedesktop.GeoClue2".into(),
            client_path.clone(),
            "org.freedesktop.GeoClue2.Client".into(),
            "DesktopId".into(),
            "s".into(),
            "command-center".into(),
        ],
        Duration::from_secs(4),
    );
    let _ = busctl_text(
        &[
            "--system".into(),
            "set-property".into(),
            "org.freedesktop.GeoClue2".into(),
            client_path.clone(),
            "org.freedesktop.GeoClue2.Client".into(),
            "RequestedAccuracyLevel".into(),
            "u".into(),
            accuracy_level.to_string(),
        ],
        Duration::from_secs(4),
    );
    busctl_text(
        &[
            "--system".into(),
            "call".into(),
            "org.freedesktop.GeoClue2".into(),
            client_path.clone(),
            "org.freedesktop.GeoClue2.Client".into(),
            "Start".into(),
        ],
        Duration::from_secs(8),
    )?;
    let loc_path = busctl_object(&[
        "--system".into(),
        "get-property".into(),
        "org.freedesktop.GeoClue2".into(),
        client_path.clone(),
        "org.freedesktop.GeoClue2.Client".into(),
        "Location".into(),
    ])?;
    if loc_path == "/" || loc_path.is_empty() {
        return Err("No other location service on this device responded.".into());
    }
    let lat = busctl_double(&[
        "--system".into(),
        "get-property".into(),
        "org.freedesktop.GeoClue2".into(),
        loc_path.clone(),
        "org.freedesktop.GeoClue2.Location".into(),
        "Latitude".into(),
    ])?;
    let lon = busctl_double(&[
        "--system".into(),
        "get-property".into(),
        "org.freedesktop.GeoClue2".into(),
        loc_path.clone(),
        "org.freedesktop.GeoClue2.Location".into(),
        "Longitude".into(),
    ])?;
    let accuracy = busctl_double(&[
        "--system".into(),
        "get-property".into(),
        "org.freedesktop.GeoClue2".into(),
        loc_path,
        "org.freedesktop.GeoClue2.Location".into(),
        "Accuracy".into(),
    ])
    .ok();
    let _ = busctl_text(
        &[
            "--system".into(),
            "call".into(),
            "org.freedesktop.GeoClue2".into(),
            client_path,
            "org.freedesktop.GeoClue2.Client".into(),
            "Stop".into(),
        ],
        Duration::from_secs(2),
    );
    if !in_range(lat, lon) {
        return Err("The lookup returned coordinates that are not a real location.".into());
    }
    Ok(Fix {
        lat,
        lon,
        accuracy_m: accuracy.filter(|n| n.is_finite() && *n >= 0.0),
        label: None,
    })
}

fn busctl_object(args: &[String]) -> Result<String, String> {
    let text = busctl_text(args, Duration::from_secs(6))?;
    parse_busctl_object(&text)
        .ok_or_else(|| "No other location service on this device responded.".into())
}

fn busctl_double(args: &[String]) -> Result<f64, String> {
    let text = busctl_text(args, Duration::from_secs(4))?;
    parse_busctl_double(&text)
        .ok_or_else(|| "No other location service on this device responded.".into())
}

fn busctl_text(args: &[String], timeout: Duration) -> Result<String, String> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = run_cmd("busctl", &refs, timeout)?;
    command_text("busctl", &output)
}

fn command_text(program: &str, output: &Output) -> Result<String, String> {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        return Ok(stdout);
    }
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    if detail.is_empty() {
        Err(format!("{program} failed"))
    } else if detail.to_ascii_lowercase().contains("serviceunknown")
        || detail.to_ascii_lowercase().contains("not provided")
        || detail.to_ascii_lowercase().contains("no such file")
    {
        Err("No other location service on this device responded.".into())
    } else {
        Err(detail)
    }
}

fn run_cmd(program: &str, args: &[&str], timeout: Duration) -> Result<Output, String> {
    let child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                format!("{program} is not installed")
            } else {
                format!("could not run {program}: {err}")
            }
        })?;
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(err)) => Err(format!("{program}: {err}")),
        Err(_) => {
            kill_pid(pid);
            Err(format!("{program} timed out"))
        }
    }
}

fn kill_pid(pid: u32) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .status();
    }
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|err| format!("HTTP client: {err}"))
}

fn get_text(client: &reqwest::blocking::Client, url: &str) -> Result<String, String> {
    let response = client
        .get(url)
        .send()
        .map_err(|err| format!("lookup failed: {}", err.without_url()))?;
    let status = response.status();
    let body = response
        .text()
        .map_err(|err| format!("lookup failed: {}", err.without_url()))?;
    if !status.is_success() {
        return Err(format!("lookup failed (HTTP {}).", status.as_u16()));
    }
    Ok(body)
}

fn photon_search_url(query: &str) -> String {
    let mut url = url::Url::parse("https://photon.komoot.io/api/").expect("photon url");
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("limit", "5");
    url.to_string()
}

fn nominatim_search_url(query: &str) -> String {
    let mut url =
        url::Url::parse("https://nominatim.openstreetmap.org/search").expect("nominatim url");
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("format", "jsonv2")
        .append_pair("limit", "5")
        .append_pair("addressdetails", "1");
    url.to_string()
}

fn meteo_search_url(query: &str) -> String {
    let mut url =
        url::Url::parse("https://geocoding-api.open-meteo.com/v1/search").expect("meteo url");
    url.query_pairs_mut()
        .append_pair("name", query)
        .append_pair("count", "5")
        .append_pair("language", "en")
        .append_pair("format", "json");
    url.to_string()
}

fn parse_photon_body(body: &str) -> Result<Vec<ResolvedLocation>, String> {
    let value: Value = serde_json::from_str(body)
        .map_err(|_| "Address lookup returned data this app could not read.".to_string())?;
    Ok(photon_matches(&value))
}

fn photon_matches(value: &Value) -> Vec<ResolvedLocation> {
    let Some(features) = value.get("features").and_then(|item| item.as_array()) else {
        return Vec::new();
    };
    features.iter().filter_map(photon_feature).collect()
}

fn photon_feature(feature: &Value) -> Option<ResolvedLocation> {
    let coords = feature.get("geometry")?.get("coordinates")?.as_array()?;
    let lon = coords.first()?.as_f64()?;
    let lat = coords.get(1)?.as_f64()?;
    if !in_range(lat, lon) {
        return None;
    }
    let props = feature.get("properties")?.as_object()?;
    let label = photon_label(props);
    let label = if label.is_empty() {
        format_coords(lat, lon)
    } else {
        label
    };
    Some(resolved(lat, lon, label, "address", None))
}

fn photon_label(props: &serde_json::Map<String, Value>) -> String {
    let name = str_prop(props, "name");
    let number = str_prop(props, "housenumber");
    let street = str_prop(props, "street");
    let street_line = match (number, street) {
        (Some(n), Some(s)) => {
            if s.to_lowercase().contains(&n.to_lowercase()) {
                s
            } else {
                format!("{n} {s}")
            }
        }
        (None, Some(s)) => s,
        (Some(n), None) => n,
        (None, None) => String::new(),
    };
    let city = str_prop(props, "city").or_else(|| str_prop(props, "district"));
    join_place(
        [
            name,
            (!street_line.is_empty()).then_some(street_line),
            city,
            str_prop(props, "state"),
            str_prop(props, "country"),
        ]
        .into_iter()
        .flatten(),
    )
}

fn parse_nominatim_body(body: &str) -> Result<Vec<ResolvedLocation>, String> {
    let value: Value = serde_json::from_str(body)
        .map_err(|_| "Address lookup returned data this app could not read.".to_string())?;
    let Some(rows) = value.as_array() else {
        return Ok(Vec::new());
    };
    Ok(rows
        .iter()
        .filter_map(|row| {
            let lat = row.get("lat")?.as_str()?.parse::<f64>().ok()?;
            let lon = row.get("lon")?.as_str()?.parse::<f64>().ok()?;
            if !in_range(lat, lon) {
                return None;
            }
            let label = row
                .get("display_name")
                .and_then(|item| item.as_str())
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format_coords(lat, lon));
            Some(resolved(lat, lon, label, "address", None))
        })
        .collect())
}

fn parse_meteo_body(body: &str) -> Result<Vec<ResolvedLocation>, String> {
    let value: Value = serde_json::from_str(body)
        .map_err(|_| "Address lookup returned data this app could not read.".to_string())?;
    let Some(rows) = value.get("results").and_then(|item| item.as_array()) else {
        return Ok(Vec::new());
    };
    Ok(rows
        .iter()
        .filter_map(|row| {
            let lat = row.get("latitude")?.as_f64()?;
            let lon = row.get("longitude")?.as_f64()?;
            if !in_range(lat, lon) {
                return None;
            }
            let label = join_place(
                [
                    str_val(row, "name"),
                    str_val(row, "admin1"),
                    str_val(row, "country"),
                ]
                .into_iter()
                .flatten(),
            );
            let label = if label.is_empty() {
                format_coords(lat, lon)
            } else {
                label
            };
            Some(resolved(lat, lon, label, "address", None))
        })
        .collect())
}

fn parse_ipwho_body(body: &str) -> Result<ResolvedLocation, String> {
    let value: Value = serde_json::from_str(body)
        .map_err(|_| "Network location returned data this app could not read.".to_string())?;
    if value.get("success").and_then(|item| item.as_bool()) == Some(false) {
        let message = value
            .get("message")
            .and_then(|item| item.as_str())
            .unwrap_or("No network location.");
        return Err(message.to_string());
    }
    let lat = value
        .get("latitude")
        .and_then(|item| item.as_f64())
        .ok_or("No network location. The IP lookup did not return a place.")?;
    let lon = value
        .get("longitude")
        .and_then(|item| item.as_f64())
        .ok_or("No network location. The IP lookup did not return a place.")?;
    if !in_range(lat, lon) {
        return Err("The lookup returned coordinates that are not a real location.".into());
    }
    let label = join_place(
        [
            str_val(&value, "city"),
            str_val(&value, "region"),
            str_val(&value, "country"),
        ]
        .into_iter()
        .flatten(),
    );
    let label = if label.is_empty() {
        format_coords(lat, lon)
    } else {
        label
    };
    Ok(resolved(lat, lon, label, "network", None))
}

fn parse_gpsd_stream(text: &str) -> Result<Fix, String> {
    let mut found: Option<Fix> = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("class").and_then(|item| item.as_str()) != Some("TPV") {
            continue;
        }
        let mode = value
            .get("mode")
            .and_then(|item| item.as_i64())
            .unwrap_or(0);
        if mode < 2 {
            continue;
        }
        let Some(lat) = value.get("lat").and_then(|item| item.as_f64()) else {
            continue;
        };
        let Some(lon) = value.get("lon").and_then(|item| item.as_f64()) else {
            continue;
        };
        if !in_range(lat, lon) {
            continue;
        }
        let accuracy = horizontal_accuracy(&value);
        found = Some(Fix {
            lat,
            lon,
            accuracy_m: accuracy,
            label: None,
        });
    }
    found.ok_or_else(|| "No GPS fix. This device did not report a satellite position.".to_string())
}

fn horizontal_accuracy(value: &Value) -> Option<f64> {
    if let Some(eph) = value
        .get("eph")
        .and_then(|item| item.as_f64())
        .filter(|n| n.is_finite() && *n >= 0.0)
    {
        return Some(eph);
    }
    let epx = value.get("epx").and_then(|item| item.as_f64());
    let epy = value.get("epy").and_then(|item| item.as_f64());
    match (epx, epy) {
        (Some(x), Some(y)) if x.is_finite() && y.is_finite() && x >= 0.0 && y >= 0.0 => {
            Some(x.hypot(y))
        }
        (Some(x), _) if x.is_finite() && x >= 0.0 => Some(x),
        (_, Some(y)) if y.is_finite() && y >= 0.0 => Some(y),
        _ => None,
    }
}

fn parse_busctl_object(text: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("o ") else {
            continue;
        };
        let path = rest.trim().trim_matches('"');
        if path.starts_with('/') {
            return Some(path.to_string());
        }
    }
    None
}

fn parse_busctl_double(text: &str) -> Option<f64> {
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("d ") else {
            continue;
        };
        let value = rest.trim().parse::<f64>().ok()?;
        if value.is_finite() {
            return Some(value);
        }
    }
    None
}

fn resolved(
    lat: f64,
    lon: f64,
    label: String,
    source: &str,
    accuracy_m: Option<f64>,
) -> ResolvedLocation {
    ResolvedLocation {
        lat,
        lon,
        label,
        source: source.to_string(),
        accuracy_m,
        confirmed: true,
    }
}

fn in_range(lat: f64, lon: f64) -> bool {
    lat.is_finite()
        && lon.is_finite()
        && (-90.0..=90.0).contains(&lat)
        && (-180.0..=180.0).contains(&lon)
}

fn number_at(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64().filter(|n| n.is_finite()),
        Value::String(text) => text.trim().parse::<f64>().ok().filter(|n| n.is_finite()),
        _ => None,
    }
}

fn str_prop(map: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    str_val(&Value::Object(map.clone()), key)
}

fn str_val(value: &Value, key: &str) -> Option<String> {
    match value.get(key)? {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn join_place<I>(parts: I) -> String
where
    I: IntoIterator<Item = String>,
{
    let mut out: Vec<String> = Vec::new();
    for part in parts {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if out
            .last()
            .is_some_and(|prev| prev.eq_ignore_ascii_case(part))
        {
            continue;
        }
        out.push(part.to_string());
    }
    out.join(", ")
}

fn format_coords(lat: f64, lon: f64) -> String {
    format!("{lat:.5}, {lon:.5}")
}

fn format_accuracy(meters: f64) -> String {
    if meters >= 1000.0 {
        format!("about {} km", (meters / 1000.0).round() as i64)
    } else {
        format!("about {} m", meters.round() as i64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn photon_street_address_confirms_white_house() {
        let body = r#"{
          "type":"FeatureCollection",
          "features":[{
            "type":"Feature",
            "properties":{
              "name":"White House",
              "housenumber":"1600",
              "street":"Pennsylvania Avenue Northwest",
              "city":"Washington",
              "state":"DC",
              "country":"United States"
            },
            "geometry":{"type":"Point","coordinates":[-77.0365525,38.8976387]}
          }]
        }"#;
        let matches = parse_photon_body(body).unwrap();
        assert_eq!(matches.len(), 1);
        assert!(matches[0].confirmed);
        assert_eq!(matches[0].source, "address");
        assert!((matches[0].lat - 38.8976387).abs() < 1e-6);
        assert!((matches[0].lon + 77.0365525).abs() < 1e-6);
        assert_eq!(
            matches[0].label,
            "White House, 1600 Pennsylvania Avenue Northwest, Washington, DC, United States"
        );
    }

    #[test]
    fn photon_drops_coordinates_outside_range() {
        let body = r#"{"features":[{"properties":{"name":"Nowhere"},"geometry":{"coordinates":[0,120]}}]}"#;
        assert!(parse_photon_body(body).unwrap().is_empty());
    }

    #[test]
    fn nominatim_uses_display_name() {
        let body = r#"[{
          "lat":"30.26715",
          "lon":"-97.74306",
          "display_name":"Austin, Travis County, Texas, United States"
        }]"#;
        let matches = parse_nominatim_body(body).unwrap();
        assert_eq!(
            matches[0].label,
            "Austin, Travis County, Texas, United States"
        );
        assert!(matches[0].confirmed);
    }

    #[test]
    fn open_meteo_city_label() {
        let body = r#"{"results":[{
          "name":"Austin",
          "latitude":30.26715,
          "longitude":-97.74306,
          "admin1":"Texas",
          "country":"United States"
        }]}"#;
        let matches = parse_meteo_body(body).unwrap();
        assert_eq!(matches[0].label, "Austin, Texas, United States");
    }

    #[test]
    fn ipwho_confirms_network_place() {
        let body = r#"{
          "success": true,
          "city": "Boardman",
          "region": "Oregon",
          "country": "United States",
          "latitude": 45.83986,
          "longitude": -119.70058
        }"#;
        let loc = parse_ipwho_body(body).unwrap();
        assert_eq!(loc.source, "network");
        assert!(loc.confirmed);
        assert_eq!(loc.label, "Boardman, Oregon, United States");
    }

    #[test]
    fn ipwho_failure_is_an_error() {
        let err =
            parse_ipwho_body(r#"{"success":false,"message":"Invalid IP address"}"#).unwrap_err();
        assert!(err.contains("Invalid IP"));
    }

    #[test]
    fn gpsd_uses_last_real_fix() {
        let text = r#"
{"class":"TPV","mode":1,"lat":1,"lon":2}
{"class":"SKY","satellites":[]}
{"class":"TPV","mode":3,"lat":30.2672,"lon":-97.7431,"epx":3.0,"epy":4.0}
{"class":"TPV","mode":3,"lat":30.2700,"lon":-97.7500,"eph":12.5}
"#;
        let fix = parse_gpsd_stream(text).unwrap();
        assert!((fix.lat - 30.27).abs() < 1e-6);
        assert_eq!(fix.accuracy_m, Some(12.5));
    }

    #[test]
    fn gpsd_without_a_fix_errors() {
        let err = parse_gpsd_stream(r#"{"class":"TPV","mode":1}"#).unwrap_err();
        assert!(err.contains("No GPS fix"));
    }

    #[test]
    fn busctl_parsers_read_geoclue_values() {
        assert_eq!(
            parse_busctl_object("o /org/freedesktop/GeoClue2/Client/3\n").as_deref(),
            Some("/org/freedesktop/GeoClue2/Client/3")
        );
        assert_eq!(parse_busctl_double("d 45.83986\n"), Some(45.83986));
    }

    #[test]
    fn blank_address_is_rejected() {
        assert!(normalize_address("   ")
            .unwrap_err()
            .contains("Type an address"));
    }

    #[test]
    fn unconfirmed_location_object_is_missing() {
        assert!(value_missing(&json!({
            "confirmed": false,
            "lat": 30.0,
            "lon": -97.0
        })));
        assert!(value_missing(&json!({
            "confirmed": true,
            "lat": 95.0,
            "lon": -97.0
        })));
        assert!(!value_missing(&json!({
            "confirmed": true,
            "lat": 30.27,
            "lon": -97.74,
            "label": "Austin"
        })));
    }

    #[test]
    fn lookup_coords_reads_confirmed_object() {
        let mut params = BTreeMap::new();
        params.insert(
            "location".into(),
            json!({
                "confirmed": true,
                "lat": 38.89764,
                "lon": -77.03655,
                "label": "White House"
            }),
        );
        assert_eq!(
            lookup_coords(&params, "lat", "lon"),
            Some((38.89764, -77.03655))
        );
        params.insert("lat".into(), json!(30.1));
        params.insert("lon".into(), json!(-97.2));
        assert_eq!(lookup_coords(&params, "lat", "lon"), Some((30.1, -97.2)));
    }

    #[test]
    fn join_place_skips_blanks_and_repeats() {
        assert_eq!(
            join_place(["Austin".into(), " ".into(), "austin".into(), "Texas".into()]),
            "Austin, Texas"
        );
    }
}
