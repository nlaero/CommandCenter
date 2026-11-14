//! Regional traffic and road conditions.
//!
//! Classification stays aligned with `src/lib/traffic.ts`.

use crate::config::SourceConfig;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::f64::consts::PI;

const REGION_MILES: f64 = 80.0;
const MAX_EVENTS: usize = 120;
const MILES_PER_DEG_LAT: f64 = 69.172;

const PENNDOT_NOTE: &str = "Pennsylvania's free 511 feed needs the PennDOT username and password on this source before live incidents and winter road conditions can load.";
const OHGO_NOTE: &str = "Ohio's free OHGO feed needs an API key on this source before live incidents and travel delays can load.";

const PENNDOT_LIVE: &str = "https://gisdata.penndot.pa.gov/RCRS_Event_Data/api/RCRS/liveEvents";
const PENNDOT_WINTER: &str = "https://gisdata.penndot.pa.gov/RCRS_Event_Data/api/RCRS/winterConditions";
const OHGO_INCIDENTS: &str = "https://publicapi.ohgo.com/api/v1/incidents";
const OHGO_DELAYS: &str = "https://publicapi.ohgo.com/api/v1/travel-delays";
const CHART_EVENTS: &str =
    "https://chartexp1.sha.maryland.gov/CHARTExportClientService/getEventMapDataJSON.do";
const CHART_CLOSURES: &str =
    "https://chartexp1.sha.maryland.gov/CHARTExportClientService/getActiveClosureMapDataJSON.do";
const IOWA_EVENTS: &str = "https://services.arcgis.com/8lRhdTsQyJpO52F1/arcgis/rest/services/CARS511_Iowa_View/FeatureServer/0/query";
const IOWA_ROADS: &str = "https://services.arcgis.com/8lRhdTsQyJpO52F1/ArcGIS/rest/services/511_IA_Road_Conditions_View/FeatureServer/0/query";
const OPEN511: &str = "https://api.open511.gov.bc.ca/events";
const COMPASS: &str = "https://nec-por.ne-compass.com/NEC.XmlDataPortal/api/c2c";

#[derive(Debug, Clone, Copy)]
struct Box {
    south: f64,
    west: f64,
    north: f64,
    east: f64,
}

const PENNDOT: Box = Box { south: 39.7, west: -80.58, north: 42.32, east: -74.65 };
const OHIO: Box = Box { south: 38.35, west: -84.85, north: 42.05, east: -80.45 };
const MARYLAND: Box = Box { south: 37.88, west: -79.52, north: 39.75, east: -74.98 };
const IOWA: Box = Box { south: 40.32, west: -96.7, north: 43.55, east: -90.05 };
const BRITISH_COLUMBIA: Box = Box { south: 48.2, west: -139.15, north: 60.1, east: -114.0 };
const MAINE: Box = Box { south: 42.97, west: -71.15, north: 47.5, east: -66.85 };
const NEW_HAMPSHIRE: Box = Box { south: 42.67, west: -72.6, north: 45.35, east: -70.55 };
const VERMONT: Box = Box { south: 42.7, west: -73.48, north: 45.05, east: -71.4 };

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FeedId {
    Penndot,
    Ohgo,
    Chart,
    Iowa,
    Open511,
    Compass,
}

impl FeedId {
    fn as_str(self) -> &'static str {
        match self {
            FeedId::Penndot => "penndot",
            FeedId::Ohgo => "ohgo",
            FeedId::Chart => "chart",
            FeedId::Iowa => "iowa",
            FeedId::Open511 => "open511",
            FeedId::Compass => "compass",
        }
    }

    fn name(self) -> &'static str {
        match self {
            FeedId::Penndot => "PennDOT 511",
            FeedId::Ohgo => "OHGO",
            FeedId::Chart => "Maryland CHART",
            FeedId::Iowa => "Iowa 511",
            FeedId::Open511 => "DriveBC Open511",
            FeedId::Compass => "New England Compass",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficBounds {
    pub south: f64,
    pub west: f64,
    pub north: f64,
    pub east: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficFeedReport {
    pub id: String,
    pub name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficEvent {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub severity: String,
    pub affects_travel: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub road: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    pub lat: f64,
    pub lon: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail_url: Option<String>,
    pub feed_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficPayload {
    pub lat: f64,
    pub lon: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub radius_mi: f64,
    pub bounds: TrafficBounds,
    pub feeds: Vec<TrafficFeedReport>,
    pub events: Vec<TrafficEvent>,
    pub routine_omitted: usize,
}

pub struct FetchResult {
    pub traffic: TrafficPayload,
    pub attribution: String,
    pub fetched_at: String,
    pub note: Option<String>,
}

struct Part {
    value: Option<Value>,
    text: Option<String>,
    error: Option<String>,
}

struct Parsed {
    events: Vec<TrafficEvent>,
    routine_omitted: usize,
    unreadable: bool,
}

struct Collected {
    traffic: TrafficPayload,
    attribution: String,
    note: String,
}

pub fn fetch(
    source: &SourceConfig,
    secrets: &std::collections::BTreeMap<String, String>,
) -> Result<FetchResult, super::SourceError> {
    let (lat, lon) = crate::location::lookup_coords(&source.params, "lat", "lon").ok_or_else(|| {
        super::SourceError::Message("Confirm a location before traffic can load.".into())
    })?;
    if !in_world(lat, lon) {
        return Err(super::SourceError::Message(
            "Confirm a location before traffic can load.".into(),
        ));
    }
    let bounds = region_bounds(lat, lon);
    let needed = feeds_for(&bounds);
    let user = secret(secrets, "penndot.username");
    let pass = secret(secrets, "penndot.password");
    let ohgo = secret(secrets, "ohgo.api_key");
    let client = reqwest::blocking::Client::builder()
        .user_agent("CommandCenter/0.1 (personal traffic; +https://github.com/nlaero/CommandCenter)")
        .timeout(std::time::Duration::from_secs(25))
        .build()?;

    let mut penndot_events = None;
    let mut penndot_winter = None;
    let mut ohgo_incidents = None;
    let mut ohgo_delays = None;
    let mut chart_events = None;
    let mut chart_closures = None;
    let mut iowa_events = None;
    let mut iowa_conditions = None;
    let mut open511 = None;
    let mut compass = None;

    if needed.contains(&FeedId::Penndot) {
        if let (Some(user), Some(pass)) = (user.as_deref(), pass.as_deref()) {
            penndot_events = Some(get_json(&client, PENNDOT_LIVE, Auth::Basic { user, pass }));
            penndot_winter = Some(get_json(&client, PENNDOT_WINTER, Auth::Basic { user, pass }));
        }
    }
    if needed.contains(&FeedId::Ohgo) {
        if let Some(key) = ohgo.as_deref() {
            ohgo_incidents = Some(get_json(&client, OHGO_INCIDENTS, Auth::Ohgo(key)));
            ohgo_delays = Some(get_json(&client, OHGO_DELAYS, Auth::Ohgo(key)));
        }
    }
    if needed.contains(&FeedId::Chart) {
        chart_events = Some(get_json(&client, CHART_EVENTS, Auth::None));
        chart_closures = Some(get_json(&client, CHART_CLOSURES, Auth::None));
    }
    if needed.contains(&FeedId::Iowa) {
        iowa_events = Some(get_json(&client, &iowa_url(IOWA_EVENTS, &bounds), Auth::None));
        iowa_conditions = Some(get_json(&client, &iowa_url(IOWA_ROADS, &bounds), Auth::None));
    }
    if needed.contains(&FeedId::Open511) {
        let url = format!(
            "{OPEN511}?status=ACTIVE&limit=500&bbox={},{},{},{}",
            bounds.west, bounds.south, bounds.east, bounds.north
        );
        open511 = Some(get_json(&client, &url, Auth::None));
    }
    if needed.contains(&FeedId::Compass) {
        let mut chunks = Vec::new();
        let mut error = None;
        for network in compass_networks(&bounds) {
            let url = format!("{COMPASS}?networks={network}&dataTypes=incidentData");
            match get_text(&client, &url) {
                Ok(text) => chunks.push(text),
                Err(err) => error = Some(err),
            }
        }
        compass = Some(if chunks.is_empty() {
            Err(error.unwrap_or_else(|| "did not respond.".into()))
        } else {
            Ok(chunks.join("\n"))
        });
    }

    let collected = collect_traffic(CollectArgs {
        lat,
        lon,
        label: place_label(&source.params),
        penndot: user.is_some() && pass.is_some(),
        ohgo: ohgo.is_some(),
        penndot_events: penndot_events.as_ref(),
        penndot_winter: penndot_winter.as_ref(),
        ohgo_incidents: ohgo_incidents.as_ref(),
        ohgo_delays: ohgo_delays.as_ref(),
        chart_events: chart_events.as_ref(),
        chart_closures: chart_closures.as_ref(),
        iowa_events: iowa_events.as_ref(),
        iowa_conditions: iowa_conditions.as_ref(),
        open511: open511.as_ref(),
        compass: compass.as_ref(),
    });
    Ok(FetchResult {
        traffic: collected.traffic,
        attribution: collected.attribution,
        fetched_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        note: Some(collected.note),
    })
}

struct CollectArgs<'a> {
    lat: f64,
    lon: f64,
    label: Option<String>,
    penndot: bool,
    ohgo: bool,
    penndot_events: Option<&'a Result<Value, String>>,
    penndot_winter: Option<&'a Result<Value, String>>,
    ohgo_incidents: Option<&'a Result<Value, String>>,
    ohgo_delays: Option<&'a Result<Value, String>>,
    chart_events: Option<&'a Result<Value, String>>,
    chart_closures: Option<&'a Result<Value, String>>,
    iowa_events: Option<&'a Result<Value, String>>,
    iowa_conditions: Option<&'a Result<Value, String>>,
    open511: Option<&'a Result<Value, String>>,
    compass: Option<&'a Result<String, String>>,
}

fn collect_traffic(args: CollectArgs<'_>) -> Collected {
    let bounds = region_bounds(args.lat, args.lon);
    let mut reports = Vec::new();
    let mut events = Vec::new();
    let mut routine_omitted = 0;
    let mut live_names = Vec::new();
    for id in feeds_for(&bounds) {
        if id == FeedId::Penndot && !args.penndot {
            reports.push(report(id, "needs-credentials", Some(PENNDOT_NOTE.into())));
            continue;
        }
        if id == FeedId::Ohgo && !args.ohgo {
            reports.push(report(id, "needs-credentials", Some(OHGO_NOTE.into())));
            continue;
        }
        let parts = parts_for(id, &args);
        let parsed: Vec<Parsed> = parts
            .iter()
            .filter(|part| part.value.is_some() || part.text.is_some())
            .map(|part| parse_feed(id, part, args.lat, args.lon))
            .collect();
        let merged = merge_feed(id.name(), &parts, parsed);
        if merged.status == "live" {
            live_names.push(id.name());
        }
        events.extend(merged.events);
        routine_omitted += merged.routine_omitted;
        reports.push(report(id, merged.status, merged.detail));
    }
    let traffic = TrafficPayload {
        lat: args.lat,
        lon: args.lon,
        label: args.label.and_then(|label| {
            let trimmed = label.trim();
            if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
        }),
        radius_mi: REGION_MILES,
        bounds: TrafficBounds {
            south: bounds.south,
            west: bounds.west,
            north: bounds.north,
            east: bounds.east,
        },
        feeds: reports,
        events: limit_events(events),
        routine_omitted,
    };
    let note = traffic_note(&traffic);
    let mut names = live_names.into_iter().map(|name| name.to_string()).collect::<Vec<_>>();
    names.push("Esri basemap".into());
    Collected {
        traffic,
        attribution: names.join(" · "),
        note,
    }
}

fn traffic_note(traffic: &TrafficPayload) -> String {
    let mut parts = vec![format!(
        "Map shows the whole {REGION_MILES:.0}-mile region around the confirmed place."
    )];
    for feed in &traffic.feeds {
        if let Some(detail) = &feed.detail {
            if feed.status == "needs-credentials" || feed.status == "error" {
                parts.push(detail.clone());
            }
        }
    }
    if !traffic.feeds.iter().any(|feed| feed.status == "live" || feed.status == "needs-credentials") {
        parts.push("No free real-time incident feed covers this region.".into());
    }
    if traffic.routine_omitted > 0 {
        parts.push("Clear and wet road reports are left off the list.".into());
    }
    parts.join(" ")
}

struct Merged {
    status: &'static str,
    detail: Option<String>,
    events: Vec<TrafficEvent>,
    routine_omitted: usize,
}

fn merge_feed(name: &str, parts: &[Part], parsed: Vec<Parsed>) -> Merged {
    let mut events = Vec::new();
    let mut routine_omitted = 0;
    let mut unreadable = !parsed.is_empty();
    for part in parsed {
        if !part.unreadable {
            unreadable = false;
        }
        routine_omitted += part.routine_omitted;
        events.extend(part.events);
    }
    let ok_body = parts.iter().any(|part| part.value.is_some() || part.text.is_some());
    let http_error = parts.iter().find_map(|part| part.error.clone());
    if !ok_body {
        return Merged {
            status: "error",
            detail: Some(match http_error {
                Some(err) => format!("{name} {err}"),
                None => format!("{name} did not respond."),
            }),
            events: vec![],
            routine_omitted: 0,
        };
    }
    if unreadable && events.is_empty() {
        return Merged {
            status: "error",
            detail: Some(format!("{name} returned data this app could not read.")),
            events: vec![],
            routine_omitted: 0,
        };
    }
    Merged {
        status: "live",
        detail: http_error.map(|err| format!("{name} {err}")),
        events,
        routine_omitted,
    }
}

fn parts_for(id: FeedId, args: &CollectArgs<'_>) -> Vec<Part> {
    match id {
        FeedId::Penndot => json_parts(&[args.penndot_events, args.penndot_winter]),
        FeedId::Ohgo => json_parts(&[args.ohgo_incidents, args.ohgo_delays]),
        FeedId::Chart => json_parts(&[args.chart_events, args.chart_closures]),
        FeedId::Iowa => json_parts(&[args.iowa_events, args.iowa_conditions]),
        FeedId::Open511 => json_parts(&[args.open511]),
        FeedId::Compass => match args.compass {
            Some(Ok(text)) => vec![Part { value: None, text: Some(text.clone()), error: None }],
            Some(Err(err)) => vec![Part { value: None, text: None, error: Some(err.clone()) }],
            None => vec![],
        },
    }
}

fn json_parts(items: &[Option<&Result<Value, String>>]) -> Vec<Part> {
    items.iter().filter_map(|item| item.map(part_json)).collect()
}

fn part_json(result: &Result<Value, String>) -> Part {
    match result {
        Ok(value) => Part { value: Some(value.clone()), text: None, error: None },
        Err(err) => Part { value: None, text: None, error: Some(err.clone()) },
    }
}

fn parse_feed(id: FeedId, part: &Part, lat: f64, lon: f64) -> Parsed {
    match id {
        FeedId::Penndot => parse_penndot(part.value.as_ref(), lat, lon),
        FeedId::Ohgo => parse_ohgo(part.value.as_ref(), lat, lon),
        FeedId::Chart => parse_chart(part.value.as_ref(), lat, lon),
        FeedId::Iowa => parse_iowa(part.value.as_ref(), lat, lon),
        FeedId::Open511 => parse_open511(part.value.as_ref(), lat, lon),
        FeedId::Compass => parse_compass(part.text.as_deref().unwrap_or(""), lat, lon),
    }
}

fn parse_penndot(body: Option<&Value>, lat: f64, lon: f64) -> Parsed {
    let Some(body) = body else { return unreadable() };
    let Some(rows) = object_rows(body, &["Values", "values"]) else { return unreadable() };
    let mut events = Vec::new();
    let mut routine_omitted = 0;
    for row in rows {
        if field(row, &["Condition"]).is_some() || field(row, &["ConditionID"]).is_some() {
            match winter_event(row, lat, lon) {
                Winter::Routine => routine_omitted += 1,
                Winter::Event(event) => events.push(event),
                Winter::Outside => {}
            }
        } else if let Some(event) = penndot_event(row, lat, lon) {
            events.push(event);
        }
    }
    Parsed { events, routine_omitted, unreadable: false }
}

fn penndot_event(row: &Value, lat: f64, lon: f64) -> Option<TrafficEvent> {
    let reopened = field(row, &["ActualDateTimeOpened"]);
    let lane = field(row, &["LaneStatus"]).unwrap_or_default().to_ascii_lowercase();
    let kind_name = field(row, &["EventType"]).unwrap_or_default().to_ascii_lowercase();
    if reopened.is_some() || lane == "open" || kind_name == "incident cleared" {
        return None;
    }
    let from = lat_lon_pair(row.get("FromLocLatLong"));
    let to = lat_lon_pair(row.get("ToLocLatLong"));
    let point = in_circle(lat, lon, &[
        lat_lon_pair(row.get("IncidentLocLatLong")),
        from,
        to,
        midpoint(from, to),
    ])?;
    let facility = field(row, &["Facility"]);
    let description = field(row, &["Description"]);
    let id = field(row, &["EventID"]).unwrap_or_else(|| format!("{},{}", point.0, point.1));
    let travel_lane = matches!(
        lane.as_str(),
        "closed" | "lane restriction" | "ramp closure" | "ramp restriction" | "traffic disruption"
            | "speed restriction" | "vehicle restriction" | "no entry access"
    );
    let crash = ["crash", "debris", "flood", "bridge outage", "disabled", "vehicle fire", "downed", "winter weather", "damaged roadway"]
        .iter()
        .any(|needle| kind_name.contains(needle));
    if lane == "shoulder closed" {
        return Some(make_event(TrafficEvent {
            id: format!("penndot:{id}"),
            title: description.clone().or_else(|| join_words(&[Some(kind_name.clone()), Some("on".into()), facility.clone()])).unwrap_or_else(|| "Road event".into()),
            kind: "incident".into(),
            severity: "info".into(),
            affects_travel: false,
            summary: field(row, &["LaneStatus"]),
            road: facility,
            direction: field(row, &["Direction"]),
            lat: point.0,
            lon: point.1,
            updated_at: field(row, &["LastUpdate"]).or_else(|| field(row, &["DateTimeVerified"])),
            detail_url: Some("https://www.511pa.com/".into()),
            feed_name: FeedId::Penndot.name().into(),
        }));
    }
    let affects = travel_lane || crash;
    let severity = if lane == "closed" || lane == "no entry access" || kind_name == "bridge outage" {
        "alert"
    } else if affects {
        "warn"
    } else {
        "info"
    };
    let kind = if lane == "closed" || lane == "ramp closure" || kind_name == "bridge outage" {
        "closure"
    } else if kind_name.contains("roadwork") || kind_name.contains("utility work") {
        "roadwork"
    } else {
        "incident"
    };
    let summary = match (field(row, &["LaneStatus"]), field(row, &["AffectedLanes"])) {
        (Some(a), Some(b)) => Some(format!("{a} · {b}")),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    };
    Some(make_event(TrafficEvent {
        id: format!("penndot:{id}"),
        title: description.or_else(|| join_words(&[field(row, &["EventType"]), Some("on".into()), facility.clone()])).unwrap_or_else(|| "Road event".into()),
        kind: kind.into(),
        severity: severity.into(),
        affects_travel: affects,
        summary,
        road: facility,
        direction: field(row, &["Direction"]),
        lat: point.0,
        lon: point.1,
        updated_at: field(row, &["LastUpdate"]).or_else(|| field(row, &["CreateTime"])),
        detail_url: Some("https://www.511pa.com/".into()),
        feed_name: FeedId::Penndot.name().into(),
    }))
}

enum Winter {
    Routine,
    Event(TrafficEvent),
    Outside,
}

fn winter_event(row: &Value, lat: f64, lon: f64) -> Winter {
    let condition = field(row, &["Condition"]).unwrap_or_default();
    let from = lat_lon_pair(row.get("FromLocLatLong"));
    let to = lat_lon_pair(row.get("ToLocLatLong"));
    let Some(point) = in_circle(lat, lon, &[midpoint(from, to), from, to]) else {
        return Winter::Outside;
    };
    match winter_rank(&condition) {
        Rank::Routine => Winter::Routine,
        rank => Winter::Event(make_event(TrafficEvent {
            id: format!(
                "penndot-winter:{}",
                field(row, &["RoadSectionID"]).unwrap_or_else(|| format!("{},{}", point.0, point.1))
            ),
            title: format!("{condition} · {}", field(row, &["Facility"]).unwrap_or_else(|| "road".into())),
            kind: "condition".into(),
            severity: if rank == Rank::Alert { "alert" } else { "warn" }.into(),
            affects_travel: true,
            summary: Some(
                [field(row, &["CountyName"]), field(row, &["FromLoc"]), field(row, &["ToLoc"])]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" · "),
            ),
            road: field(row, &["Facility"]),
            direction: None,
            lat: point.0,
            lon: point.1,
            updated_at: field(row, &["LastUpdate"]),
            detail_url: Some("https://www.511pa.com/".into()),
            feed_name: FeedId::Penndot.name().into(),
        })),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Rank {
    Routine,
    Warn,
    Alert,
}

fn winter_rank(condition: &str) -> Rank {
    let value = condition.to_ascii_lowercase();
    if value.is_empty() || value == "clear" {
        return Rank::Routine;
    }
    if value.contains("impassable") || value.contains("icy") || value.contains("packed") {
        return Rank::Alert;
    }
    if value.contains("freezing") || value.contains("ice") || value.contains("snow") || value.contains("slush") {
        return Rank::Warn;
    }
    if value.contains("wet") {
        return Rank::Routine;
    }
    Rank::Warn
}

fn parse_ohgo(body: Option<&Value>, lat: f64, lon: f64) -> Parsed {
    let Some(body) = body else { return unreadable() };
    let Some(rows) = object_rows(body, &["Results", "results", "data"]) else { return unreadable() };
    let mut events = Vec::new();
    for row in rows {
        let event = if row.get("DelayTime").is_some() || row.get("TravelTime").is_some() {
            ohgo_delay(row, lat, lon)
        } else {
            ohgo_incident(row, lat, lon)
        };
        if let Some(event) = event {
            events.push(event);
        }
    }
    Parsed { events, routine_omitted: 0, unreadable: false }
}

fn ohgo_incident(row: &Value, lat: f64, lon: f64) -> Option<TrafficEvent> {
    let mut points = vec![lat_lon_fields(row)];
    points.extend(path_points(row.get("RoadClosureDetails")));
    let point = in_circle(lat, lon, &points)?;
    let road_status = field(row, &["RoadStatus"]).unwrap_or_default().to_ascii_lowercase();
    let category = field(row, &["Category"]).unwrap_or_default().to_ascii_lowercase();
    let description = field(row, &["Description"]);
    let closed = road_status.contains("closed") && !road_status.contains("partial");
    let partial = road_status.contains("partial") || road_status.contains("restrict");
    let blob = format!("{category} {}", description.clone().unwrap_or_default()).to_ascii_lowercase();
    let hazard = ["accident", "crash", "closure", "snow", "ice", "flood", "debris", "disabled", "fire"]
        .iter()
        .any(|needle| blob.contains(needle));
    let affects = closed || partial || hazard;
    let severity = if closed { "alert" } else if affects { "warn" } else { "info" };
    let route = field(row, &["RouteName"]).or_else(|| field(row, &["Location"]));
    Some(make_event(TrafficEvent {
        id: format!("ohgo:{}", field(row, &["Id", "ID"]).unwrap_or_else(|| format!("{},{}", point.0, point.1))),
        title: description.or_else(|| join_words(&[field(row, &["Category"]), Some("on".into()), route.clone()])).unwrap_or_else(|| "Ohio road incident".into()),
        kind: if closed { "closure" } else { "incident" }.into(),
        severity: severity.into(),
        affects_travel: affects,
        summary: match (field(row, &["Category"]), field(row, &["RoadStatus"])) {
            (Some(a), Some(b)) => Some(format!("{a} · {b}")),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        },
        road: route,
        direction: field(row, &["Direction"]),
        lat: point.0,
        lon: point.1,
        updated_at: None,
        detail_url: Some("https://ohgo.com/".into()),
        feed_name: FeedId::Ohgo.name().into(),
    }))
}

fn ohgo_delay(row: &Value, lat: f64, lon: f64) -> Option<TrafficEvent> {
    let point = in_circle(lat, lon, &[lat_lon_fields(row)])?;
    let delay = row.get("DelayTime").and_then(num_of).unwrap_or(0.0);
    let current = row.get("CurrentAvgSpeed").and_then(num_of);
    let normal = row.get("NormalAvgSpeed").and_then(num_of);
    let ratio = match (current, normal) {
        (Some(current), Some(normal)) if normal > 0.0 => current / normal,
        _ => 1.0,
    };
    let affects = delay >= 3.0 || ratio <= 0.75;
    let severity = if delay >= 10.0 || ratio <= 0.5 { "alert" } else if affects { "warn" } else { "info" };
    let route = field(row, &["RouteName"]).or_else(|| field(row, &["Location"]));
    let mut bits = Vec::new();
    if delay > 0.0 {
        bits.push(format!("{} min delay", delay.round()));
    }
    if let Some(current) = current {
        bits.push(format!("{} mph", current.round()));
    }
    if let Some(normal) = normal {
        bits.push(format!("usually {} mph", normal.round()));
    }
    Some(make_event(TrafficEvent {
        id: format!("ohgo-delay:{}", field(row, &["Id", "ID"]).unwrap_or_else(|| format!("{},{}", point.0, point.1))),
        title: field(row, &["Description"]).or_else(|| join_words(&[Some("Delay on".into()), route.clone()])).unwrap_or_else(|| "Travel delay".into()),
        kind: "delay".into(),
        severity: severity.into(),
        affects_travel: affects,
        summary: if bits.is_empty() { None } else { Some(bits.join(" · ")) },
        road: route,
        direction: field(row, &["Direction"]),
        lat: point.0,
        lon: point.1,
        updated_at: None,
        detail_url: Some("https://ohgo.com/".into()),
        feed_name: FeedId::Ohgo.name().into(),
    }))
}

fn parse_chart(body: Option<&Value>, lat: f64, lon: f64) -> Parsed {
    let Some(body) = body else { return unreadable() };
    let Some(rows) = object_rows(body, &["data", "Data"]) else { return unreadable() };
    let mut events = Vec::new();
    for row in rows {
        if row.get("closed").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        let closure = row.get("closureStartDate").is_some() || row.get("lanesClosed").is_some() || row.get("planned").is_some();
        if let Some(event) = if closure { chart_closure(row, lat, lon) } else { chart_event(row, lat, lon) } {
            events.push(event);
        }
    }
    Parsed { events, routine_omitted: 0, unreadable: false }
}

fn chart_event(row: &Value, lat: f64, lon: f64) -> Option<TrafficEvent> {
    let point = in_circle(lat, lon, &[lat_lon_fields(row)])?;
    let event_type = row.get("type").and_then(num_of);
    let impact = lane_impact(row.get("lanes"), &field(row, &["lanesStatus"]).unwrap_or_default());
    let traffic_alert = row.get("trafficAlert").and_then(|v| v.as_bool()) == Some(true);
    let incident_type = field(row, &["incidentType"]).unwrap_or_default().to_ascii_lowercase();
    if matches!(event_type, Some(249.0) | Some(254.0)) && !traffic_alert && impact == Impact::None {
        return None;
    }
    if incident_type.contains("off-road") && impact == Impact::None && !traffic_alert {
        return None;
    }
    let hazard = ["closure", "crash", "debris", "disabled", "weather", "congestion", "collision", "injury"]
        .iter()
        .any(|needle| incident_type.contains(needle));
    let affects = traffic_alert
        || impact != Impact::None
        || matches!(event_type, Some(2.0) | Some(250.0) | Some(253.0) | Some(255.0))
        || hazard;
    let severity = if impact == Impact::All || incident_type.contains("weather closure") {
        "alert"
    } else if affects {
        "warn"
    } else {
        "info"
    };
    let kind = if event_type == Some(250.0) {
        "delay"
    } else if impact == Impact::All || incident_type.contains("closure") {
        "closure"
    } else if event_type == Some(4.0) {
        "roadwork"
    } else {
        "incident"
    };
    let summary = [field(row, &["incidentType"]), field(row, &["lanesStatus"]), field(row, &["trafficAlertTextMsg"])]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ");
    Some(make_event(TrafficEvent {
        id: format!("chart:{}", field(row, &["id"]).unwrap_or_else(|| format!("{},{}", point.0, point.1))),
        title: field(row, &["description"]).or_else(|| field(row, &["name"])).unwrap_or_else(|| "Maryland road event".into()),
        kind: kind.into(),
        severity: severity.into(),
        affects_travel: affects,
        summary: if summary.is_empty() { None } else { Some(summary) },
        road: field(row, &["county"]),
        direction: field(row, &["direction"]),
        lat: point.0,
        lon: point.1,
        updated_at: epoch(row.get("lastCachedDataUpdateTime")).or_else(|| epoch(row.get("startDateTime"))),
        detail_url: Some("https://chart.maryland.gov/".into()),
        feed_name: FeedId::Chart.name().into(),
    }))
}

fn chart_closure(row: &Value, lat: f64, lon: f64) -> Option<TrafficEvent> {
    let point = in_circle(lat, lon, &[lat_lon_fields(row)])?;
    let status = field(row, &["lanesClosed"]).or_else(|| field(row, &["lanesStatus"])).unwrap_or_default();
    let impact = lane_impact(row.get("lanes"), &status);
    if impact == Impact::None {
        return None;
    }
    Some(make_event(TrafficEvent {
        id: format!("chart-closure:{}", field(row, &["id"]).unwrap_or_else(|| format!("{},{}", point.0, point.1))),
        title: field(row, &["description"]).or_else(|| field(row, &["name"])).unwrap_or_else(|| "Road closure".into()),
        kind: "closure".into(),
        severity: if impact == Impact::All { "alert" } else { "warn" }.into(),
        affects_travel: true,
        summary: field(row, &["lanesClosed"]).or_else(|| field(row, &["lanesStatus"])).or_else(|| field(row, &["reason"])),
        road: field(row, &["county"]),
        direction: field(row, &["direction"]),
        lat: point.0,
        lon: point.1,
        updated_at: epoch(row.get("lastCachedDataUpdateTime")).or_else(|| epoch(row.get("startDateTime"))),
        detail_url: Some("https://chart.maryland.gov/".into()),
        feed_name: FeedId::Chart.name().into(),
    }))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Impact {
    None,
    Ramp,
    Lane,
    All,
}

fn lane_impact(lanes: Option<&Value>, status_text: &str) -> Impact {
    let mut traffic = 0;
    let mut traffic_closed = 0;
    let mut ramp_closed = false;
    if let Some(list) = lanes.and_then(|v| v.as_array()) {
        for lane in list {
            let status = field(lane, &["laneStatus"]).unwrap_or_default().to_ascii_lowercase();
            let description = field(lane, &["laneDescription"]).unwrap_or_default().to_ascii_lowercase();
            let lane_type = format!("{} {description}", field(lane, &["laneType"]).unwrap_or_default()).to_ascii_lowercase();
            let closed = status == "closed";
            if lane_type.contains("ramp") && closed {
                ramp_closed = true;
            }
            let numbered_lane = description.starts_with('l')
                && description.chars().nth(1).is_some_and(|ch| ch.is_ascii_digit());
            let traffic_lane = (lane_type.contains("traffic") || numbered_lane)
                && !lane_type.contains("shoulder")
                && !lane_type.contains("ramp");
            if traffic_lane {
                traffic += 1;
                if closed {
                    traffic_closed += 1;
                }
            }
        }
    }
    if traffic > 0 && traffic_closed == traffic {
        return Impact::All;
    }
    if traffic_closed > 0 {
        return Impact::Lane;
    }
    if ramp_closed {
        return Impact::Ramp;
    }
    let prose = status_text.to_ascii_lowercase();
    if prose.contains("all") && prose.contains("closed") && prose.contains("traffic") {
        return Impact::All;
    }
    if prose.contains("closed") && prose.contains("traffic") && !prose.contains("shoulder only") {
        return Impact::Lane;
    }
    if prose.contains("ramp") && prose.contains("closed") {
        return Impact::Ramp;
    }
    Impact::None
}

fn parse_iowa(body: Option<&Value>, lat: f64, lon: f64) -> Parsed {
    let Some(body) = body else { return unreadable() };
    let Some(features) = features_of(body) else { return unreadable() };
    let mut events = Vec::new();
    let mut routine_omitted = 0;
    for feature in features {
        let props = feature.get("properties").unwrap_or(feature);
        if field(props, &["ROAD_CONDITION"]).is_some() || field(props, &["HL_PAVEMENT_CONDITION"]).is_some() {
            match iowa_condition(feature, props, lat, lon) {
                Winter::Routine => routine_omitted += 1,
                Winter::Event(event) => events.push(event),
                Winter::Outside => {}
            }
        } else if let Some(event) = iowa_event(feature, props, lat, lon) {
            events.push(event);
        }
    }
    Parsed { events, routine_omitted, unreadable: false }
}

fn iowa_event(feature: &Value, props: &Value, lat: f64, lon: f64) -> Option<TrafficEvent> {
    let style = field(props, &["STYLE"]).unwrap_or_default().to_ascii_lowercase();
    if style == "future_event" {
        return None;
    }
    let point = in_circle(lat, lon, &geo_points(feature.get("geometry")))?;
    let route = field(props, &["Route"]).or_else(|| field(props, &["ROUTE_NAME"]));
    let phrase = field(props, &["phrase"]).or_else(|| field(props, &["headline"]));
    let affects = matches!(style.as_str(), "closure" | "lane_closure" | "restriction" | "warning" | "roadwork");
    let severity = if style == "closure" { "alert" } else if affects { "warn" } else { "info" };
    let kind = if style == "closure" || style == "lane_closure" {
        "closure"
    } else if style == "roadwork" {
        "roadwork"
    } else {
        "incident"
    };
    let link = field(props, &["linktxt"]);
    let summary = match (&phrase, field(props, &["msg0"])) {
        (Some(a), Some(b)) => Some(format!("{a} · {b}")),
        (Some(a), None) => Some(a.clone()),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    };
    Some(make_event(TrafficEvent {
        id: format!("iowa:{}", field(props, &["ID"]).or_else(|| field(props, &["OBJECTID"])).unwrap_or_else(|| format!("{},{}", point.0, point.1))),
        title: field(props, &["headline"]).or_else(|| join_words(&[phrase.clone(), route.clone()])).unwrap_or_else(|| "Iowa road event".into()),
        kind: kind.into(),
        severity: severity.into(),
        affects_travel: affects,
        summary,
        road: route,
        direction: None,
        lat: point.0,
        lon: point.1,
        updated_at: match (field(props, &["UpdateDate"]), field(props, &["UpdateTime"])) {
            (Some(date), Some(time)) => Some(format!("{date} {time}")),
            (Some(date), None) => Some(date),
            (None, _) => field(props, &["gisupdated"]),
        },
        detail_url: link.filter(|url| url.starts_with("http://") || url.starts_with("https://")).or_else(|| Some("https://511ia.org/".into())),
        feed_name: FeedId::Iowa.name().into(),
    }))
}

fn iowa_condition(feature: &Value, props: &Value, lat: f64, lon: f64) -> Winter {
    let condition = field(props, &["ROAD_CONDITION"]).or_else(|| field(props, &["HL_PAVEMENT_CONDITION"])).unwrap_or_default();
    let primary = match (
        props.get("PRIMARY_LATITUDE").and_then(num_of),
        props.get("PRIMARY_LONGITUDE").and_then(num_of),
    ) {
        (Some(lat), Some(lon)) if in_world(lat, lon) => Some((lat, lon)),
        _ => None,
    };
    let mut points = vec![primary];
    points.extend(geo_points(feature.get("geometry")));
    let Some(point) = in_circle(lat, lon, &points) else { return Winter::Outside };
    match surface_rank(&condition) {
        Rank::Routine => Winter::Routine,
        rank => Winter::Event(make_event(TrafficEvent {
            id: format!("iowa-road:{}", field(props, &["SEGMENT_ID"]).or_else(|| field(props, &["OBJECTID"])).unwrap_or_else(|| format!("{},{}", point.0, point.1))),
            title: format!("{condition} · {}", field(props, &["ROUTE_NAME"]).or_else(|| field(props, &["NAMEID"])).unwrap_or_else(|| "road".into())),
            kind: "condition".into(),
            severity: match rank { Rank::Alert => "alert", Rank::Warn => "warn", Rank::Routine => "info" }.into(),
            affects_travel: true,
            summary: field(props, &["LONG_NAME"]),
            road: field(props, &["ROUTE_NAME"]).or_else(|| field(props, &["NAMEID"])),
            direction: None,
            lat: point.0,
            lon: point.1,
            updated_at: epoch(props.get("CARS_MSG_UPDATE_DATE")),
            detail_url: Some("https://511ia.org/".into()),
            feed_name: FeedId::Iowa.name().into(),
        })),
    }
}

fn surface_rank(condition: &str) -> Rank {
    let value = condition.to_ascii_lowercase();
    if value.is_empty() || ["seasonal", "normal", "clear", "dry", "bare", "wet", "damp"].iter().any(|needle| value.contains(needle)) {
        return Rank::Routine;
    }
    if value.contains("impassable") || value.contains("closed") {
        return Rank::Alert;
    }
    Rank::Warn
}

fn parse_open511(body: Option<&Value>, lat: f64, lon: f64) -> Parsed {
    let Some(body) = body else { return unreadable() };
    let Some(events) = body.get("events").and_then(|v| v.as_array()) else { return unreadable() };
    let mut out = Vec::new();
    for row in events {
        if let Some(event) = open511_event(row, lat, lon) {
            out.push(event);
        }
    }
    Parsed { events: out, routine_omitted: 0, unreadable: false }
}

fn open511_event(row: &Value, lat: f64, lon: f64) -> Option<TrafficEvent> {
    let point = in_circle(lat, lon, &geo_points(row.get("geography")))?;
    let event_type = field(row, &["event_type"]).unwrap_or_default().to_ascii_uppercase();
    let severity_name = field(row, &["severity"]).unwrap_or_default().to_ascii_uppercase();
    let mut impact = OpenImpact::None;
    let mut road_names = Vec::new();
    let mut direction = None;
    if let Some(roads) = row.get("roads").and_then(|v| v.as_array()) {
        for road in roads {
            if direction.is_none() {
                direction = field(road, &["direction"]);
            }
            if let Some(name) = field(road, &["name"]) {
                road_names.push(name);
            }
            impact = worse_open(impact, road_state_impact(&field(road, &["state"]).unwrap_or_default()));
        }
    }
    let description = field(row, &["description"]);
    let headline = field(row, &["headline"]);
    let weather = event_type == "WEATHER_CONDITION" || event_type == "ROAD_CONDITION";
    let incident = event_type == "INCIDENT" || event_type.contains("CLOSURE");
    let affects = impact != OpenImpact::None
        || severity_name == "MAJOR"
        || severity_name == "MODERATE"
        || incident
        || (weather && severity_name != "MINOR");
    let severity = if impact == OpenImpact::Closed || (severity_name == "MAJOR" && (incident || impact != OpenImpact::None)) {
        "alert"
    } else if affects {
        "warn"
    } else {
        "info"
    };
    let kind = if impact == OpenImpact::Closed || event_type.contains("CLOSURE") {
        "closure"
    } else if weather {
        "condition"
    } else if event_type == "CONSTRUCTION" {
        "roadwork"
    } else {
        "incident"
    };
    let title = match (&headline, &description) {
        (Some(head), Some(body)) => format!("{head}: {}", clip(body, 140)),
        (None, Some(body)) => body.clone(),
        (Some(head), None) => head.clone(),
        (None, None) => "Road event".into(),
    };
    Some(make_event(TrafficEvent {
        id: format!("open511:{}", field(row, &["id"]).unwrap_or_else(|| format!("{},{}", point.0, point.1))),
        title,
        kind: kind.into(),
        severity: severity.into(),
        affects_travel: affects,
        summary: description.as_deref().map(|text| clip(text, 500)),
        road: if road_names.is_empty() { None } else { Some(road_names.join(", ")) },
        direction,
        lat: point.0,
        lon: point.1,
        updated_at: field(row, &["updated"]).or_else(|| field(row, &["created"])),
        detail_url: field(row, &["url"]),
        feed_name: FeedId::Open511.name().into(),
    }))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum OpenImpact {
    None,
    Partial,
    Closed,
}

fn road_state_impact(state: &str) -> OpenImpact {
    let value = state.to_ascii_uppercase();
    if value.is_empty() || value == "ALL_LANES_OPEN" || value == "UNKNOWN" {
        return OpenImpact::None;
    }
    if value.contains("SHOULDER") && !value.contains("LANE") {
        return OpenImpact::None;
    }
    if value == "CLOSED" || value.contains("ALL_LANES_CLOSED") {
        return OpenImpact::Closed;
    }
    if value.contains("CLOSED") || value.contains("ALTERNATING") {
        return OpenImpact::Partial;
    }
    OpenImpact::None
}

fn worse_open(current: OpenImpact, next: OpenImpact) -> OpenImpact {
    if open_rank(next) > open_rank(current) { next } else { current }
}

fn open_rank(impact: OpenImpact) -> u8 {
    match impact {
        OpenImpact::None => 0,
        OpenImpact::Partial => 1,
        OpenImpact::Closed => 2,
    }
}

fn parse_compass(xml: &str, lat: f64, lon: f64) -> Parsed {
    let lower = xml.to_ascii_lowercase();
    if !lower.contains("<incidentdata") && !lower.contains("<status") {
        return unreadable();
    }
    let mut events = Vec::new();
    let mut search = 0;
    while let Some(rel) = lower[search..].find("<incident") {
        let start = search + rel;
        let after = start + "<incident".len();
        let end_rel = lower[after..].find("</incident>").unwrap_or(lower.len() - after);
        let chunk = &xml[start..after + end_rel];
        if let Some(event) = compass_event(chunk, lat, lon) {
            events.push(event);
        }
        search = after + end_rel;
        if search >= lower.len() {
            break;
        }
    }
    Parsed { events, routine_omitted: 0, unreadable: false }
}

fn compass_event(chunk: &str, lat: f64, lon: f64) -> Option<TrafficEvent> {
    let status = xml_text(chunk, "status").unwrap_or_default().to_ascii_lowercase();
    if status.contains("cleared") || status.contains("cancel") || status.contains("expired") {
        return None;
    }
    let point = in_circle(lat, lon, &[compass_point(xml_text(chunk, "lat").as_deref(), xml_text(chunk, "lon").as_deref())])?;
    let description = xml_text(chunk, "desc").unwrap_or_else(|| "Road incident".into());
    let severity_name = xml_text(chunk, "severity").unwrap_or_default().to_ascii_lowercase();
    let lanes = chunk.to_ascii_lowercase().contains("<isblocked>true</isblocked>")
        || xml_text(chunk, "affectedLanesDescription").unwrap_or_default().to_ascii_lowercase().contains("closed");
    let closed_road = description.to_ascii_lowercase().contains("bridge closed")
        || description.to_ascii_lowercase().contains("road closed")
        || description.to_ascii_lowercase().contains("all lanes")
        || description.to_ascii_lowercase().contains("closed due");
    let affects = lanes || closed_road || description.to_ascii_lowercase().contains("delay") || severity_name == "high" || severity_name == "medium";
    let severity = if closed_road || severity_name == "high" || severity_name == "major" { "alert" } else if affects { "warn" } else { "info" };
    let id = chunk.split("id=\"").nth(1).and_then(|rest| rest.split('"').next()).filter(|id| !id.is_empty()).unwrap_or("event");
    Some(make_event(TrafficEvent {
        id: format!("compass:{id}"),
        title: description,
        kind: if closed_road { "closure" } else { "incident" }.into(),
        severity: severity.into(),
        affects_travel: affects,
        summary: xml_text(chunk, "affectedLanesDescription"),
        road: xml_text(chunk, "roadway"),
        direction: xml_text(chunk, "direction"),
        lat: point.0,
        lon: point.1,
        updated_at: xml_text(chunk, "lastUpdatedTimestamp").or_else(|| xml_text(chunk, "createdTimestamp")),
        detail_url: Some("https://newengland511.org/".into()),
        feed_name: FeedId::Compass.name().into(),
    }))
}

fn compass_point(lat_raw: Option<&str>, lon_raw: Option<&str>) -> Option<(f64, f64)> {
    let mut lat = lat_raw?.trim().parse::<f64>().ok()?;
    let mut lon = lon_raw?.trim().parse::<f64>().ok()?;
    if lat.abs() > 90.0 {
        lat /= 1_000_000.0;
    }
    if lon.abs() > 180.0 {
        lon /= 1_000_000.0;
    }
    if in_world(lat, lon) { Some((lat, lon)) } else { None }
}

fn xml_text(block: &str, tag: &str) -> Option<String> {
    let lower = block.to_ascii_lowercase();
    let open = format!("<{tag}");
    let start = lower.find(&open.to_ascii_lowercase())?;
    let after = &block[start + open.len()..];
    let lower_after = after.to_ascii_lowercase();
    let gt = lower_after.find('>')?;
    let rest = &after[gt + 1..];
    let close = format!("</{tag}>");
    let end = rest.to_ascii_lowercase().find(&close.to_ascii_lowercase())?;
    let text = rest[..end].trim();
    if text.is_empty() { None } else { Some(text.to_string()) }
}

fn in_circle(lat: f64, lon: f64, points: &[Option<(f64, f64)>]) -> Option<(f64, f64)> {
    let mut best = None;
    let mut best_miles = f64::INFINITY;
    for point in points.iter().flatten() {
        if !in_world(point.0, point.1) {
            continue;
        }
        let miles = miles_between(lat, lon, point.0, point.1);
        if miles <= REGION_MILES && miles < best_miles {
            best = Some(*point);
            best_miles = miles;
        }
    }
    best
}

fn make_event(mut event: TrafficEvent) -> TrafficEvent {
    event.title = clip(&event.title, 220);
    if event.title.is_empty() {
        event.title = "Road event".into();
    }
    event.summary = event.summary.and_then(|text| {
        let clipped = clip(&text, 500);
        if clipped.is_empty() { None } else { Some(clipped) }
    });
    event
}

fn path_points(value: Option<&Value>) -> Vec<Option<(f64, f64)>> {
    let Some(row) = value else { return vec![] };
    let mut points = vec![
        lon_lat_array(row.get("ClosureStartLocation")),
        lon_lat_array(row.get("ClosureEndLocation")),
    ];
    if let Some(line) = row.get("Polyline").and_then(|v| v.as_array()) {
        for pair in line {
            points.push(lon_lat_array(Some(pair)));
        }
    }
    points
}

fn lon_lat_array(value: Option<&Value>) -> Option<(f64, f64)> {
    let arr = value?.as_array()?;
    let lon = num_of(arr.first()?)?;
    let lat = num_of(arr.get(1)?)?;
    if in_world(lat, lon) { Some((lat, lon)) } else { None }
}

fn geo_points(geometry: Option<&Value>) -> Vec<Option<(f64, f64)>> {
    let Some(row) = geometry else { return vec![] };
    let Some(coords) = row.get("coordinates").and_then(|v| v.as_array()) else { return vec![] };
    let kind = field(row, &["type"]).unwrap_or_default();
    if kind == "Point" {
        return vec![lon_lat_array(Some(&Value::Array(coords.clone())))];
    }
    if kind == "LineString" || kind == "MultiPoint" {
        return coords.iter().map(|pair| lon_lat_array(Some(pair))).collect();
    }
    if kind == "MultiLineString" || kind == "Polygon" {
        let mut out = Vec::new();
        for line in coords {
            if let Some(pairs) = line.as_array() {
                for pair in pairs {
                    out.push(lon_lat_array(Some(pair)));
                }
            }
        }
        return out;
    }
    vec![]
}

fn features_of(body: &Value) -> Option<Vec<&Value>> {
    let obj = body.as_object()?;
    if obj.contains_key("error") {
        return None;
    }
    Some(obj.get("features")?.as_array()?.iter().collect())
}

fn object_rows<'a>(body: &'a Value, keys: &[&str]) -> Option<Vec<&'a Value>> {
    if let Some(arr) = body.as_array() {
        return Some(arr.iter().filter(|v| v.is_object()).collect());
    }
    let obj = body.as_object()?;
    if obj.contains_key("error") || obj.contains_key("Error") {
        return None;
    }
    for key in keys {
        if let Some(arr) = obj.get(*key).and_then(|v| v.as_array()) {
            return Some(arr.iter().filter(|v| v.is_object()).collect());
        }
    }
    None
}

fn lat_lon_fields(row: &Value) -> Option<(f64, f64)> {
    let lat = row.get("lat").or_else(|| row.get("Lat")).or_else(|| row.get("Latitude")).or_else(|| row.get("latitude")).and_then(num_of)?;
    let lon = row.get("lon").or_else(|| row.get("Lon")).or_else(|| row.get("Longitude")).or_else(|| row.get("longitude")).and_then(num_of)?;
    if in_world(lat, lon) { Some((lat, lon)) } else { None }
}

fn lat_lon_pair(value: Option<&Value>) -> Option<(f64, f64)> {
    let raw = text_of(value?)?;
    let mut parts = raw.split(',');
    let lat = parts.next()?.trim().parse().ok()?;
    let lon = parts.next()?.trim().parse().ok()?;
    if in_world(lat, lon) { Some((lat, lon)) } else { None }
}

fn midpoint(a: Option<(f64, f64)>, b: Option<(f64, f64)>) -> Option<(f64, f64)> {
    match (a, b) {
        (Some(a), Some(b)) => Some(((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0)),
        _ => None,
    }
}

fn epoch(value: Option<&Value>) -> Option<String> {
    let n = num_of(value?)?;
    let ms = if n > 10_000_000_000.0 { n } else { n * 1000.0 };
    let secs = (ms / 1000.0).floor() as i64;
    let nanos = ((ms - secs as f64 * 1000.0) * 1_000_000.0).round() as u32;
    chrono::DateTime::from_timestamp(secs, nanos).map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn unreadable() -> Parsed {
    Parsed { events: vec![], routine_omitted: 0, unreadable: true }
}

fn limit_events(events: Vec<TrafficEvent>) -> Vec<TrafficEvent> {
    let mut ranked = events;
    ranked.sort_by(compare_events);
    if ranked.len() <= MAX_EVENTS {
        return ranked;
    }
    let mut important = Vec::new();
    let mut rest = Vec::new();
    for event in ranked {
        if event.affects_travel { important.push(event); } else { rest.push(event); }
    }
    important.extend(rest);
    important.truncate(MAX_EVENTS);
    important.sort_by(compare_events);
    important
}

fn compare_events(a: &TrafficEvent, b: &TrafficEvent) -> std::cmp::Ordering {
    severity_rank(&a.severity)
        .cmp(&severity_rank(&b.severity))
        .then_with(|| a.title.cmp(&b.title))
        .then_with(|| a.id.cmp(&b.id))
}

fn severity_rank(severity: &str) -> u8 {
    match severity {
        "alert" => 0,
        "warn" => 1,
        _ => 2,
    }
}

fn region_bounds(lat: f64, lon: f64) -> Box {
    let d_lat = REGION_MILES / MILES_PER_DEG_LAT;
    let cos = (lat * PI / 180.0).cos();
    let miles_per_deg_lon = (MILES_PER_DEG_LAT * cos.abs()).max(1.0);
    let d_lon = REGION_MILES / miles_per_deg_lon;
    Box {
        south: (lat - d_lat).clamp(-90.0, 90.0),
        north: (lat + d_lat).clamp(-90.0, 90.0),
        west: (lon - d_lon).max(-180.0),
        east: (lon + d_lon).min(180.0),
    }
}

fn feeds_for(bounds: &Box) -> Vec<FeedId> {
    let mut ids = Vec::new();
    if intersects(bounds, &PENNDOT) { ids.push(FeedId::Penndot); }
    if intersects(bounds, &OHIO) { ids.push(FeedId::Ohgo); }
    if intersects(bounds, &MARYLAND) { ids.push(FeedId::Chart); }
    if intersects(bounds, &IOWA) { ids.push(FeedId::Iowa); }
    if intersects(bounds, &BRITISH_COLUMBIA) { ids.push(FeedId::Open511); }
    if intersects(bounds, &MAINE) || intersects(bounds, &NEW_HAMPSHIRE) || intersects(bounds, &VERMONT) {
        ids.push(FeedId::Compass);
    }
    ids
}

fn compass_networks(bounds: &Box) -> Vec<&'static str> {
    let mut networks = Vec::new();
    if intersects(bounds, &MAINE) { networks.push("Maine"); }
    if intersects(bounds, &NEW_HAMPSHIRE) { networks.push("NewHampshire"); }
    if intersects(bounds, &VERMONT) { networks.push("Vermont"); }
    networks
}

fn intersects(a: &Box, b: &Box) -> bool {
    a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west
}

fn miles_between(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let r = 3958.7613;
    let p1 = lat1 * PI / 180.0;
    let p2 = lat2 * PI / 180.0;
    let d_lat = (lat2 - lat1) * PI / 180.0;
    let d_lon = (lon2 - lon1) * PI / 180.0;
    let h = (d_lat / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (d_lon / 2.0).sin().powi(2);
    2.0 * r * h.sqrt().min(1.0).asin()
}

fn report(id: FeedId, status: &str, detail: Option<String>) -> TrafficFeedReport {
    TrafficFeedReport { id: id.as_str().into(), name: id.name().into(), status: status.into(), detail }
}

fn place_label(params: &std::collections::BTreeMap<String, Value>) -> Option<String> {
    let loc = params.get("location")?.as_object()?;
    if loc.get("confirmed")?.as_bool() != Some(true) {
        return None;
    }
    let label = loc.get("label")?.as_str()?.trim();
    if label.is_empty() { None } else { Some(label.to_string()) }
}

fn secret(secrets: &std::collections::BTreeMap<String, String>, key: &str) -> Option<String> {
    secrets.get(key).map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
}

enum Auth<'a> {
    None,
    Basic { user: &'a str, pass: &'a str },
    Ohgo(&'a str),
}

fn get_json(client: &reqwest::blocking::Client, url: &str, auth: Auth<'_>) -> Result<Value, String> {
    let mut req = client.get(url);
    req = match auth {
        Auth::None => req,
        Auth::Basic { user, pass } => req.basic_auth(user, Some(pass)),
        Auth::Ohgo(key) => req.header("authorization", format!("APIKEY {key}")),
    };
    let response = req.send().map_err(|_| "did not respond.".to_string())?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED || response.status() == reqwest::StatusCode::FORBIDDEN {
        return Err("refused the saved credentials.".into());
    }
    if !response.status().is_success() {
        return Err("did not respond.".into());
    }
    response.json().map_err(|_| "returned data this app could not read.".into())
}

fn get_text(client: &reqwest::blocking::Client, url: &str) -> Result<String, String> {
    let response = client.get(url).send().map_err(|_| "did not respond.".to_string())?;
    if !response.status().is_success() {
        return Err("did not respond.".into());
    }
    response.text().map_err(|_| "returned data this app could not read.".into())
}

fn iowa_url(base: &str, bounds: &Box) -> String {
    let mut url = url::Url::parse(base).expect("iowa url");
    url.query_pairs_mut()
        .append_pair("where", "1=1")
        .append_pair("outFields", "*")
        .append_pair("returnGeometry", "true")
        .append_pair("f", "geojson")
        .append_pair("outSR", "4326")
        .append_pair("inSR", "4326")
        .append_pair("geometry", &format!("{},{},{},{}", bounds.west, bounds.south, bounds.east, bounds.north))
        .append_pair("geometryType", "esriGeometryEnvelope")
        .append_pair("spatialRel", "esriSpatialRelIntersects")
        .append_pair("resultRecordCount", "2000");
    url.to_string()
}

fn field(row: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(text) = row.get(*key).and_then(text_of) {
            return Some(text);
        }
    }
    None
}

fn text_of(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
        }
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn num_of(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn join_words(parts: &[Option<String>]) -> Option<String> {
    let text = parts.iter().flatten().map(|part| part.trim()).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() { None } else { Some(text) }
}

fn clip(value: &str, max: usize) -> String {
    let text = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= max {
        return text;
    }
    let mut out = text.chars().take(max.saturating_sub(1)).collect::<String>();
    out.push('…');
    out
}

fn in_world(lat: f64, lon: f64) -> bool {
    (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event_by<'a>(events: &'a [TrafficEvent], id: &str) -> Option<&'a TrafficEvent> {
        events.iter().find(|event| event.id == id)
    }

    #[test]
    fn penn_hills_uses_pennsylvania_and_ohio_and_keeps_travel_impacts() {
        let events = json!({"Values": [
            {"EventID": 581, "EventType": "roadwork", "Facility": "HITE RD", "Direction": "eastbound", "FromLocLatLong": "40.566278,-79.795637", "ToLocLatLong": "40.570501,-79.790632", "LaneStatus": "lane restriction", "Description": "Roadwork on HITE RD eastbound. There is a lane restriction.", "LastUpdate": "2019-08-27 14:31:55", "ActualDateTimeOpened": ""},
            {"EventID": 9, "EventType": "crash", "Facility": "I-76", "FromLocLatLong": "41.900000,-77.000000", "LaneStatus": "closed", "Description": "Too far"},
            {"EventID": 10, "EventType": "crash", "Facility": "US 22", "FromLocLatLong": "40.450000,-79.800000", "LaneStatus": "open", "ActualDateTimeOpened": "2019-08-27 15:00:00", "Description": "Reopened"},
            {"EventID": 11, "EventType": "disabled vehicle", "Facility": "PA 8", "FromLocLatLong": "40.480000,-79.840000", "LaneStatus": "shoulder closed", "Description": "Disabled vehicle on the shoulder."}
        ]});
        let winter = json!({"Values": [
            {"RoadSectionID": 1, "Facility": "I-376", "Condition": "Clear", "FromLocLatLong": "40.470000,-79.850000", "ToLocLatLong": "40.490000,-79.820000"},
            {"RoadSectionID": 2, "Facility": "I-79", "Condition": "Icy", "FromLocLatLong": "40.520000,-80.020000", "ToLocLatLong": "40.560000,-80.080000"},
            {"RoadSectionID": 3, "Facility": "US 30", "Condition": "Wet with Freezing Conditions", "FromLocLatLong": "40.430000,-79.900000", "ToLocLatLong": "40.440000,-79.880000"}
        ]});
        let incidents = json!({"Results": [
            {"Id": "oh-1", "Latitude": 40.9, "Longitude": -80.7, "RouteName": "I-80", "Category": "Accident", "RoadStatus": "Partial Closure", "Description": "Crash on I-80 westbound."},
            {"Id": "oh-far", "Latitude": 41.5, "Longitude": -83.0, "Description": "Far Ohio crash.", "RoadStatus": "Closed"}
        ]});
        let delays = json!({"Results": [
            {"Id": "delay-1", "Latitude": 40.85, "Longitude": -80.55, "RouteName": "I-76", "DelayTime": 12, "CurrentAvgSpeed": 25, "NormalAvgSpeed": 65, "Description": "Slowdown on I-76."},
            {"Id": "delay-small", "Latitude": 40.8, "Longitude": -80.5, "RouteName": "I-680", "DelayTime": 1, "CurrentAvgSpeed": 62, "NormalAvgSpeed": 65, "Description": "Small slowdown."}
        ]});
        let collected = collect_traffic(CollectArgs {
            lat: 40.475,
            lon: -79.835,
            label: Some("Penn Hills".into()),
            penndot: true,
            ohgo: true,
            penndot_events: Some(&Ok(events)),
            penndot_winter: Some(&Ok(winter)),
            ohgo_incidents: Some(&Ok(incidents)),
            ohgo_delays: Some(&Ok(delays)),
            chart_events: None,
            chart_closures: None,
            iowa_events: None,
            iowa_conditions: None,
            open511: None,
            compass: None,
        });
        let events = &collected.traffic.events;
        assert_eq!(event_by(events, "penndot:581").unwrap().severity, "warn");
        assert_eq!(event_by(events, "penndot:581").unwrap().kind, "roadwork");
        assert!(event_by(events, "penndot:9").is_none());
        assert!(event_by(events, "penndot:10").is_none());
        assert!(!event_by(events, "penndot:11").unwrap().affects_travel);
        assert_eq!(event_by(events, "penndot-winter:2").unwrap().severity, "alert");
        assert_eq!(event_by(events, "penndot-winter:3").unwrap().severity, "warn");
        assert!(event_by(events, "ohgo:oh-1").unwrap().affects_travel);
        assert!(event_by(events, "ohgo:oh-far").is_none());
        assert_eq!(event_by(events, "ohgo-delay:delay-1").unwrap().severity, "alert");
        assert!(!event_by(events, "ohgo-delay:delay-small").unwrap().affects_travel);
        assert_eq!(collected.traffic.routine_omitted, 1);
        assert!(collected.attribution.contains("PennDOT 511"));
        assert!(collected.attribution.contains("Esri basemap"));
    }

    #[test]
    fn missing_credentials_and_uncovered_regions_are_explicit() {
        let home = collect_traffic(CollectArgs {
            lat: 40.475,
            lon: -79.835,
            label: None,
            penndot: false,
            ohgo: false,
            penndot_events: None,
            penndot_winter: None,
            ohgo_incidents: None,
            ohgo_delays: None,
            chart_events: None,
            chart_closures: None,
            iowa_events: None,
            iowa_conditions: None,
            open511: None,
            compass: None,
        });
        assert!(home.traffic.feeds.iter().any(|feed| feed.id == "penndot" && feed.status == "needs-credentials"));
        assert!(home.traffic.feeds.iter().any(|feed| feed.id == "ohgo" && feed.status == "needs-credentials"));
        assert!(home.note.contains("PennDOT username"));
        let denver = collect_traffic(CollectArgs {
            lat: 39.74,
            lon: -104.99,
            label: None,
            penndot: false,
            ohgo: false,
            penndot_events: None,
            penndot_winter: None,
            ohgo_incidents: None,
            ohgo_delays: None,
            chart_events: None,
            chart_closures: None,
            iowa_events: None,
            iowa_conditions: None,
            open511: None,
            compass: None,
        });
        assert!(denver.traffic.feeds.is_empty());
        assert!(denver.note.contains("No free real-time incident feed"));
    }

    #[test]
    fn chart_iowa_open511_and_compass_keep_travel_impacts() {
        let chart_events = json!({"data": [
            {"id": "signal", "type": 249, "description": "Action Event", "lat": 39.3, "lon": -76.6, "incidentType": "Other", "trafficAlert": false, "lanes": []},
            {"id": "crash", "type": 2, "description": "Incident @ I-95", "lat": 39.3, "lon": -76.62, "incidentType": "Personal Injury", "trafficAlert": true, "lanes": [{"laneDescription": "L1", "laneType": "Traffic Lane", "laneStatus": "closed"}]}
        ]});
        let chart_closures = json!({"data": [
            {"id": "ramp", "description": "Active Closure", "lat": 39.4, "lon": -77.4, "closureStartDate": -1, "lanes": [{"laneDescription": "Rt OffRamp", "laneType": "Right Off Ramp", "laneStatus": "closed"}, {"laneDescription": "L1", "laneType": "Traffic Lane", "laneStatus": "open"}]},
            {"id": "shoulder", "description": "Shoulder only", "lat": 39.2, "lon": -76.7, "closureStartDate": -1, "lanes": [{"laneDescription": "RS", "laneType": "Shoulder", "laneStatus": "closed"}]}
        ]});
        let chart = collect_traffic(CollectArgs {
            lat: 39.29,
            lon: -76.61,
            label: None,
            penndot: false,
            ohgo: false,
            penndot_events: None,
            penndot_winter: None,
            ohgo_incidents: None,
            ohgo_delays: None,
            chart_events: Some(&Ok(chart_events)),
            chart_closures: Some(&Ok(chart_closures)),
            iowa_events: None,
            iowa_conditions: None,
            open511: None,
            compass: None,
        });
        assert!(event_by(&chart.traffic.events, "chart:signal").is_none());
        assert!(event_by(&chart.traffic.events, "chart:crash").unwrap().affects_travel);
        assert_eq!(event_by(&chart.traffic.events, "chart-closure:ramp").unwrap().severity, "warn");
        assert!(event_by(&chart.traffic.events, "chart-closure:shoulder").is_none());

        let iowa_events = json!({"type": "FeatureCollection", "features": [
            {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-93.6, 41.6]}, "properties": {"ID": "IA-1", "STYLE": "closure", "headline": "I-80 closed", "Route": "I-80", "linktxt": "https://511ia.org/event/IA-1"}},
            {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-93.61, 41.61]}, "properties": {"ID": "IA-later", "STYLE": "future_event", "headline": "Next month"}}
        ]});
        let iowa_roads = json!({"type": "FeatureCollection", "features": [
            {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[-93.6, 41.6]]}, "properties": {"SEGMENT_ID": 9, "ROAD_CONDITION": "Seasonal", "PRIMARY_LATITUDE": 41.6, "PRIMARY_LONGITUDE": -93.6, "ROUTE_NAME": "I-35"}},
            {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[-93.62, 41.62]]}, "properties": {"SEGMENT_ID": 10, "ROAD_CONDITION": "Ice", "PRIMARY_LATITUDE": 41.62, "PRIMARY_LONGITUDE": -93.62, "ROUTE_NAME": "US 65"}}
        ]});
        let iowa = collect_traffic(CollectArgs {
            lat: 41.6,
            lon: -93.6,
            label: None,
            penndot: false,
            ohgo: false,
            penndot_events: None,
            penndot_winter: None,
            ohgo_incidents: None,
            ohgo_delays: None,
            chart_events: None,
            chart_closures: None,
            iowa_events: Some(&Ok(iowa_events)),
            iowa_conditions: Some(&Ok(iowa_roads)),
            open511: None,
            compass: None,
        });
        assert_eq!(event_by(&iowa.traffic.events, "iowa:IA-1").unwrap().detail_url.as_deref(), Some("https://511ia.org/event/IA-1"));
        assert!(event_by(&iowa.traffic.events, "iowa:IA-later").is_none());
        assert_eq!(iowa.traffic.routine_omitted, 1);
        assert_eq!(event_by(&iowa.traffic.events, "iowa-road:10").unwrap().kind, "condition");

        let open511 = json!({"events": [
            {"id": "drivebc.ca/rest", "headline": "CONSTRUCTION", "severity": "MINOR", "event_type": "CONSTRUCTION", "description": "Rest area closed.", "geography": {"type": "Point", "coordinates": [-123.1, 49.25]}, "roads": [{"name": "Highway 1", "state": "ALL_LANES_OPEN"}]},
            {"id": "drivebc.ca/shut", "headline": "CLOSED", "severity": "MAJOR", "event_type": "INCIDENT", "description": "Highway closed.", "geography": {"type": "Point", "coordinates": [-123.12, 49.25]}, "roads": [{"state": "CLOSED"}]},
            {"id": "drivebc.ca/far", "severity": "MAJOR", "event_type": "INCIDENT", "geography": {"type": "Point", "coordinates": [-120.0, 51.0]}, "roads": [{"state": "CLOSED"}]}
        ]});
        let bc = collect_traffic(CollectArgs {
            lat: 49.25,
            lon: -123.12,
            label: None,
            penndot: false,
            ohgo: false,
            penndot_events: None,
            penndot_winter: None,
            ohgo_incidents: None,
            ohgo_delays: None,
            chart_events: None,
            chart_closures: None,
            iowa_events: None,
            iowa_conditions: None,
            open511: Some(&Ok(open511)),
            compass: None,
        });
        assert!(!event_by(&bc.traffic.events, "open511:drivebc.ca/rest").unwrap().affects_travel);
        assert_eq!(event_by(&bc.traffic.events, "open511:drivebc.ca/shut").unwrap().severity, "alert");
        assert!(event_by(&bc.traffic.events, "open511:drivebc.ca/far").is_none());

        let xml = r#"<status><incidentData><incident id="ME26-003760"><desc>Brunswick Route 1 northbound Right Lane closed due to Bridge Maintenance use caution and expect delays</desc><lat>43813515</lat><lon>-70303726</lon><status>Verified</status><severity>Medium</severity><affectedLanesDescription>Right lane closed</affectedLanesDescription></incident><incident id="ME-cleared"><desc>Cleared earlier</desc><lat>43660000</lat><lon>-70260000</lon><status>Cleared</status></incident></incidentData></status>"#;
        let maine = collect_traffic(CollectArgs {
            lat: 43.66,
            lon: -70.26,
            label: None,
            penndot: false,
            ohgo: false,
            penndot_events: None,
            penndot_winter: None,
            ohgo_incidents: None,
            ohgo_delays: None,
            chart_events: None,
            chart_closures: None,
            iowa_events: None,
            iowa_conditions: None,
            open511: None,
            compass: Some(&Ok(xml.into())),
        });
        let lane = event_by(&maine.traffic.events, "compass:ME26-003760").unwrap();
        assert!(lane.affects_travel);
        assert!((lane.lat - 43.813515).abs() < 0.0001);
        assert!(event_by(&maine.traffic.events, "compass:ME-cleared").is_none());
    }
}
