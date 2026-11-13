pub mod broadcastify;
pub mod incident;

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
    pub incidents: Vec<incident::Incident>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feed: Option<broadcastify::FeedStatus>,
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
