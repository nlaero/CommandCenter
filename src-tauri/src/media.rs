//! Fetch a camera playlist or segment for the panel.
//!
//! The webview cannot rely on CORS for municipal cameras, so HLS bytes come
//! through here. Playlists are rewritten to absolute URLs before they go back.

use std::io::Read;
use std::time::Duration;
use url::Url;

const MAX_BYTES: u64 = 32 * 1024 * 1024;
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 CommandCenter/0.1";

pub fn fetch_media(url: &str, range: Option<&str>) -> Result<Vec<u8>, String> {
    let parsed = Url::parse(url.trim()).map_err(|_| "Enter an http or https link.".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Enter an http or https link.".to_string());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(25))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(8))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|_| "Couldn't reach that stream.".to_string())?;

    let mut request = client.get(parsed);
    if let Some(range) = range {
        if let Some(spec) = range.trim().strip_prefix("bytes=") {
            if !spec.is_empty() && spec.bytes().all(|b| b.is_ascii_digit() || b == b'-') {
                request = request.header(reqwest::header::RANGE, format!("bytes={spec}"));
            }
        }
    }

    let response = request.send().map_err(|err| net_message(&err))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("The stream replied HTTP {}.", status.as_u16()));
    }
    let final_url = response.url().clone();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();

    let mut buf = Vec::new();
    response
        .take(MAX_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|_| "Couldn't reach that stream.".to_string())?;
    if buf.len() as u64 > MAX_BYTES {
        return Err("That response is too large to play.".to_string());
    }
    if is_playlist(&content_type, &buf) {
        let text = String::from_utf8_lossy(&buf);
        return Ok(absolutize_playlist(&text, final_url.as_str()).into_bytes());
    }
    Ok(buf)
}

fn net_message(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        "The stream timed out.".to_string()
    } else if err.is_connect() {
        "Couldn't connect to that stream.".to_string()
    } else {
        "Couldn't reach that stream.".to_string()
    }
}

fn is_playlist(content_type: &str, body: &[u8]) -> bool {
    let type_lower = content_type.to_ascii_lowercase();
    if type_lower.contains("mpegurl") || type_lower.contains("m3u8") {
        return true;
    }
    let head = String::from_utf8_lossy(&body[..body.len().min(32)]);
    head.trim_start_matches('\u{feff}')
        .trim_start()
        .starts_with("#EXTM3U")
}

pub fn absolutize_playlist(text: &str, base: &str) -> String {
    let bom = text.starts_with('\u{feff}');
    let cleaned = if bom { &text[1..] } else { text };
    if !cleaned.trim_start().starts_with("#EXTM3U") {
        return text.to_string();
    }
    let Ok(base_url) = Url::parse(base) else {
        return text.to_string();
    };
    let newline = if cleaned.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let ending = cleaned.ends_with('\n');
    let mut lines: Vec<&str> = cleaned
        .split('\n')
        .map(|line| line.trim_end_matches('\r'))
        .collect();
    if ending && lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    let rewritten: Vec<String> = lines
        .into_iter()
        .map(|line| rewrite_playlist_line(line, &base_url))
        .collect();
    let mut body = rewritten.join(newline);
    if ending {
        body.push_str(newline);
    }
    if bom {
        format!("\u{feff}{body}")
    } else {
        body
    }
}

fn rewrite_playlist_line(line: &str, base: &Url) -> String {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return line.to_string();
    }
    if trimmed.starts_with('#') {
        return rewrite_uri_attrs(line, base);
    }
    let lead_len = line.len() - line.trim_start().len();
    format!("{}{}", &line[..lead_len], resolve_ref(base, trimmed))
}

fn rewrite_uri_attrs(line: &str, base: &Url) -> String {
    let mut out = String::new();
    let mut rest = line;
    while let Some(start) = rest.find("URI=") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 4..];
        let quote = after.as_bytes().first().copied();
        if quote == Some(b'"') || quote == Some(b'\'') {
            let q = quote.unwrap() as char;
            let body = &after[1..];
            if let Some(end) = body.find(q) {
                let uri = &body[..end];
                out.push_str("URI=");
                out.push(q);
                out.push_str(&resolve_ref(base, uri));
                out.push(q);
                rest = &body[end + 1..];
                continue;
            }
        }
        out.push_str("URI=");
        rest = after;
    }
    out.push_str(rest);
    out
}

fn resolve_ref(base: &Url, reference: &str) -> String {
    let value = reference.trim();
    if value.is_empty() || value.starts_with("data:") {
        return value.to_string();
    }
    if let Ok(abs) = Url::parse(value) {
        if abs.scheme() == "http" || abs.scheme() == "https" {
            return abs.to_string();
        }
    }
    base.join(value)
        .map(|url| url.to_string())
        .unwrap_or_else(|_| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::{absolutize_playlist, fetch_media};

    #[test]
    fn rejects_non_http_links() {
        let err = fetch_media("file:///tmp/camera.m3u8", None).unwrap_err();
        assert!(err.contains("http"));
    }

    #[test]
    fn absolutize_master_playlist() {
        let src = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nplaylist_720.m3u8\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"playlist_audio_en_1.m3u8\"\n";
        let out = absolutize_playlist(src, "https://cdn.example/a30/hls/de3f/playlist.m3u8");
        assert!(out.contains("https://cdn.example/a30/hls/de3f/playlist_720.m3u8"));
        assert!(out.contains("URI=\"https://cdn.example/a30/hls/de3f/playlist_audio_en_1.m3u8\""));
        assert!(!out.contains("\nplaylist_720.m3u8"));
    }

    #[test]
    fn leaves_absolute_entries() {
        let src = "#EXTM3U\nhttps://cdn.example/already.ts\n";
        let out = absolutize_playlist(src, "https://cdn.example/hls/playlist.m3u8");
        assert!(out.contains("https://cdn.example/already.ts\n"));
    }
}
