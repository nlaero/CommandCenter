//! Television output. The computer keeps setup. The TV shows the board only.
//!
//! A 58-inch or larger television stays sharp at 3840×2160 or higher. Smaller
//! framebuffers are refused so Command Center does not stretch a soft picture.
//! More than one television splits that board. Display screens on this computer
//! can split it too, at each screen's own size.

use crate::commands::CommandError;
use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Manager, PhysicalPosition, PhysicalSize};

pub const TV_MIN_WIDTH: u32 = 3840;
pub const TV_MIN_HEIGHT: u32 = 2160;
const TV_LABEL: &str = "tv";
const PREVIEW_LABEL: &str = "tv-preview";
const AIRPLAY_SERVICE: &str = "_airplay._tcp.local.";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CastScreen {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub x: i32,
    pub y: i32,
    pub current: bool,
    pub sharp: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AirPlayReceiver {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub model: String,
    pub model_label: String,
    pub features: String,
    pub video: bool,
    pub screen: bool,
    pub audio_only: bool,
    pub asks_for_pin: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// `Some` when the model is a known Apple TV. `None` when the ad does not say.
    pub sharp: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CastSplitTarget {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CastSession {
    pub method: String,
    pub target_id: String,
    pub target_name: String,
    pub width: u32,
    pub height: u32,
    /// Televisions the board is divided across. Empty when one television shows the whole board.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub split: Vec<CastSplitTarget>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AirPlayScan {
    pub receivers: Vec<AirPlayReceiver>,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastRequest {
    pub method: String,
    pub target_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpanRequest {
    pub screen_ids: Vec<String>,
    #[serde(default)]
    pub require_sharp: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct KnownPicture {
    pub label: &'static str,
    pub width: u32,
    pub height: u32,
}

struct CastBook {
    session: Option<CastSession>,
    receivers: Vec<AirPlayReceiver>,
}

fn book() -> &'static Mutex<CastBook> {
    static BOOK: OnceLock<Mutex<CastBook>> = OnceLock::new();
    BOOK.get_or_init(|| {
        Mutex::new(CastBook {
            session: None,
            receivers: Vec::new(),
        })
    })
}

fn lock_book() -> std::sync::MutexGuard<'static, CastBook> {
    book().lock().unwrap_or_else(|err| err.into_inner())
}

pub fn is_sharp(width: u32, height: u32) -> bool {
    width >= TV_MIN_WIDTH && height >= TV_MIN_HEIGHT
}

/// CSS pixels times the screen scale, unless the reported size is already 4K.
/// A 4K television at 150% or 200% scaling still counts as sharp.
/// The desktop UI applies the same rule in TypeScript. Tests lock this copy.
#[cfg(test)]
pub fn physical_pixels(css_width: f64, css_height: f64, scale: f64) -> (u32, u32) {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let width = if css_width.is_finite() && css_width > 0.0 {
        css_width
    } else {
        0.0
    };
    let height = if css_height.is_finite() && css_height > 0.0 {
        css_height
    } else {
        0.0
    };
    if width >= f64::from(TV_MIN_WIDTH) && height >= f64::from(TV_MIN_HEIGHT) {
        return (width.round() as u32, height.round() as u32);
    }
    (
        (width * scale).round() as u32,
        (height * scale).round() as u32,
    )
}

/// Row height for the television. Matches `tvRowHeight` in the desktop UI.
/// Density 1 fills the glass. A denser scale caps that stretch. Tests lock this copy.
#[cfg(test)]
pub fn tv_row_height(base: i32, rows: i32, viewport_height: i32) -> i32 {
    tv_row_height_scaled(base, rows, viewport_height, 1.0)
}

#[cfg(test)]
pub fn tv_row_height_scaled(base: i32, rows: i32, viewport_height: i32, density: f64) -> i32 {
    let scale = clamp_board_density(density);
    let span = rows.max(1);
    let safe_base = if base > 0 { base } else { 12 };
    let (margin_y, padding_y) = tv_grid_chrome(scale);
    let fitted = fitted_row(span, viewport_height, margin_y, padding_y);
    if scale >= 1.0 {
        let natural = ((f64::from(safe_base)) * scale).round().max(4.0) as i32;
        let cap = ((160.0 * scale).round().max(160.0)).min(200.0) as i32;
        if fitted >= natural {
            return fitted.min(cap);
        }
        return fitted;
    }
    let natural = ((f64::from(safe_base)) * scale).round().max(4.0) as i32;
    let distance = (f64::from(viewport_height) / 1080.0).clamp(1.0, 2.0);
    let cap = ((f64::from(natural)) * distance)
        .round()
        .max(f64::from(natural)) as i32;
    fitted.min(cap)
}

#[cfg(test)]
fn clamp_board_density(value: f64) -> f64 {
    if !value.is_finite() {
        return 1.0;
    }
    let clamped = value.clamp(0.45, 1.5);
    (clamped * 100.0).round() / 100.0
}

#[cfg(test)]
fn tv_grid_chrome(scale: f64) -> (i32, i32) {
    if scale >= 1.0 {
        return (4, 8);
    }
    (
        ((4.0 * scale).round() as i32).max(1),
        ((8.0 * scale).round() as i32).max(2),
    )
}

#[cfg(test)]
fn fitted_row(span: i32, viewport_height: i32, margin_y: i32, padding_y: i32) -> i32 {
    let chrome = padding_y * 2 + margin_y * (span - 1).max(0);
    let available = (viewport_height - chrome).max(span);
    let floor = if margin_y == 4 && padding_y == 8 {
        8
    } else {
        4
    };
    (available / span).max(floor)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AirPlayFeatures {
    pub parsed: bool,
    pub video: bool,
    pub screen: bool,
}

pub fn parse_features(raw: &str) -> AirPlayFeatures {
    let mut low: Option<u128> = None;
    for piece in raw.split(|c: char| c == ',' || c.is_whitespace()) {
        let piece = piece.trim();
        if piece.is_empty() {
            continue;
        }
        if let Some(value) = parse_feature_word(piece) {
            low.get_or_insert(value);
            break;
        }
    }
    match low {
        Some(value) => AirPlayFeatures {
            parsed: true,
            video: value & 0x1 != 0,
            screen: value & 0x80 != 0,
        },
        None => AirPlayFeatures {
            parsed: false,
            video: false,
            screen: false,
        },
    }
}

fn parse_feature_word(piece: &str) -> Option<u128> {
    if let Some(hex) = piece
        .strip_prefix("0x")
        .or_else(|| piece.strip_prefix("0X"))
    {
        return u128::from_str_radix(hex, 16).ok();
    }
    if piece.chars().all(|c| c.is_ascii_digit()) {
        return piece.parse().ok();
    }
    None
}

pub fn known_apple_tv(model: &str) -> Option<KnownPicture> {
    match model.trim() {
        "AppleTV2,1" => Some(KnownPicture {
            label: "Apple TV (2nd generation)",
            width: 1280,
            height: 720,
        }),
        "AppleTV3,1" | "AppleTV3,2" => Some(KnownPicture {
            label: "Apple TV (3rd generation)",
            width: 1920,
            height: 1080,
        }),
        "AppleTV5,3" => Some(KnownPicture {
            label: "Apple TV HD",
            width: 1920,
            height: 1080,
        }),
        "AppleTV6,2" => Some(KnownPicture {
            label: "Apple TV 4K",
            width: 3840,
            height: 2160,
        }),
        "AppleTV11,1" => Some(KnownPicture {
            label: "Apple TV 4K (2nd generation)",
            width: 3840,
            height: 2160,
        }),
        "AppleTV14,1" => Some(KnownPicture {
            label: "Apple TV 4K (3rd generation)",
            width: 3840,
            height: 2160,
        }),
        _ => None,
    }
}

pub fn parse_stream_xml(xml: &str) -> Option<(u32, u32)> {
    let width = plist_number(xml, "width")?;
    let height = plist_number(xml, "height")?;
    if width == 0 || height == 0 {
        return None;
    }
    Some((width, height))
}

fn plist_number(xml: &str, key: &str) -> Option<u32> {
    let needle = format!("<key>{key}</key>");
    let idx = xml.find(&needle)?;
    let rest = xml[idx + needle.len()..].trim_start();
    let (open, close) = if rest.starts_with("<integer>") {
        ("<integer>", "</integer>")
    } else if rest.starts_with("<real>") {
        ("<real>", "</real>")
    } else {
        return None;
    };
    let start = open.len();
    let end = rest[start..].find(close)? + start;
    let value: f64 = rest[start..end].trim().parse().ok()?;
    if !value.is_finite() || value <= 0.0 || value > 100_000.0 {
        return None;
    }
    Some(value.round() as u32)
}

pub fn normalize_name(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

pub fn names_match(receiver: &str, monitor: &str) -> bool {
    let left = normalize_name(receiver);
    let right = normalize_name(monitor);
    if left.len() < 3 || right.len() < 3 {
        return false;
    }
    left.contains(&right) || right.contains(&left)
}

/// Screens to open for a wall. The computer is skipped unless this is a television
/// wall, which refuses it. A television wall also refuses anything below 4K.
fn span_plan<'a>(
    screens: &'a [CastScreen],
    ids: &[String],
    require_sharp: bool,
) -> Result<Vec<&'a CastScreen>, String> {
    let mut picked: Vec<&CastScreen> = Vec::new();
    for id in ids {
        let Some(screen) = screens.iter().find(|screen| screen.id == *id) else {
            return Err("That screen is no longer connected. Refresh and pick it again.".into());
        };
        if screen.current {
            if require_sharp {
                return Err("This is the computer. Setup stays here. Pick the television.".into());
            }
            continue;
        }
        if require_sharp {
            if let Some(reason) = mirror_block_reason(screen) {
                return Err(reason);
            }
        }
        if picked.iter().any(|item| item.id == screen.id) {
            continue;
        }
        picked.push(screen);
    }
    picked.sort_by(|a, b| a.y.cmp(&b.y).then(a.x.cmp(&b.x)).then(a.id.cmp(&b.id)));
    if picked.len() > 8 {
        picked.truncate(8);
    }
    if require_sharp && picked.len() < 2 {
        return Err("Pick at least two televisions to split the board.".into());
    }
    Ok(picked)
}

fn encode_query(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn pool_labels(prefix: &str) -> Vec<String> {
    (1..=8).map(|index| format!("{prefix}-{index}")).collect()
}

fn close_pool(app: &tauri::AppHandle, prefix: &str) -> Result<(), String> {
    for label in pool_labels(prefix) {
        if let Some(window) = app.get_webview_window(&label) {
            window.close().map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

fn pool_open(app: &tauri::AppHandle, prefix: &str) -> bool {
    pool_labels(prefix)
        .iter()
        .any(|label| app.get_webview_window(label).is_some())
}

pub fn mirror_block_reason(screen: &CastScreen) -> Option<String> {
    if screen.current {
        return Some("This is the computer. Setup stays here. Pick the television.".into());
    }
    if !screen.sharp {
        return Some(format!(
            "{} × {} is below 3840 × 2160. A 58-inch or larger television would look soft. Set that display to 4K and refresh.",
            screen.width, screen.height
        ));
    }
    None
}

pub fn airplay_target<'a>(
    receiver: &AirPlayReceiver,
    screens: &'a [CastScreen],
    probed: Option<(u32, u32)>,
) -> Result<&'a CastScreen, String> {
    if receiver.audio_only {
        return Err("This receiver only does audio, so it can't show the board.".into());
    }
    if receiver.sharp == Some(false) {
        let label = if receiver.model_label.is_empty() {
            receiver.name.as_str()
        } else {
            receiver.model_label.as_str()
        };
        let width = receiver.width.unwrap_or(0);
        let height = receiver.height.unwrap_or(0);
        return Err(format!(
            "{label} only goes to {width} × {height}. That is soft on a 58-inch or larger television."
        ));
    }
    let named: Vec<&CastScreen> = screens
        .iter()
        .filter(|screen| names_match(&receiver.name, &screen.name))
        .collect();
    let mut external: Vec<&CastScreen> = named
        .iter()
        .copied()
        .filter(|screen| !screen.current)
        .collect();
    external.sort_by_key(|screen| !screen.sharp);
    if let Some(screen) = external.first().copied() {
        if let Some(reason) = mirror_block_reason(screen) {
            return Err(reason);
        }
        return Ok(screen);
    }
    if named.iter().any(|screen| screen.current) {
        return Err("This is the computer. Setup stays here. Pick the television.".into());
    }
    if let Some((width, height)) = probed {
        if !is_sharp(width, height) {
            return Err(format!(
                "The receiver reports {width} × {height}. That picture is soft on a 58-inch or larger television."
            ));
        }
    }
    Err(not_connected_message(receiver))
}

fn not_connected_message(receiver: &AirPlayReceiver) -> String {
    let who = if receiver.model_label.is_empty() {
        receiver.name.clone()
    } else {
        format!("{} ({})", receiver.name, receiver.model_label)
    };
    format!(
        "{who} is not connected as a display on this computer. Connect the television from here (HDMI, or the system AirPlay display), then show the board again. Setup stays on this computer. The television only shows the picture, at 3840 × 2160 or higher."
    )
}

fn monitor_label(monitor: &tauri::Monitor) -> String {
    monitor
        .name()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("Display")
        .to_string()
}

fn monitor_id(monitor: &tauri::Monitor) -> String {
    let size = monitor.size();
    let pos = monitor.position();
    format!(
        "{}|{}|{}|{}|{}",
        monitor_label(monitor),
        size.width,
        size.height,
        pos.x,
        pos.y
    )
}

fn collect_screens(window: &tauri::WebviewWindow) -> Result<Vec<CastScreen>, CommandError> {
    let current = window.current_monitor().map_err(|err| CommandError {
        message: err.to_string(),
    })?;
    let current_id = current.as_ref().map(monitor_id);
    let monitors = window.available_monitors().map_err(|err| CommandError {
        message: err.to_string(),
    })?;
    let mut screens = Vec::with_capacity(monitors.len());
    for monitor in monitors {
        let id = monitor_id(&monitor);
        let size = monitor.size();
        let pos = monitor.position();
        let name = monitor_label(&monitor);
        let width = size.width;
        let height = size.height;
        screens.push(CastScreen {
            id: id.clone(),
            name,
            width,
            height,
            scale: monitor.scale_factor(),
            x: pos.x,
            y: pos.y,
            current: current_id.as_deref() == Some(id.as_str()),
            sharp: is_sharp(width, height),
        });
    }
    Ok(screens)
}

fn instance_name(fullname: &str) -> String {
    let decoded = fullname.replace("\\032", " ").replace("\\.", ".");
    let lower = decoded.to_ascii_lowercase();
    let marker = "._airplay._tcp.";
    let name = if let Some(idx) = lower.find(marker) {
        decoded[..idx].trim_matches('.').trim()
    } else {
        decoded.trim_end_matches('.').trim()
    };
    if name.is_empty() {
        "AirPlay".to_string()
    } else {
        name.to_string()
    }
}

fn pick_host(addresses: &std::collections::HashSet<mdns_sd::ScopedIp>, fallback: &str) -> String {
    let mut v4_good: Option<Ipv4Addr> = None;
    let mut v4_link: Option<Ipv4Addr> = None;
    let mut v6: Option<Ipv6Addr> = None;
    for addr in addresses {
        match addr {
            mdns_sd::ScopedIp::V4(ip) => {
                let ip = *ip.addr();
                if ip.is_unspecified() || ip.is_loopback() {
                    continue;
                }
                if ip.is_link_local() {
                    v4_link.get_or_insert(ip);
                } else if v4_good.is_none() {
                    v4_good = Some(ip);
                }
            }
            mdns_sd::ScopedIp::V6(ip) => {
                let ip = *ip.addr();
                if ip.is_loopback() || ip.is_unspecified() {
                    continue;
                }
                v6.get_or_insert(ip);
            }
            _ => {}
        }
    }
    if let Some(ip) = v4_good.or(v4_link) {
        return ip.to_string();
    }
    if let Some(ip) = v6 {
        return format!("[{ip}]");
    }
    let fallback = fallback.trim().trim_end_matches('.').trim();
    if fallback.is_empty() || fallback.eq_ignore_ascii_case("local") {
        String::new()
    } else {
        fallback.to_string()
    }
}

fn receiver_from_resolved(resolved: &mdns_sd::ResolvedService) -> Option<AirPlayReceiver> {
    let name = instance_name(&resolved.fullname);
    let host = pick_host(&resolved.addresses, &resolved.host);
    let model = resolved
        .txt_properties
        .get_property_val_str("model")
        .unwrap_or("")
        .trim()
        .to_string();
    let features = resolved
        .txt_properties
        .get_property_val_str("features")
        .unwrap_or("")
        .trim()
        .to_string();
    let flags = parse_features(&features);
    let pw = resolved
        .txt_properties
        .get_property_val_str("pw")
        .unwrap_or("")
        .trim();
    let asks_for_pin = pw == "1" || pw.eq_ignore_ascii_case("true");
    let known = known_apple_tv(&model);
    let (width, height, sharp, model_label) = if let Some(known) = known {
        (
            Some(known.width),
            Some(known.height),
            Some(is_sharp(known.width, known.height)),
            known.label.to_string(),
        )
    } else {
        (None, None, None, String::new())
    };
    let audio_only = flags.parsed && !flags.video && !flags.screen;
    let id = if resolved.fullname.is_empty() {
        format!("{name}|{host}|{}", resolved.port)
    } else {
        resolved.fullname.clone()
    };
    Some(AirPlayReceiver {
        id,
        name,
        host,
        port: resolved.port,
        model,
        model_label,
        features,
        video: flags.video,
        screen: flags.screen,
        audio_only,
        asks_for_pin,
        width,
        height,
        sharp,
    })
}

fn browse_airplay(wait: Duration) -> Result<Vec<AirPlayReceiver>, String> {
    let mdns = ServiceDaemon::new().map_err(|err| err.to_string())?;
    let receiver = mdns
        .browse(AIRPLAY_SERVICE)
        .map_err(|err| err.to_string())?;
    let deadline = Instant::now() + wait;
    let mut found: HashMap<String, AirPlayReceiver> = HashMap::new();
    while Instant::now() < deadline {
        match receiver.recv_timeout(Duration::from_millis(200)) {
            Ok(ServiceEvent::ServiceResolved(resolved)) => {
                if let Some(item) = receiver_from_resolved(&resolved) {
                    found.insert(item.id.clone(), item);
                }
            }
            Ok(_) => {}
            Err(mdns_sd::RecvTimeoutError::Timeout) => {}
            Err(_) => break,
        }
    }
    let _ = mdns.shutdown();
    let mut receivers: Vec<AirPlayReceiver> = found.into_values().collect();
    receivers.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(receivers)
}

fn probe_mirror_size(host: &str) -> Option<(u32, u32)> {
    let host = host.trim();
    if host.is_empty() {
        return None;
    }
    let url = format!("http://{host}:7100/stream.xml");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok()?;
    let response = client
        .get(url)
        .header("user-agent", "AirPlay/420.3")
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let text = response.text().ok()?;
    if text.len() > 65_536 {
        return None;
    }
    parse_stream_xml(&text)
}

fn on_main(
    app: &tauri::AppHandle,
    work: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(work());
    })
    .map_err(|err| err.to_string())?;
    rx.recv().map_err(|err| err.to_string())?
}

fn open_board_window(
    app: &tauri::AppHandle,
    label: &str,
    url: &str,
    screen: Option<&CastScreen>,
    borderless: bool,
) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(label) {
        let _ = existing.close();
    }
    let mut builder =
        tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App(url.into()))
            .title(if borderless {
                "Command Center"
            } else {
                "Command Center picture check"
            })
            .decorations(!borderless)
            .resizable(!borderless)
            .maximizable(!borderless)
            .minimizable(!borderless)
            .closable(true)
            .skip_taskbar(borderless)
            .always_on_top(false)
            .focused(!borderless)
            .visible(true)
            .shadow(!borderless);
    if let Some(screen) = screen {
        let scale = if screen.scale.is_finite() && screen.scale > 0.0 {
            screen.scale
        } else {
            1.0
        };
        if borderless {
            builder = builder
                .position(f64::from(screen.x) / scale, f64::from(screen.y) / scale)
                .inner_size(
                    f64::from(screen.width) / scale,
                    f64::from(screen.height) / scale,
                );
        } else {
            let width = 1280.0_f64
                .min((f64::from(screen.width) / scale) - 80.0)
                .max(960.0);
            let height = 720.0_f64
                .min((f64::from(screen.height) / scale) - 80.0)
                .max(640.0);
            builder = builder
                .position(
                    f64::from(screen.x) / scale + 48.0,
                    f64::from(screen.y) / scale + 48.0,
                )
                .inner_size(width, height);
        }
    } else if !borderless {
        builder = builder.inner_size(1280.0, 720.0).center();
    }
    let window = builder.build().map_err(|err| err.to_string())?;
    let _ = window.remove_menu();
    if borderless {
        if let Some(screen) = screen {
            let _ = window.set_position(PhysicalPosition::new(screen.x, screen.y));
            let _ = window.set_size(PhysicalSize::new(screen.width, screen.height));
        }
    }
    Ok(())
}

fn session_for(method: &str, screen: &CastScreen) -> CastSession {
    CastSession {
        method: method.to_string(),
        target_id: screen.id.clone(),
        target_name: screen.name.clone(),
        width: screen.width,
        height: screen.height,
        split: Vec::new(),
    }
}

fn split_session(screens: &[CastScreen]) -> CastSession {
    CastSession {
        method: "mirror".to_string(),
        target_id: screens
            .iter()
            .map(|screen| screen.id.clone())
            .collect::<Vec<_>>()
            .join("\n"),
        target_name: screens
            .iter()
            .map(|screen| screen.name.clone())
            .collect::<Vec<_>>()
            .join(" · "),
        width: screens
            .iter()
            .map(|screen| screen.width)
            .max()
            .unwrap_or(TV_MIN_WIDTH),
        height: screens
            .iter()
            .map(|screen| screen.height)
            .max()
            .unwrap_or(TV_MIN_HEIGHT),
        split: screens
            .iter()
            .map(|screen| CastSplitTarget {
                id: screen.id.clone(),
                name: screen.name.clone(),
                width: screen.width,
                height: screen.height,
            })
            .collect(),
    }
}

fn remember(session: CastSession) -> CastSession {
    lock_book().session = Some(session.clone());
    session
}

#[tauri::command]
pub fn list_cast_screens(window: tauri::WebviewWindow) -> Result<Vec<CastScreen>, CommandError> {
    collect_screens(&window)
}

#[tauri::command]
pub async fn scan_airplay() -> Result<AirPlayScan, CommandError> {
    let scan =
        tauri::async_runtime::spawn_blocking(|| match browse_airplay(Duration::from_secs(2)) {
            Ok(receivers) => {
                let message = if receivers.is_empty() {
                    "No AirPlay receivers found on this network.".to_string()
                } else {
                    String::new()
                };
                AirPlayScan { receivers, message }
            }
            Err(err) => AirPlayScan {
                receivers: Vec::new(),
                message: format!("Could not search for AirPlay receivers. {err}"),
            },
        })
        .await
        .map_err(|err| CommandError {
            message: err.to_string(),
        })?;
    lock_book().receivers = scan.receivers.clone();
    Ok(scan)
}

#[tauri::command]
pub async fn cast_start(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: CastRequest,
) -> Result<CastSession, CommandError> {
    let screens = collect_screens(&window)?;
    match request.method.as_str() {
        "mirror" => {
            let screen = screens
                .iter()
                .find(|screen| screen.id == request.target_id)
                .ok_or_else(|| CommandError {
                    message: "That screen is no longer connected. Refresh and pick it again."
                        .into(),
                })?;
            if let Some(reason) = mirror_block_reason(screen) {
                return Err(CommandError { message: reason });
            }
            let screen = screen.clone();
            let placed = screen.clone();
            let app_window = app.clone();
            on_main(&app, move || {
                close_pool(&app_window, "tv")?;
                open_board_window(
                    &app_window,
                    TV_LABEL,
                    "index.html?view=tv",
                    Some(&placed),
                    true,
                )
            })
            .map_err(|message| CommandError { message })?;
            Ok(remember(session_for("mirror", &screen)))
        }
        "airplay" => {
            let receiver = lock_book()
                .receivers
                .iter()
                .find(|item| item.id == request.target_id)
                .cloned()
                .ok_or_else(|| CommandError {
                    message:
                        "That AirPlay receiver is no longer listed. Refresh and pick it again."
                            .into(),
                })?;
            let probed = if receiver.sharp == Some(false) || receiver.audio_only {
                None
            } else {
                let host = receiver.host.clone();
                tauri::async_runtime::spawn_blocking(move || probe_mirror_size(&host))
                    .await
                    .ok()
                    .flatten()
            };
            let screen = airplay_target(&receiver, &screens, probed)
                .map_err(|message| CommandError { message })?
                .clone();
            let placed = screen.clone();
            let app_window = app.clone();
            on_main(&app, move || {
                close_pool(&app_window, "tv")?;
                open_board_window(
                    &app_window,
                    TV_LABEL,
                    "index.html?view=tv",
                    Some(&placed),
                    true,
                )
            })
            .map_err(|message| CommandError { message })?;
            let mut session = session_for("airplay", &screen);
            session.target_id = receiver.id;
            session.target_name = receiver.name;
            Ok(remember(session))
        }
        _ => Err(CommandError {
            message: "Pick AirPlay or screen mirroring.".into(),
        }),
    }
}

#[tauri::command]
pub async fn cast_stop(app: tauri::AppHandle) -> Result<(), CommandError> {
    let app_window = app.clone();
    on_main(&app, move || {
        if let Some(window) = app_window.get_webview_window(TV_LABEL) {
            window.close().map_err(|err| err.to_string())?;
        }
        close_pool(&app_window, "tv")?;
        Ok(())
    })
    .map_err(|message| CommandError { message })?;
    lock_book().session = None;
    Ok(())
}

#[tauri::command]
pub fn cast_status(app: tauri::AppHandle) -> Option<CastSession> {
    let mut book = lock_book();
    if let Some(session) = book.session.clone() {
        let alive = if session.split.is_empty() {
            app.get_webview_window(TV_LABEL).is_some()
        } else {
            pool_open(&app, "tv")
        };
        if !alive {
            book.session = None;
        }
    }
    book.session.clone()
}

#[tauri::command]
pub async fn span_show(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    args: SpanRequest,
) -> Result<(), CommandError> {
    let screens = collect_screens(&window)?;
    let picked = span_plan(&screens, &args.screen_ids, args.require_sharp)
        .map_err(|message| CommandError { message })?;
    let owned: Vec<CastScreen> = picked.into_iter().cloned().collect();
    open_wall(&app, owned, "span", "index.html?view=span&screen=")
}

#[tauri::command]
pub async fn span_hide(app: tauri::AppHandle) -> Result<(), CommandError> {
    let app_window = app.clone();
    on_main(&app, move || close_pool(&app_window, "span"))
        .map_err(|message| CommandError { message })
}

#[tauri::command]
pub async fn cast_split(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    args: SpanRequest,
) -> Result<CastSession, CommandError> {
    let screens = collect_screens(&window)?;
    let picked =
        span_plan(&screens, &args.screen_ids, true).map_err(|message| CommandError { message })?;
    let owned: Vec<CastScreen> = picked.into_iter().cloned().collect();
    let session = split_session(&owned);
    let app_window = app.clone();
    let placed = owned;
    on_main(&app, move || {
        if let Some(existing) = app_window.get_webview_window(TV_LABEL) {
            existing.close().map_err(|err| err.to_string())?;
        }
        close_pool(&app_window, "tv")?;
        open_labeled(&app_window, &placed, "tv", "index.html?view=tv&screen=")
    })
    .map_err(|message| CommandError { message })?;
    Ok(remember(session))
}

fn open_wall(
    app: &tauri::AppHandle,
    screens: Vec<CastScreen>,
    prefix: &str,
    url_prefix: &str,
) -> Result<(), CommandError> {
    let prefix = prefix.to_string();
    let url_prefix = url_prefix.to_string();
    let app_window = app.clone();
    on_main(app, move || {
        close_pool(&app_window, &prefix)?;
        open_labeled(&app_window, &screens, &prefix, &url_prefix)
    })
    .map_err(|message| CommandError { message })
}

fn open_labeled(
    app: &tauri::AppHandle,
    screens: &[CastScreen],
    prefix: &str,
    url_prefix: &str,
) -> Result<(), String> {
    for (index, screen) in screens.iter().enumerate() {
        let label = format!("{prefix}-{}", index + 1);
        let url = format!("{url_prefix}{}", encode_query(&screen.id));
        open_board_window(app, &label, &url, Some(screen), true)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn cast_preview(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), CommandError> {
    let screens = collect_screens(&window).unwrap_or_default();
    let current = screens
        .iter()
        .find(|screen| screen.current)
        .or(screens.first())
        .cloned();
    let app_window = app.clone();
    on_main(&app, move || {
        open_board_window(
            &app_window,
            PREVIEW_LABEL,
            "index.html?view=tv&preview=1",
            current.as_ref(),
            false,
        )
    })
    .map_err(|message| CommandError { message })
}

#[tauri::command]
pub async fn cast_close_preview(app: tauri::AppHandle) -> Result<(), CommandError> {
    let app_window = app.clone();
    on_main(&app, move || {
        if let Some(window) = app_window.get_webview_window(PREVIEW_LABEL) {
            window.close().map_err(|err| err.to_string())?;
        }
        Ok(())
    })
    .map_err(|message| CommandError { message })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(id: &str, name: &str, width: u32, height: u32, current: bool) -> CastScreen {
        CastScreen {
            id: id.into(),
            name: name.into(),
            width,
            height,
            scale: 1.0,
            x: 0,
            y: 0,
            current,
            sharp: is_sharp(width, height),
        }
    }

    fn receiver(name: &str, model: &str, audio_only: bool) -> AirPlayReceiver {
        let known = known_apple_tv(model);
        AirPlayReceiver {
            id: format!("id-{name}"),
            name: name.into(),
            host: "192.168.1.40".into(),
            port: 7000,
            model: model.into(),
            model_label: known.map(|item| item.label.to_string()).unwrap_or_default(),
            features: String::new(),
            video: !audio_only,
            screen: !audio_only,
            audio_only,
            asks_for_pin: false,
            width: known.map(|item| item.width),
            height: known.map(|item| item.height),
            sharp: known.map(|item| is_sharp(item.width, item.height)),
        }
    }

    #[test]
    fn four_k_is_the_floor_for_a_large_television() {
        assert!(is_sharp(3840, 2160));
        assert!(is_sharp(4096, 2160));
        assert!(is_sharp(7680, 4320));
        assert!(!is_sharp(3839, 2160));
        assert!(!is_sharp(3840, 2159));
        assert!(!is_sharp(1920, 1080));
        assert!(!is_sharp(1280, 720));
    }

    #[test]
    fn scaling_does_not_hide_a_four_k_panel() {
        assert_eq!(physical_pixels(2560.0, 1440.0, 1.5), (3840, 2160));
        assert_eq!(physical_pixels(1920.0, 1080.0, 2.0), (3840, 2160));
        assert_eq!(physical_pixels(960.0, 540.0, 2.0), (1920, 1080));
        assert_eq!(physical_pixels(3840.0, 2160.0, 1.5), (3840, 2160));
        assert_eq!(physical_pixels(1920.0, 1080.0, 1.0), (1920, 1080));
    }

    #[test]
    fn television_row_height_fills_the_screen() {
        assert_eq!(tv_row_height(12, 32, 2160), 63);
        assert_eq!(tv_row_height(12, 1, 2160), 160);
        assert_eq!(tv_row_height(12, 40, 400), 8);
        assert_eq!(tv_row_height_scaled(12, 32, 2160, 1.0), 63);
    }

    #[test]
    fn denser_grid_leaves_room_on_a_four_k_television() {
        let standard = tv_row_height(12, 66, 2160);
        let dense = tv_row_height_scaled(12, 66, 2160, 0.5);
        assert!(dense < standard);
        assert!(dense <= 16);
        let rows = 22 * 6;
        let cell = tv_row_height_scaled(12, rows, 2160, 0.5);
        let margin = 2;
        let padding = 4;
        let chrome = padding * 2 + margin * (rows - 1);
        assert!(rows * cell + chrome <= 2160);
    }

    #[test]
    fn larger_grid_stays_readable_on_television() {
        assert!(tv_row_height_scaled(12, 32, 2160, 1.35) >= tv_row_height(12, 32, 2160));
        assert_eq!(tv_row_height_scaled(12, 1, 2160, 1.35), 200);
    }

    #[test]
    fn feature_bits_separate_televisions_from_speakers() {
        let tv = parse_features("0x5A7FFFF7,0x1E");
        assert!(tv.parsed && tv.video && tv.screen);
        assert_eq!(parse_features("1518338039"), tv);
        let speaker = parse_features("0x200");
        assert!(speaker.parsed && !speaker.video && !speaker.screen);
        assert!(!parse_features("").parsed);
        assert!(!parse_features("not-a-number").parsed);
    }

    #[test]
    fn apple_tv_models_below_four_k_are_soft() {
        assert!(!is_sharp(
            known_apple_tv("AppleTV5,3").unwrap().width,
            known_apple_tv("AppleTV5,3").unwrap().height
        ));
        assert_eq!(known_apple_tv("AppleTV5,3").unwrap().label, "Apple TV HD");
        assert!(is_sharp(
            known_apple_tv("AppleTV6,2").unwrap().width,
            known_apple_tv("AppleTV6,2").unwrap().height
        ));
        assert!(is_sharp(
            known_apple_tv("AppleTV11,1").unwrap().width,
            known_apple_tv("AppleTV11,1").unwrap().height
        ));
        assert!(is_sharp(
            known_apple_tv("AppleTV14,1").unwrap().width,
            known_apple_tv("AppleTV14,1").unwrap().height
        ));
        assert!(known_apple_tv("AppleTV3,2").is_some());
        assert!(known_apple_tv("AppleTV99,1").is_none());
    }

    #[test]
    fn stream_xml_reports_the_receiver_picture() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>height</key>
  <integer>720</integer>
  <key>width</key>
  <integer>1280</integer>
</dict></plist>"#;
        assert_eq!(parse_stream_xml(xml), Some((1280, 720)));
        assert_eq!(
            parse_stream_xml(
                "<key>width</key>\n  <real>3840</real><key>height</key><real>2160</real>"
            ),
            Some((3840, 2160))
        );
        assert_eq!(parse_stream_xml("<plist></plist>"), None);
    }

    #[test]
    fn names_match_a_receiver_to_its_display() {
        assert!(names_match("Living Room", "Living Room TV"));
        assert!(names_match("Den Apple TV", "Den"));
        assert!(names_match("SAMSUNG", "Samsung"));
        assert!(!names_match("TV", "Living Room TV"));
        assert!(!names_match("Living Room", "HDMI-1"));
    }

    #[test]
    fn screen_mirroring_refuses_the_computer_and_a_soft_picture() {
        let computer = screen("computer", "Built-in", 3840, 2160, true);
        assert!(mirror_block_reason(&computer)
            .unwrap()
            .contains("Setup stays here"));
        let soft = screen("hdmi", "Samsung", 1920, 1080, false);
        let reason = mirror_block_reason(&soft).unwrap();
        assert!(reason.contains("1920 × 1080"));
        assert!(reason.contains("58-inch"));
        let tv = screen("hdmi", "Samsung", 3840, 2160, false);
        assert!(mirror_block_reason(&tv).is_none());
    }

    #[test]
    fn airplay_uses_a_matching_four_k_display_and_refuses_the_rest() {
        let screens = vec![
            screen("computer", "Built-in", 3840, 2160, true),
            screen("hdmi", "Living Room", 3840, 2160, false),
            screen("soft", "Bedroom", 1920, 1080, false),
        ];
        let sharp = receiver("Living Room", "AppleTV6,2", false);
        let target = airplay_target(&sharp, &screens, None).unwrap();
        assert_eq!(target.id, "hdmi");

        let hd = receiver("Living Room", "AppleTV5,3", false);
        let reason = airplay_target(&hd, &screens, None).unwrap_err();
        assert!(reason.contains("Apple TV HD"));
        assert!(reason.contains("1920 × 1080"));

        let speaker = receiver("Kitchen", "", true);
        assert!(airplay_target(&speaker, &screens, None)
            .unwrap_err()
            .contains("audio"));

        let loose = receiver("Patio", "", false);
        let reason = airplay_target(&loose, &screens, Some((1920, 1080))).unwrap_err();
        assert!(reason.contains("1920 × 1080"));

        let waiting = receiver("Patio", "AppleTV11,1", false);
        let reason = airplay_target(&waiting, &screens, Some((3840, 2160))).unwrap_err();
        assert!(reason.contains("not connected as a display"));
        assert!(reason.contains("3840 × 2160"));

        let on_computer = receiver("Built-in", "AppleTV14,1", false);
        assert!(airplay_target(&on_computer, &screens, None)
            .unwrap_err()
            .contains("Setup stays here"));

        let soft_named = vec![screen("bed", "Bedroom", 1920, 1080, false)];
        let bedroom = receiver("Bedroom", "AppleTV6,2", false);
        assert!(airplay_target(&bedroom, &soft_named, None)
            .unwrap_err()
            .contains("below 3840 × 2160"));
    }

    #[test]
    fn instance_names_come_from_the_airplay_service_name() {
        assert_eq!(
            instance_name("Living Room._airplay._tcp.local."),
            "Living Room"
        );
        assert_eq!(instance_name("Den\\032TV._airplay._tcp.local."), "Den TV");
    }

    fn screen_at(
        id: &str,
        name: &str,
        width: u32,
        height: u32,
        current: bool,
        x: i32,
        y: i32,
    ) -> CastScreen {
        CastScreen {
            id: id.into(),
            name: name.into(),
            width,
            height,
            scale: 1.0,
            x,
            y,
            current,
            sharp: is_sharp(width, height),
        }
    }

    #[test]
    fn a_display_wall_skips_the_computer_and_keeps_a_smaller_monitor() {
        let screens = vec![
            screen_at("computer", "Built-in", 1920, 1080, true, 0, 0),
            screen_at("desk", "Dell", 1920, 1080, false, 1920, 0),
            screen_at("tv", "Samsung", 3840, 2160, false, 0, 1080),
        ];
        let picked = span_plan(
            &screens,
            &["computer".into(), "tv".into(), "desk".into()],
            false,
        )
        .unwrap();
        assert_eq!(
            picked
                .iter()
                .map(|screen| screen.id.as_str())
                .collect::<Vec<_>>(),
            vec!["desk", "tv"]
        );
    }

    #[test]
    fn a_television_wall_refuses_the_computer_and_a_soft_picture() {
        let screens = vec![
            screen_at("computer", "Built-in", 3840, 2160, true, 0, 0),
            screen_at("soft", "Samsung", 1920, 1080, false, 1920, 0),
            screen_at("left", "LG", 3840, 2160, false, 0, 0),
            screen_at("right", "Sony", 3840, 2160, false, 3840, 0),
        ];
        let soft = span_plan(&screens, &["soft".into(), "left".into()], true).unwrap_err();
        assert!(soft.contains("1920 × 1080"));
        assert!(soft.contains("58-inch"));
        let computer = span_plan(&screens, &["computer".into(), "left".into()], true).unwrap_err();
        assert!(computer.contains("Setup stays here"));
        let one = span_plan(&screens, &["left".into(), "left".into()], true).unwrap_err();
        assert!(one.contains("two"));
        let picked = span_plan(&screens, &["right".into(), "left".into()], true).unwrap();
        assert_eq!(
            picked
                .iter()
                .map(|screen| screen.id.as_str())
                .collect::<Vec<_>>(),
            vec!["left", "right"]
        );
    }

    #[test]
    fn screen_ids_stay_intact_in_the_window_url() {
        assert_eq!(
            encode_query("Dell|1920|1080|0|0"),
            "Dell%7C1920%7C1080%7C0%7C0"
        );
        assert_eq!(encode_query("HDMI-1"), "HDMI-1");
    }
}
