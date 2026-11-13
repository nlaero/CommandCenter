pub mod alerts;
pub mod broadcastify;
pub mod incident;
pub mod quake;
pub mod weather;

use crate::config::SourceConfig;
use crate::secrets;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePayload {
    pub source_id: String,
    pub type_id: String,
    pub fetched_at: String,
    pub attribution: Option<String>,
    pub note: Option<String>,
    #[serde(default)]
    pub incidents: Vec<incident::Incident>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feed: Option<broadcastify::FeedStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weather: Option<weather::WeatherPayload>,
    /// Present for `usgs.earthquake`. Map, poll interval, and full event list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quake: Option<quake::QuakePayload>,
    /// Notable rows for the shared alerts pane. Empty for sources that do not emit any.
    /// The pane is not on main yet — subscribe from `src/lib/alertsBus.ts`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub alerts: Vec<alerts::SourceAlert>,
}

#[derive(Debug, thiserror::Error)]
pub enum SourceError {
    #[error("{0}")]
    Message(String),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("config error: {0}")]
    Config(#[from] crate::config::ConfigError),
}

pub fn fetch_source(
    source_id: &str,
    source: &SourceConfig,
    overrides: &BTreeMap<String, Value>,
) -> Result<SourcePayload, SourceError> {
    match source.type_id.as_str() {
        "incident.opendata" => {
            let secrets = resolve_secrets(&source.secrets)?;
            let result = incident::fetch(source, &secrets)?;
            Ok(SourcePayload {
                source_id: source_id.to_string(),
                type_id: source.type_id.clone(),
                fetched_at: result.fetched_at,
                attribution: Some(result.attribution),
                note: result.note,
                incidents: result.incidents,
                feed: None,
                weather: None,
                quake: None,
                alerts: Vec::new(),
            })
        }
        "broadcastify.owner" => {
            let secrets = resolve_secrets(&source.secrets)?;
            let result = broadcastify::fetch(source, &secrets, overrides)?;
            Ok(SourcePayload {
                source_id: source_id.to_string(),
                type_id: source.type_id.clone(),
                fetched_at: result.fetched_at,
                attribution: Some(result.attribution),
                note: result.note,
                incidents: result.incidents,
                feed: Some(result.feed),
                weather: None,
                quake: None,
                alerts: Vec::new(),
            })
        }
        "weather.openmeteo" => {
            let secrets = resolve_secrets(&source.secrets)?;
            let result = weather::fetch(source, &secrets)?;
            Ok(SourcePayload {
                source_id: source_id.to_string(),
                type_id: source.type_id.clone(),
                fetched_at: result.fetched_at,
                attribution: Some(result.attribution),
                note: result.note,
                incidents: vec![],
                feed: None,
                weather: Some(result.weather),
                quake: None,
                alerts: Vec::new(),
            })
        }
        "usgs.earthquake" => {
            let result = quake::fetch(source_id, source)?;
            Ok(SourcePayload {
                source_id: source_id.to_string(),
                type_id: source.type_id.clone(),
                fetched_at: result.fetched_at,
                attribution: Some(result.attribution),
                note: result.note,
                incidents: result.incidents,
                feed: None,
                weather: None,
                quake: Some(result.quake),
                alerts: result.alerts,
            })
        }
        other => Err(SourceError::Message(format!(
            "live fetch not implemented for source type: {other}"
        ))),
    }
}

fn resolve_secrets(names: &[String]) -> Result<BTreeMap<String, String>, SourceError> {
    let mut out = BTreeMap::new();
    for name in names {
        if let Some(value) = secrets::get_secret(name)? {
            out.insert(name.clone(), value);
        }
    }
    Ok(out)
}
