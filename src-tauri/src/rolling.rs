/// Keep this list in step with `LIVE_FEED_TYPES` in `src/lib/rolling.ts`.
/// Weather is refused separately: its maps rotate inside the weather panel.
pub fn source_scrolls(type_id: &str) -> bool {
    !matches!(
        type_id,
        "adsb.exchange"
            | "adsb.local"
            | "audio.local"
            | "broadcastify.owner"
            | "camera.http_image"
            | "camera.private"
            | "camera.public"
            | "camera.rtsp"
            | "scanner.web"
            | "video.youtube"
    )
}

fn source_name(type_id: &str) -> &str {
    match type_id {
        "adsb.exchange" => "ADS-B Exchange",
        "adsb.local" => "Local ADS-B",
        "audio.local" => "Local audio",
        "broadcastify.owner" => "Broadcastify",
        "camera.http_image" => "Camera",
        "camera.private" => "Private camera",
        "camera.public" => "Public camera",
        "camera.rtsp" => "RTSP camera",
        "scanner.web" => "Web scanner",
        "video.youtube" => "YouTube",
        "weather.openmeteo" => "Weather",
        _ => "This source",
    }
}

pub fn rolling_member_refusal(type_id: &str) -> Option<String> {
    if type_id == "weather.openmeteo" {
        return Some(
            "Weather stays in its own panel. Choose which maps it shows, how many are on screen, and whether those maps rotate inside the weather panel. Weather cannot be added to a rolling panel.".into(),
        );
    }
    if source_scrolls(type_id) {
        return None;
    }
    Some(format!(
        "{} is a live feed and does not scroll. It cannot be part of a rolling panel. Leave it as its own panel, or pick a source that scrolls.",
        source_name(type_id)
    ))
}

pub fn rolling_panel_refusal(type_ids: &[String]) -> Option<String> {
    type_ids.iter().find_map(|type_id| rolling_member_refusal(type_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weather_and_live_feeds_are_refused() {
        let weather = rolling_member_refusal("weather.openmeteo").unwrap();
        assert!(weather.contains("cannot be added to a rolling panel"));
        assert!(source_scrolls("weather.openmeteo"));
        assert!(rolling_member_refusal("scanner.web")
            .unwrap()
            .contains("does not scroll"));
        assert!(rolling_panel_refusal(&["news.rss".into(), "rivers.nwps".into()]).is_none());
        assert!(source_scrolls("alarms.home"));
    }
}
