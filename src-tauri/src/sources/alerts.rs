//! Shared alerts contract for the right-hand alerts pane.
//!
//! That pane is not on main yet. Sources that have something worth surfacing
//! (USGS notable quakes, tsunami flags, landslides, volcanic eruptions) fill
//! `SourcePayload.alerts`. The web UI publishes the same rows through
//! `src/lib/alertsBus.ts` (`publishSourceAlerts` / `subscribeAlerts`).

use crate::sources::incident::IncidentSeverity;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceAlert {
    pub id: String,
    pub source_id: String,
    pub source_type: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub severity: IncidentSeverity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub occurred_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lat: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lon: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail_url: Option<String>,
    /// `earthquake`, `tsunami`, `landslide`, `explosion`, …
    pub kind: String,
}
