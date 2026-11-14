//! Free RSS and Atom news.
//!
//! National outlets are the ones the user checked. Local outlets come from
//! the confirmed place: up to three catalog feeds inside their radius, nearest
//! first. If none cover that place, a Google News search for the place name
//! is the local feed.
//!
//! The wait is the shortest publisher hint that is at least one minute:
//! RSS `ttl`, the syndication update period, and remaining `Cache-Control`
//! max-age. A feed that states none of those waits 15 minutes. `Retry-After`
//! can only make the wait longer. Keep this in step with `pollIntervalSec`
//! in `src/lib/news.ts`.

use crate::config::SourceConfig;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const USER_AGENT: &str =
    "CommandCenter/0.1 (personal news reader; +https://github.com/nlaero/CommandCenter)";
const MIN_POLL_SECS: u64 = 60;
const DEFAULT_POLL_SECS: u64 = 15 * 60;
const LOCAL_CAP: usize = 3;
const ITEMS_PER_FEED: usize = 60;
const MAX_FEED_BYTES: u64 = 2_000_000;
const LOCATION_MSG: &str = "Find a location first. Use GPS, network location, another source on this device, or an address. Command Center has to confirm the place before this source can be saved.";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewsStory {
    pub id: String,
    pub title: String,
    pub outlet_id: String,
    pub outlet: String,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewsFeedState {
    pub id: String,
    pub name: String,
    pub scope: String,
    pub poll_after_ms: u64,
    pub from_cache: bool,
    pub not_modified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub item_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewsPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub place_label: Option<String>,
    pub stories: Vec<NewsStory>,
    pub feeds: Vec<NewsFeedState>,
    pub poll_after_ms: u64,
}

#[derive(Debug, Clone)]
pub struct FetchResult {
    pub news: NewsPayload,
    pub attribution: String,
    pub fetched_at: String,
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CatalogFile {
    national: Vec<NationalOutlet>,
    local: Vec<LocalOutlet>,
}

#[derive(Debug, Clone, Deserialize)]
struct NationalOutlet {
    id: String,
    name: String,
    url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalOutlet {
    id: String,
    name: String,
    url: String,
    lat: f64,
    lon: f64,
    radius_mi: f64,
    priority: i32,
}

#[derive(Clone)]
struct ResolvedFeed {
    id: String,
    name: String,
    url: String,
    scope: &'static str,
}

struct Place {
    lat: f64,
    lon: f64,
    label: String,
}

#[derive(Clone, Default)]
struct PollHints {
    ttl_minutes: Option<f64>,
    update_period: Option<String>,
    update_frequency: Option<f64>,
    max_age_sec: Option<u64>,
}

struct ParsedFeed {
    ttl_minutes: Option<f64>,
    update_period: Option<String>,
    update_frequency: Option<f64>,
    items: Vec<ParsedItem>,
}

struct ParsedItem {
    title: String,
    link: Option<String>,
    guid: Option<String>,
    published: Option<String>,
    summary: Option<String>,
}

struct Hit<'a> {
    attrs: &'a str,
    inner: &'a str,
    end: usize,
}

struct Loaded {
    feed: ResolvedFeed,
    items: Vec<ParsedItem>,
    poll_after: Duration,
    from_cache: bool,
    not_modified: bool,
    error: Option<String>,
}

struct CacheEntry {
    body: String,
    etag: Option<String>,
    last_modified: Option<String>,
    ready_at: Instant,
    hints: PollHints,
}

fn catalog() -> &'static CatalogFile {
    static CATALOG: OnceLock<CatalogFile> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../../src/lib/news-outlets.json"))
            .expect("news outlet catalog")
    })
}

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn with_cache<T>(f: impl FnOnce(&mut HashMap<String, CacheEntry>) -> T) -> T {
    let mut guard = cache().lock().unwrap_or_else(|err| err.into_inner());
    f(&mut guard)
}

pub fn fetch(source: &SourceConfig) -> Result<FetchResult, super::SourceError> {
    let place = confirmed_place(source)?;
    let national = selected_national(source);
    if national.is_empty() {
        return Err(super::SourceError::Message(
            "Pick at least one national outlet.".into(),
        ));
    }
    let feeds = resolve_feeds(&place, &national);
    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.error("too many redirects")
            } else if attempt.url().scheme() != "https" {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()?;

    let loaded = std::thread::scope(|scope| {
        let handles: Vec<_> = feeds
            .iter()
            .map(|feed| {
                let client = client.clone();
                scope.spawn(move || load_feed(&client, feed))
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| {
                handle.join().unwrap_or_else(|_| Loaded {
                    feed: ResolvedFeed {
                        id: "unknown".into(),
                        name: "Feed".into(),
                        url: String::new(),
                        scope: "national",
                    },
                    items: Vec::new(),
                    poll_after: Duration::from_secs(DEFAULT_POLL_SECS),
                    from_cache: false,
                    not_modified: false,
                    error: Some("the feed did not respond".into()),
                })
            })
            .collect::<Vec<_>>()
    });

    let limit = story_limit(source);
    let stories = merge_stories(&loaded, limit);
    let feed_states: Vec<NewsFeedState> = loaded
        .iter()
        .map(|row| NewsFeedState {
            id: row.feed.id.clone(),
            name: row.feed.name.clone(),
            scope: row.feed.scope.to_string(),
            poll_after_ms: row.poll_after.as_millis().max(1000) as u64,
            from_cache: row.from_cache,
            not_modified: row.not_modified,
            error: row.error.clone(),
            item_count: row.items.len() as u32,
        })
        .collect();
    let soonest = feed_states
        .iter()
        .map(|feed| feed.poll_after_ms)
        .min()
        .unwrap_or(DEFAULT_POLL_SECS * 1000);
    let attribution = loaded
        .iter()
        .map(|row| row.feed.name.as_str())
        .collect::<Vec<_>>()
        .join(" · ");
    let note = news_note(&feed_states);
    Ok(FetchResult {
        news: NewsPayload {
            place_label: Some(place.label),
            stories,
            feeds: feed_states,
            poll_after_ms: soonest.max(1000),
        },
        attribution,
        fetched_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        note: Some(note),
    })
}

fn load_feed(client: &reqwest::blocking::Client, feed: &ResolvedFeed) -> Loaded {
    if !is_allowed_news_url(&feed.url) {
        return errored(feed, "that feed is not polled", None);
    }
    if let Some((body, remaining)) = fresh_body(&feed.url) {
        let parsed = parse_news_xml(&body);
        return Loaded {
            feed: feed.clone(),
            items: parsed.items,
            poll_after: remaining,
            from_cache: true,
            not_modified: false,
            error: None,
        };
    }

    let (etag, last_modified) = with_cache(|cache| {
        cache
            .get(&feed.url)
            .map(|entry| (entry.etag.clone(), entry.last_modified.clone()))
            .unwrap_or((None, None))
    });

    let mut request = client.get(&feed.url).header(
        "accept",
        "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
    );
    if let Some(value) = &etag {
        request = request.header("if-none-match", value);
    }
    if let Some(value) = &last_modified {
        request = request.header("if-modified-since", value);
    }

    let response = match request.send() {
        Ok(response) => response,
        Err(_) => return errored(feed, "the feed did not respond", None),
    };
    let status = response.status();
    let retry = retry_after_secs(response.headers().get("retry-after").and_then(|v| v.to_str().ok()));
    let cache_header = header_string(&response, "cache-control");
    let age_header = header_string(&response, "age");
    let etag_now = header_string(&response, "etag");
    let modified_now = header_string(&response, "last-modified");

    if status == reqwest::StatusCode::NOT_MODIFIED {
        let cached_body = with_cache(|cache| cache.get(&feed.url).map(|entry| entry.body.clone()));
        let Some(body) = cached_body else {
            return errored(
                feed,
                "the feed did not change and there is no saved copy",
                retry,
            );
        };
        let parsed = parse_news_xml(&body);
        let hints = hints_from(cache_header.as_deref(), age_header.as_deref(), &parsed);
        let wait = Duration::from_secs(next_poll_secs(&hints, retry));
        with_cache(|cache| {
            if let Some(entry) = cache.get_mut(&feed.url) {
                entry.ready_at = Instant::now() + wait;
                entry.hints = hints;
                if etag_now.is_some() {
                    entry.etag = etag_now;
                }
                if modified_now.is_some() {
                    entry.last_modified = modified_now;
                }
            }
        });
        return Loaded {
            feed: feed.clone(),
            items: parsed.items,
            poll_after: wait,
            from_cache: false,
            not_modified: true,
            error: None,
        };
    }

    if !status.is_success() {
        return errored(feed, &format!("HTTP {}", status.as_u16()), retry);
    }

    let mut buf = Vec::new();
    if response.take(MAX_FEED_BYTES).read_to_end(&mut buf).is_err() {
        return errored(feed, "the feed did not respond", retry);
    }
    let mut xml = String::from_utf8_lossy(&buf).into_owned();
    if buf.len() as u64 >= MAX_FEED_BYTES {
        xml = trim_partial(xml);
    }
    if !looks_like_feed(&xml) {
        return errored(feed, "did not return a feed", retry);
    }
    let parsed = parse_news_xml(&xml);
    let hints = hints_from(cache_header.as_deref(), age_header.as_deref(), &parsed);
    let wait = Duration::from_secs(next_poll_secs(&hints, retry));
    with_cache(|cache| {
        cache.insert(
            feed.url.clone(),
            CacheEntry {
                body: xml,
                etag: etag_now,
                last_modified: modified_now,
                ready_at: Instant::now() + wait,
                hints,
            },
        );
    });
    Loaded {
        feed: feed.clone(),
        items: parsed.items,
        poll_after: wait,
        from_cache: false,
        not_modified: false,
        error: None,
    }
}

fn errored(feed: &ResolvedFeed, message: &str, retry: Option<u64>) -> Loaded {
    let previous = with_cache(|cache| cache.get(&feed.url).map(|entry| entry.body.clone()));
    let items = previous
        .as_ref()
        .map(|body| parse_news_xml(body).items)
        .unwrap_or_default();
    let hints = with_cache(|cache| {
        cache
            .get(&feed.url)
            .map(|entry| entry.hints.clone())
            .unwrap_or_default()
    });
    let wait = Duration::from_secs(next_poll_secs(&hints, retry));
    with_cache(|cache| {
        if let Some(entry) = cache.get_mut(&feed.url) {
            entry.ready_at = Instant::now() + wait;
        }
    });
    Loaded {
        feed: feed.clone(),
        items,
        poll_after: wait,
        from_cache: previous.is_some(),
        not_modified: false,
        error: Some(message.to_string()),
    }
}

fn fresh_body(url: &str) -> Option<(String, Duration)> {
    with_cache(|cache| {
        let entry = cache.get(url)?;
        let remaining = entry.ready_at.checked_duration_since(Instant::now())?;
        if remaining.is_zero() {
            return None;
        }
        Some((entry.body.clone(), remaining))
    })
}

fn hints_from(cache_control: Option<&str>, age: Option<&str>, parsed: &ParsedFeed) -> PollHints {
    PollHints {
        ttl_minutes: parsed.ttl_minutes,
        update_period: parsed.update_period.clone(),
        update_frequency: parsed.update_frequency,
        max_age_sec: remaining_max_age(cache_control_max_age(cache_control), age_seconds(age)),
    }
}

fn header_string(response: &reqwest::blocking::Response, name: &str) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn looks_like_feed(xml: &str) -> bool {
    let head = xml.chars().take(2000).collect::<String>().to_ascii_lowercase();
    head.contains("<rss") || head.contains("<feed") || head.contains("<rdf")
}

fn trim_partial(xml: String) -> String {
    let lower = xml.to_ascii_lowercase();
    let item = lower.rfind("</item>");
    let entry = lower.rfind("</entry>");
    match (item, entry) {
        (Some(item_at), Some(entry_at)) if item_at > entry_at => xml[..item_at + "</item>".len()].to_string(),
        (Some(item_at), None) => xml[..item_at + "</item>".len()].to_string(),
        (_, Some(entry_at)) => xml[..entry_at + "</entry>".len()].to_string(),
        _ => xml,
    }
}

fn news_note(feeds: &[NewsFeedState]) -> String {
    let mut parts = vec!["Each feed waits for its own schedule.".to_string()];
    let failed: Vec<String> = feeds
        .iter()
        .filter_map(|feed| {
            feed.error
                .as_ref()
                .map(|error| format!("{}: {}", feed.name, error))
        })
        .collect();
    if !failed.is_empty() {
        parts.push(failed.join(" "));
    }
    if feeds.iter().any(|feed| feed.id == "google.local") {
        parts.push("Google News is a personal-reader fallback for this place.".into());
    }
    parts.join(" ")
}

fn resolve_feeds(place: &Place, national_ids: &[String]) -> Vec<ResolvedFeed> {
    let book = catalog();
    let mut feeds = Vec::new();
    for id in national_ids {
        if let Some(outlet) = book.national.iter().find(|outlet| &outlet.id == id) {
            feeds.push(ResolvedFeed {
                id: outlet.id.clone(),
                name: outlet.name.clone(),
                url: outlet.url.clone(),
                scope: "national",
            });
        }
    }
    let local = match_local(place.lat, place.lon);
    if local.is_empty() {
        if let Some(query) = place_query(&place.label) {
            feeds.push(ResolvedFeed {
                id: "google.local".into(),
                name: format!("Local headlines · {query}"),
                url: google_news_url(&query),
                scope: "local",
            });
        }
    } else {
        for outlet in local {
            feeds.push(ResolvedFeed {
                id: outlet.id,
                name: outlet.name,
                url: outlet.url,
                scope: "local",
            });
        }
    }
    feeds
}

struct LocalHit {
    id: String,
    name: String,
    url: String,
    distance: f64,
    priority: i32,
}

fn match_local(lat: f64, lon: f64) -> Vec<LocalHit> {
    let mut hits: Vec<LocalHit> = catalog()
        .local
        .iter()
        .filter_map(|outlet| {
            let distance = miles_between(lat, lon, outlet.lat, outlet.lon);
            if distance > outlet.radius_mi {
                return None;
            }
            Some(LocalHit {
                id: outlet.id.clone(),
                name: outlet.name.clone(),
                url: outlet.url.clone(),
                distance,
                priority: outlet.priority,
            })
        })
        .collect();
    hits.sort_by(|a, b| {
        a.distance
            .partial_cmp(&b.distance)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.priority.cmp(&b.priority))
            .then(a.name.cmp(&b.name))
    });
    hits.truncate(LOCAL_CAP);
    hits
}

fn selected_national(source: &SourceConfig) -> Vec<String> {
    let Some(value) = source.params.get("outlets") else {
        return Vec::new();
    };
    let mut seen = Vec::new();
    let push = |seen: &mut Vec<String>, text: &str| {
        let trimmed = text.trim();
        if trimmed.is_empty() || seen.iter().any(|id| id == trimmed) {
            return;
        }
        if catalog().national.iter().any(|outlet| outlet.id == trimmed) {
            seen.push(trimmed.to_string());
        }
    };
    match value {
        Value::Array(items) => {
            for item in items {
                if let Some(text) = item.as_str() {
                    push(&mut seen, text);
                }
            }
        }
        Value::String(text) => {
            for part in text.split(',') {
                push(&mut seen, part);
            }
        }
        _ => {}
    }
    catalog()
        .national
        .iter()
        .filter(|outlet| seen.iter().any(|id| id == &outlet.id))
        .map(|outlet| outlet.id.clone())
        .collect()
}

fn story_limit(source: &SourceConfig) -> usize {
    let parsed = source
        .params
        .get("limit")
        .and_then(|value| match value {
            Value::Number(number) => number.as_f64(),
            Value::String(text) => text.trim().parse().ok(),
            _ => None,
        })
        .unwrap_or(40.0);
    if !parsed.is_finite() {
        return 40;
    }
    (parsed.round() as i64).clamp(1, 100) as usize
}

fn confirmed_place(source: &SourceConfig) -> Result<Place, super::SourceError> {
    if let Some(obj) = source.params.get("location").and_then(|value| value.as_object()) {
        if obj.get("confirmed").and_then(|value| value.as_bool()) == Some(true) {
            if let (Some(lat), Some(lon)) = (json_f64(obj.get("lat")), json_f64(obj.get("lon"))) {
                if in_range(lat, lon) {
                    let label = obj
                        .get("label")
                        .and_then(|value| value.as_str())
                        .map(str::trim)
                        .filter(|text| !text.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("{lat:.5}, {lon:.5}"));
                    return Ok(Place { lat, lon, label });
                }
            }
        }
    }
    if let (Some(lat), Some(lon)) = (
        json_f64(source.params.get("lat")),
        json_f64(source.params.get("lon")),
    ) {
        if in_range(lat, lon) {
            return Ok(Place {
                lat,
                lon,
                label: format!("{lat:.5}, {lon:.5}"),
            });
        }
    }
    Err(super::SourceError::Message(LOCATION_MSG.into()))
}

fn json_f64(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn in_range(lat: f64, lon: f64) -> bool {
    (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon)
}

fn place_query(label: &str) -> Option<String> {
    let mut parts: Vec<String> = label
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .filter(|part| !is_country(part))
        .map(str::to_string)
        .collect();
    while parts.len() > 1 && parts[0].chars().any(|ch| ch.is_ascii_digit()) {
        parts.remove(0);
    }
    if parts.is_empty() || !parts.iter().any(|part| part.chars().any(|ch| ch.is_ascii_alphabetic()))
    {
        return None;
    }
    let state_index = parts.iter().rposition(|part| is_state(part));
    if let Some(index) = state_index {
        if index > 0 {
            let city = parts[..index]
                .iter()
                .find(|part| !is_county(part))
                .cloned()
                .unwrap_or_else(|| parts[0].clone());
            return Some(format!("{city}, {}", parts[index]));
        }
    }
    Some(parts.into_iter().take(2).collect::<Vec<_>>().join(", "))
}

fn is_country(part: &str) -> bool {
    matches!(
        part.trim().to_ascii_lowercase().as_str(),
        "united states" | "united states of america" | "usa" | "u.s." | "u.s.a." | "us"
    )
}

fn is_state(part: &str) -> bool {
    let key = part.trim().to_ascii_lowercase();
    const NAMES: &[&str] = &[
        "alabama",
        "alaska",
        "arizona",
        "arkansas",
        "california",
        "colorado",
        "connecticut",
        "delaware",
        "district of columbia",
        "florida",
        "georgia",
        "hawaii",
        "idaho",
        "illinois",
        "indiana",
        "iowa",
        "kansas",
        "kentucky",
        "louisiana",
        "maine",
        "maryland",
        "massachusetts",
        "michigan",
        "minnesota",
        "mississippi",
        "missouri",
        "montana",
        "nebraska",
        "nevada",
        "new hampshire",
        "new jersey",
        "new mexico",
        "new york",
        "north carolina",
        "north dakota",
        "ohio",
        "oklahoma",
        "oregon",
        "pennsylvania",
        "rhode island",
        "south carolina",
        "south dakota",
        "tennessee",
        "texas",
        "utah",
        "vermont",
        "virginia",
        "washington",
        "west virginia",
        "wisconsin",
        "wyoming",
    ];
    if NAMES.contains(&key.as_str()) {
        return true;
    }
    key.len() == 2
        && matches!(
            key.as_str(),
            "al" | "ak"
                | "az"
                | "ar"
                | "ca"
                | "co"
                | "ct"
                | "de"
                | "dc"
                | "fl"
                | "ga"
                | "hi"
                | "id"
                | "il"
                | "in"
                | "ia"
                | "ks"
                | "ky"
                | "la"
                | "me"
                | "md"
                | "ma"
                | "mi"
                | "mn"
                | "ms"
                | "mo"
                | "mt"
                | "ne"
                | "nv"
                | "nh"
                | "nj"
                | "nm"
                | "ny"
                | "nc"
                | "nd"
                | "oh"
                | "ok"
                | "or"
                | "pa"
                | "ri"
                | "sc"
                | "sd"
                | "tn"
                | "tx"
                | "ut"
                | "vt"
                | "va"
                | "wa"
                | "wv"
                | "wi"
                | "wy"
        )
}

fn is_county(part: &str) -> bool {
    matches!(
        part.split_whitespace()
            .last()
            .map(|word| word.to_ascii_lowercase())
            .as_deref(),
        Some("county" | "parish" | "borough")
    )
}

fn google_news_url(query: &str) -> String {
    format!(
        "https://news.google.com/rss/search?q={}&hl={}&gl={}&ceid={}",
        encode_query(query),
        encode_query("en-US"),
        encode_query("US"),
        encode_query("US:en"),
    )
}

fn encode_query(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn is_allowed_news_url(url: &str) -> bool {
    if catalog().national.iter().any(|outlet| outlet.url == url)
        || catalog().local.iter().any(|outlet| outlet.url == url)
    {
        return true;
    }
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    parsed.scheme() == "https"
        && parsed.host_str() == Some("news.google.com")
        && parsed.path() == "/rss/search"
        && parsed
            .query_pairs()
            .any(|(key, value)| key == "q" && !value.trim().is_empty())
}

fn miles_between(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let radius = 3958.7613;
    let p = std::f64::consts::PI / 180.0;
    let d_lat = (lat2 - lat1) * p;
    let d_lon = (lon2 - lon1) * p;
    let a = (d_lat / 2.0).sin().powi(2)
        + (lat1 * p).cos() * (lat2 * p).cos() * (d_lon / 2.0).sin().powi(2);
    2.0 * radius * a.sqrt().clamp(0.0, 1.0).asin()
}

fn poll_interval_secs(hints: &PollHints) -> u64 {
    let mut limits = Vec::new();
    if let Some(ttl) = hints.ttl_minutes {
        if ttl > 0.0 {
            limits.push((ttl * 60.0).round() as u64);
        }
    }
    if let Some(seconds) = syndication_secs(hints.update_period.as_deref(), hints.update_frequency)
    {
        if seconds > 0 {
            limits.push(seconds);
        }
    }
    if let Some(max_age) = hints.max_age_sec {
        if max_age > 0 {
            limits.push(max_age);
        }
    }
    let usable: Vec<u64> = limits.iter().copied().filter(|value| *value >= MIN_POLL_SECS).collect();
    if let Some(min) = usable.iter().copied().min() {
        return min;
    }
    if !limits.is_empty() {
        return MIN_POLL_SECS;
    }
    DEFAULT_POLL_SECS
}

fn next_poll_secs(hints: &PollHints, retry_after: Option<u64>) -> u64 {
    let base = poll_interval_secs(hints);
    retry_after.map(|retry| base.max(retry)).unwrap_or(base)
}

fn syndication_secs(period: Option<&str>, frequency: Option<f64>) -> Option<u64> {
    let base = match period?.trim().to_ascii_lowercase().as_str() {
        "hourly" => 3600,
        "daily" => 86_400,
        "weekly" => 7 * 86_400,
        "monthly" => 30 * 86_400,
        "yearly" => 365 * 86_400,
        _ => return None,
    };
    let times = frequency.filter(|value| *value > 0.0).unwrap_or(1.0);
    Some((base as f64 / times).round() as u64)
}

fn cache_control_max_age(header: Option<&str>) -> Option<u64> {
    let header = header?;
    for part in header.split(',') {
        let part = part.trim();
        if part.len() >= 8 && part[..8].eq_ignore_ascii_case("max-age=") {
            if let Ok(secs) = part[8..].trim().parse::<u64>() {
                return Some(secs);
            }
        }
    }
    None
}

fn remaining_max_age(max_age: Option<u64>, age: u64) -> Option<u64> {
    let max_age = max_age.filter(|value| *value > 0)?;
    let remaining = max_age.saturating_sub(age.min(max_age));
    (remaining > 0).then_some(remaining)
}

fn age_seconds(header: Option<&str>) -> u64 {
    header
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(0)
}

fn retry_after_secs(header: Option<&str>) -> Option<u64> {
    let header = header?.trim();
    if header.is_empty() {
        return None;
    }
    if header.bytes().all(|byte| byte.is_ascii_digit()) {
        return header.parse().ok();
    }
    chrono::DateTime::parse_from_rfc2822(header)
        .ok()
        .map(|when| {
            let delta = when.timestamp() - chrono::Utc::now().timestamp();
            delta.max(0) as u64
        })
}

fn merge_stories(loaded: &[Loaded], limit: usize) -> Vec<NewsStory> {
    let mut stories = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in loaded {
        for item in &row.items {
            let key = item
                .guid
                .clone()
                .or_else(|| item.link.clone())
                .unwrap_or_else(|| item.title.clone());
            let id = format!("{}:{}", row.feed.id, key.trim());
            if !seen.insert(id.clone()) {
                continue;
            }
            stories.push(NewsStory {
                id,
                title: item.title.clone(),
                outlet_id: row.feed.id.clone(),
                outlet: row.feed.name.clone(),
                scope: row.feed.scope.to_string(),
                summary: clean_summary(item.summary.as_deref(), &item.title),
                url: http_url(item.link.as_deref()),
                published_at: item.published.clone(),
            });
        }
    }
    stories.sort_by(|a, b| {
        stamp(&b.published_at)
            .cmp(&stamp(&a.published_at))
            .then(a.title.cmp(&b.title))
    });
    stories.truncate(limit);
    stories
}

fn stamp(value: &Option<String>) -> i64 {
    let Some(text) = value else {
        return i64::MIN;
    };
    if let Ok(when) = chrono::DateTime::parse_from_rfc3339(text) {
        return when.timestamp();
    }
    if let Ok(when) = chrono::DateTime::parse_from_rfc2822(text) {
        return when.timestamp();
    }
    i64::MIN
}

fn clean_summary(summary: Option<&str>, title: &str) -> Option<String> {
    let text = summary?.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() || text.eq_ignore_ascii_case(title) || text.chars().count() < 24 {
        return None;
    }
    let lower = text.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return None;
    }
    if text.chars().count() <= 320 {
        return Some(text);
    }
    let cut: String = text.chars().take(320).collect();
    let trimmed = cut
        .rfind(' ')
        .filter(|index| *index > 200)
        .map(|index| cut[..index].trim())
        .unwrap_or(cut.trim());
    Some(format!("{trimmed}…"))
}

fn http_url(value: Option<&str>) -> Option<String> {
    let text = value?.trim();
    let lower = text.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        Some(text.to_string())
    } else {
        None
    }
}

fn parse_news_xml(xml: &str) -> ParsedFeed {
    let source = xml.strip_prefix('\u{feff}').unwrap_or(xml);
    let ttl = first_text(source, "ttl").and_then(|text| text.parse::<f64>().ok());
    let period = first_text(source, "updateperiod");
    let frequency = first_text(source, "updatefrequency").and_then(|text| text.parse::<f64>().ok());
    let mut nodes = elements_limited(source, "item", ITEMS_PER_FEED);
    if nodes.is_empty() {
        nodes = elements_limited(source, "entry", ITEMS_PER_FEED);
    }
    let mut items = Vec::new();
    for node in nodes {
        let Some(title) = text_of(node.inner, &["title"]) else {
            continue;
        };
        items.push(ParsedItem {
            title,
            link: link_of(node.inner),
            guid: text_of(node.inner, &["guid", "id"]),
            published: text_of(node.inner, &["pubdate", "published", "updated", "date"])
                .map(|value| normalize_time(&value)),
            summary: text_of(node.inner, &["description", "summary", "encoded", "content"]),
        });
    }
    ParsedFeed {
        ttl_minutes: ttl.filter(|value| *value > 0.0),
        update_period: period,
        update_frequency: frequency.filter(|value| *value > 0.0),
        items,
    }
}

fn normalize_time(raw: &str) -> String {
    let text = raw.trim();
    if let Ok(when) = chrono::DateTime::parse_from_rfc3339(text) {
        return when
            .with_timezone(&chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    }
    if let Ok(when) = chrono::DateTime::parse_from_rfc2822(text) {
        return when
            .with_timezone(&chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    }
    text.to_string()
}

fn first_text(xml: &str, name: &str) -> Option<String> {
    let hit = next_element(xml, 0, name)?;
    let text = inner_text(hit.inner);
    if text.is_empty() { None } else { Some(text) }
}

fn text_of(inner: &str, names: &[&str]) -> Option<String> {
    for name in names {
        let Some(hit) = next_element(inner, 0, name) else {
            continue;
        };
        let text = inner_text(hit.inner);
        if !text.is_empty() {
            return Some(text);
        }
    }
    None
}

fn link_of(inner: &str) -> Option<String> {
    let mut from = 0;
    let mut fallback = None;
    while from < inner.len() {
        let Some(hit) = next_element(inner, from, "link") else {
            break;
        };
        from = hit.end;
        let href = attr(hit.attrs, "href");
        let rel = attr(hit.attrs, "rel");
        let candidate = href.or_else(|| {
            let text = inner_text(hit.inner);
            if text.is_empty() { None } else { Some(text) }
        });
        let Some(candidate) = candidate else {
            continue;
        };
        if fallback.is_none() {
            fallback = Some(candidate.clone());
        }
        if rel.as_deref().map(|value| value.eq_ignore_ascii_case("alternate")).unwrap_or(true) {
            return Some(candidate);
        }
    }
    fallback
}

fn elements_limited<'a>(xml: &'a str, name: &str, limit: usize) -> Vec<Hit<'a>> {
    let mut out = Vec::new();
    let mut from = 0;
    while out.len() < limit && from < xml.len() {
        let Some(hit) = next_element(xml, from, name) else {
            break;
        };
        from = hit.end;
        out.push(hit);
    }
    out
}

fn next_element<'a>(xml: &'a str, from: usize, wanted: &str) -> Option<Hit<'a>> {
    let bytes = xml.as_bytes();
    let mut i = from;
    while i < bytes.len() {
        if let Some(skipped) = skip_noise(xml, i) {
            i = skipped;
            continue;
        }
        if bytes[i] != b'<' || matches!(bytes.get(i + 1), Some(b'/' | b'?' | b'!')) {
            i += 1;
            continue;
        }
        let Some((name, name_end)) = local_name_at(xml, i + 1) else {
            i += 1;
            continue;
        };
        let Some(gt) = xml[name_end..].find('>').map(|offset| name_end + offset) else {
            return None;
        };
        let self_closing = gt > 0 && bytes[gt - 1] == b'/';
        let attrs = if self_closing {
            xml[name_end..gt - 1].trim()
        } else {
            xml[name_end..gt].trim()
        };
        if name != wanted {
            i = gt + 1;
            continue;
        }
        if self_closing {
            return Some(Hit {
                attrs,
                inner: "",
                end: gt + 1,
            });
        }
        let close = find_close(xml, gt + 1, wanted)?;
        return Some(Hit {
            attrs,
            inner: &xml[gt + 1..close.0],
            end: close.1,
        });
    }
    None
}

fn find_close(xml: &str, from: usize, name: &str) -> Option<(usize, usize)> {
    let bytes = xml.as_bytes();
    let mut depth = 1;
    let mut i = from;
    while i < bytes.len() {
        if let Some(skipped) = skip_noise(xml, i) {
            i = skipped;
            continue;
        }
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        let closing = matches!(bytes.get(i + 1), Some(b'/'));
        let name_at = if closing { i + 2 } else { i + 1 };
        let Some((found, name_end)) = local_name_at(xml, name_at) else {
            i = xml[i + 1..].find('>').map(|offset| i + 1 + offset + 1).unwrap_or(bytes.len());
            continue;
        };
        if found != name {
            i = xml[i + 1..].find('>').map(|offset| i + 1 + offset + 1).unwrap_or(bytes.len());
            continue;
        }
        let Some(gt) = xml[name_end..].find('>').map(|offset| name_end + offset) else {
            return None;
        };
        if closing {
            depth -= 1;
            if depth == 0 {
                return Some((i, gt + 1));
            }
        } else if bytes[gt - 1] != b'/' {
            depth += 1;
        }
        i = gt + 1;
    }
    None
}

fn skip_noise(xml: &str, i: usize) -> Option<usize> {
    let bytes = xml.as_bytes();
    if i + 9 <= bytes.len() && bytes[i..i + 9].eq_ignore_ascii_case(b"<![CDATA[") {
        return Some(
            xml.as_bytes()[i + 9..]
                .windows(3)
                .position(|window| window.eq_ignore_ascii_case(b"]]>"))
                .map(|offset| i + 9 + offset + 3)
                .unwrap_or(bytes.len()),
        );
    }
    if xml[i..].starts_with("<!--") {
        return Some(xml[i + 4..].find("-->").map(|offset| i + 4 + offset + 3).unwrap_or(bytes.len()));
    }
    None
}

fn local_name_at(xml: &str, i: usize) -> Option<(String, usize)> {
    let bytes = xml.as_bytes();
    if i >= bytes.len() {
        return None;
    }
    let mut j = i;
    let mut colon = None;
    while j < bytes.len() {
        let byte = bytes[j];
        if byte == b':' {
            colon = Some(j);
            j += 1;
            continue;
        }
        if byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-') {
            j += 1;
            continue;
        }
        break;
    }
    if j == i {
        return None;
    }
    let start = colon.map(|index| index + 1).unwrap_or(i);
    if start >= j {
        return None;
    }
    Some((xml[start..j].to_ascii_lowercase(), j))
}

fn inner_text(inner: &str) -> String {
    let lower = inner.to_ascii_lowercase();
    if let Some(start) = lower.find("<![cdata[") {
        if let Some(end) = lower[start + 9..].find("]]>") {
            return collapse(&strip_tags(&inner[start + 9..start + 9 + end]));
        }
    }
    collapse(&strip_tags(&decode_entities(inner)))
}

fn attr(attrs: &str, key: &str) -> Option<String> {
    let lower = attrs.to_ascii_lowercase();
    let key = key.to_ascii_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find(&key) {
        let index = from + found;
        let boundary_ok = index == 0
            || lower.as_bytes()[index - 1].is_ascii_whitespace()
            || lower.as_bytes()[index - 1] == b'"';
        let after = index + key.len();
        if boundary_ok {
            let rest = attrs[after..].trim_start();
            if let Some(value) = rest.strip_prefix('=') {
                let value = value.trim_start();
                let quote = value.chars().next()?;
                if quote == '"' || quote == '\'' {
                    let raw = value[1..].split(quote).next().unwrap_or("");
                    let decoded = decode_entities(raw).trim().to_string();
                    if !decoded.is_empty() {
                        return Some(decoded);
                    }
                }
            }
        }
        from = index + key.len();
    }
    None
}

fn strip_tags(text: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in text.chars() {
        if ch == '<' {
            in_tag = true;
            out.push(' ');
            continue;
        }
        if ch == '>' && in_tag {
            in_tag = false;
            continue;
        }
        if !in_tag {
            out.push(ch);
        }
    }
    out
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn decode_entities(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        rest = &rest[start + 1..];
        let Some(end) = rest.find(';') else {
            out.push('&');
            break;
        };
        let body = &rest[..end];
        rest = &rest[end + 1..];
        if let Some(ch) = decode_one(body) {
            out.push(ch);
        } else {
            out.push('&');
            out.push_str(body);
            out.push(';');
        }
    }
    out.push_str(rest);
    out
}

fn decode_one(body: &str) -> Option<char> {
    if let Some(hex) = body.strip_prefix("#x").or_else(|| body.strip_prefix("#X")) {
        let code = u32::from_str_radix(hex, 16).ok()?;
        return char::from_u32(code).filter(|ch| *ch != '\0');
    }
    if let Some(digits) = body.strip_prefix('#') {
        let code = digits.parse::<u32>().ok()?;
        return char::from_u32(code).filter(|ch| *ch != '\0');
    }
    Some(match body.to_ascii_lowercase().as_str() {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => ' ',
        "mdash" => '—',
        "ndash" => '–',
        "hellip" => '…',
        "rsquo" => '’',
        "lsquo" => '‘',
        "rdquo" => '”',
        "ldquo" => '“',
        "middot" => '·',
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SourceConfig;
    use std::collections::BTreeMap;

    fn place_source(label: &str, lat: f64, lon: f64, outlets: &[&str]) -> SourceConfig {
        let mut params = BTreeMap::new();
        params.insert(
            "location".into(),
            serde_json::json!({
                "confirmed": true,
                "label": label,
                "lat": lat,
                "lon": lon,
            }),
        );
        params.insert(
            "outlets".into(),
            Value::Array(outlets.iter().map(|id| Value::String((*id).into())).collect()),
        );
        SourceConfig {
            type_id: "news.rss".into(),
            params,
            refresh: None,
            secrets: Vec::new(),
            enabled: true,
            draft: false,
        }
    }

    #[test]
    fn penn_hills_gets_pittsburgh_outlets_in_catalog_order() {
        let source = place_source(
            "Penn Hills, Allegheny County, Pennsylvania, United States",
            40.4759,
            -79.833,
            &["bbc", "nope", "npr", "npr"],
        );
        let place = confirmed_place(&source).unwrap();
        let ids = selected_national(&source);
        assert_eq!(ids, vec!["bbc".to_string(), "npr".to_string()]);
        let feeds = resolve_feeds(&place, &ids);
        let feed_ids: Vec<_> = feeds.iter().map(|feed| feed.id.as_str()).collect();
        assert_eq!(
            feed_ids,
            vec!["bbc", "npr", "publicsource", "trib", "wesa"]
        );
        assert!(place_query(&place.label).as_deref() == Some("Penn Hills, Pennsylvania"));
    }

    #[test]
    fn a_place_without_a_catalog_outlet_uses_google_news() {
        let source = place_source(
            "Miles City, Montana, United States",
            46.4083,
            -105.8406,
            &["npr"],
        );
        let place = confirmed_place(&source).unwrap();
        assert!(match_local(place.lat, place.lon).is_empty());
        let feeds = resolve_feeds(&place, &selected_national(&source));
        assert_eq!(feeds[1].id, "google.local");
        assert_eq!(feeds[1].name, "Local headlines · Miles City, Montana");
        assert_eq!(
            feeds[1].url,
            "https://news.google.com/rss/search?q=Miles+City%2C+Montana&hl=en-US&gl=US&ceid=US%3Aen"
        );
        assert!(is_allowed_news_url(&feeds[1].url));
        assert!(!is_allowed_news_url("https://example.com/rss"));
    }

    #[test]
    fn place_query_drops_a_street_and_coordinates() {
        assert_eq!(
            place_query("123 Main Street, Pittsburgh, Pennsylvania, United States").as_deref(),
            Some("Pittsburgh, Pennsylvania")
        );
        assert_eq!(place_query("40.44062, -79.99589"), None);
        assert_eq!(place_query("Houston").as_deref(), Some("Houston"));
    }

    #[test]
    fn poll_interval_follows_the_shortest_hint_of_at_least_a_minute() {
        assert_eq!(
            poll_interval_secs(&PollHints {
                ttl_minutes: Some(15.0),
                max_age_sec: Some(5),
                ..PollHints::default()
            }),
            15 * 60
        );
        assert_eq!(
            poll_interval_secs(&PollHints {
                max_age_sec: Some(60),
                ..PollHints::default()
            }),
            60
        );
        assert_eq!(
            poll_interval_secs(&PollHints {
                max_age_sec: Some(21),
                ..PollHints::default()
            }),
            MIN_POLL_SECS
        );
        assert_eq!(
            poll_interval_secs(&PollHints {
                ttl_minutes: Some(1.0),
                update_period: Some("hourly".into()),
                update_frequency: Some(1.0),
                ..PollHints::default()
            }),
            60
        );
        assert_eq!(
            poll_interval_secs(&PollHints {
                update_period: Some("hourly".into()),
                update_frequency: Some(1.0),
                max_age_sec: Some(3600),
                ..PollHints::default()
            }),
            3600
        );
        assert_eq!(poll_interval_secs(&PollHints::default()), DEFAULT_POLL_SECS);
        assert_eq!(remaining_max_age(Some(300), 250), Some(50));
        assert_eq!(remaining_max_age(Some(0), 0), None);
    }

    #[test]
    fn parser_reads_rss_and_atom() {
        let rss = r#"<?xml version="1.0"?>
<rss version="2.0" xmlns:sy="http://purl.org/rss/1.0/modules/syndication/">
  <channel>
    <title>Example</title>
    <ttl>15</ttl>
    <sy:updatePeriod>hourly</sy:updatePeriod>
    <sy:updateFrequency>2</sy:updateFrequency>
    <item>
      <title><![CDATA[Hello & world]]></title>
      <link>https://example.com/a</link>
      <guid>a</guid>
      <pubDate>Sat, 14 Nov 2026 00:12:43 -0500</pubDate>
      <description>&lt;p&gt;A &#8211; story about Penn Hills.&lt;/p&gt;</description>
    </item>
    <item>
      <title>AT&amp;T wins the night</title>
      <link>https://example.com/b</link>
      <pubDate>Fri, 13 Nov 2026 12:00:00 GMT</pubDate>
      <description>Short</description>
    </item>
  </channel>
</rss>"#;
        let parsed = parse_news_xml(rss);
        assert_eq!(parsed.ttl_minutes, Some(15.0));
        assert_eq!(parsed.update_period.as_deref(), Some("hourly"));
        assert_eq!(parsed.update_frequency, Some(2.0));
        assert_eq!(parsed.items.len(), 2);
        assert_eq!(parsed.items[0].title, "Hello & world");
        assert_eq!(
            parsed.items[0].summary.as_deref(),
            Some("A – story about Penn Hills.")
        );
        assert_eq!(parsed.items[0].published.as_deref(), Some("2026-11-14T05:12:43Z"));
        assert_eq!(parsed.items[1].title, "AT&T wins the night");

        let loaded = vec![Loaded {
            feed: ResolvedFeed {
                id: "npr".into(),
                name: "NPR".into(),
                url: "https://example.com".into(),
                scope: "national",
            },
            items: parsed.items,
            poll_after: Duration::from_secs(60),
            from_cache: false,
            not_modified: false,
            error: None,
        }];
        let stories = merge_stories(&loaded, 40);
        assert_eq!(stories[0].title, "Hello & world");
        assert_eq!(stories[1].summary, None);

        let atom = r#"<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom</title>
  <updated>2026-11-14T08:00:00Z</updated>
  <entry>
    <title>Atom story</title>
    <link href="https://example.com/atom" rel="alternate"/>
    <id>tag:example.com,2026:atom</id>
    <updated>2026-11-14T08:00:00Z</updated>
    <summary type="html">&lt;p&gt;Atom body with enough words to keep.&lt;/p&gt;</summary>
  </entry>
</feed>"#;
        let atom_parsed = parse_news_xml(atom);
        assert_eq!(atom_parsed.items.len(), 1);
        assert_eq!(atom_parsed.items[0].link.as_deref(), Some("https://example.com/atom"));
        assert_eq!(
            atom_parsed.items[0].summary.as_deref(),
            Some("Atom body with enough words to keep.")
        );
    }

    #[test]
    fn catalog_urls_are_https_and_ids_do_not_collide() {
        let book = catalog();
        let mut ids = std::collections::HashSet::new();
        for outlet in &book.national {
            assert!(outlet.url.starts_with("https://"), "{}", outlet.url);
            assert!(ids.insert(outlet.id.clone()), "{}", outlet.id);
        }
        for outlet in &book.local {
            assert!(outlet.url.starts_with("https://"), "{}", outlet.url);
            assert!(in_range(outlet.lat, outlet.lon));
            assert!(ids.insert(outlet.id.clone()), "{}", outlet.id);
        }
        assert!(!ids.contains("google.local"));
    }
}
