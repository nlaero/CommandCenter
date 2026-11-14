pub mod broadcastify;
pub mod calls;
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
}

#[derive(Debug, thiserror::Error)]
pub enum SourceError {
    #[error("{0}")]
    Message(String),
    #[error("config error: {0}")]
    Config(#[from] crate::config::ConfigError),
}

impl From<reqwest::Error> for SourceError {
    fn from(err: reqwest::Error) -> Self {
        // Display includes the request URL. Broadcastify puts the password in
        // the query string, and an Open-Meteo key is a query parameter.
        SourceError::Message(format!("http error: {}", err.without_url()))
    }
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
            })
        }
        "broadcastify.calls" => {
            let secrets = resolve_secrets(&source.secrets)?;
            let result = calls::fetch(source, &secrets)?;
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
            })
        }
        "usgs.earthquake" => {
            let result = quake::fetch(source)?;
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

#[cfg(test)]
mod tests {
    use super::SourceError;

    #[test]
    fn http_errors_omit_urls_that_carry_secrets() {
        let err = reqwest::blocking::Client::builder()
            .connect_timeout(std::time::Duration::from_millis(400))
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .unwrap()
            .get("http://127.0.0.1:1/?p=super-secret-value&apikey=abcd1234efgh")
            .send()
            .unwrap_err();
        let shown = SourceError::from(err).to_string();
        assert!(shown.starts_with("http error:"));
        assert!(!shown.contains("super-secret-value"), "{shown}");
        assert!(!shown.contains("abcd1234efgh"), "{shown}");
        assert!(!shown.contains("127.0.0.1"), "{shown}");
    }
}
