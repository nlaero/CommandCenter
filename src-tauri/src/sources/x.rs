//! X follow feed.
//!
//! The user signs in with OAuth 2.0 PKCE. Access and refresh tokens stay in the
//! OS keyring (`x.session.*`). They are not written to the board file. The
//! client secret, when the app has one, is `x.client_secret` in the keyring.
//! The client ID is the app id from the developer portal, not a token.
//!
//! Posts come from the reverse-chronological home timeline: accounts the
//! signed-in user follows, newest first.

use crate::config::SourceConfig;
use crate::secrets;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{self, TryRecvError};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use url::Url;

const AUTHORIZE_URL: &str = "https://twitter.com/i/oauth2/authorize";
const TOKEN_URL: &str = "https://api.x.com/2/oauth2/token";
const USERS_ME: &str = "https://api.x.com/2/users/me";
pub const REDIRECT_URI: &str = "http://127.0.0.1:8737/callback";
const CALLBACK_PORT: u16 = 8737;
const CLIENT_SECRET: &str = "x.client_secret";
const ACCESS: &str = "x.session.access_token";
const REFRESH: &str = "x.session.refresh_token";
const EXPIRES: &str = "x.session.expires_at";
const USER_ID: &str = "x.session.user_id";
const USERNAME: &str = "x.session.username";
const NAME: &str = "x.session.name";
const CLIENT: &str = "x.session.client_id";
const SIGN_IN_WAIT: Duration = Duration::from_secs(180);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub signed_in: bool,
    pub username: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInStart {
    pub authorize_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowFeed {
    pub username: Option<String>,
    pub posts: Vec<Post>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Post {
    pub id: String,
    pub text: String,
    pub created_at: Option<String>,
    pub author_name: Option<String>,
    pub author_handle: Option<String>,
    pub reposted_by: Option<String>,
    pub url: String,
    pub media: Vec<Media>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub kind: MediaKind,
    pub url: Option<String>,
    pub preview_url: Option<String>,
    pub alt: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Photo,
    Video,
    AnimatedGif,
    Audio,
}

#[derive(Debug, Clone)]
pub struct FetchResult {
    pub feed: FollowFeed,
    pub attribution: String,
    pub fetched_at: String,
    pub note: Option<String>,
}

struct Session {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    user_id: String,
    username: String,
    name: String,
    client_id: String,
}

struct TokenSet {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
}

enum ApiFail {
    Unauthorized,
    Other(String),
}

struct Inflight {
    started: Instant,
    authorize_url: String,
    rx: mpsc::Receiver<Result<Account, String>>,
}

static INFLIGHT: Mutex<Option<Inflight>> = Mutex::new(None);

pub fn account() -> Result<Account, super::SourceError> {
    Ok(match load_session()? {
        Some(session) if session_usable(&session) => account_from(&session),
        _ => signed_out(),
    })
}

pub fn sign_out() -> Result<Account, super::SourceError> {
    clear_session()?;
    Ok(signed_out())
}

/// Open the system browser and wait on the loopback callback. A second click
/// while one sign-in is open returns the same link instead of starting another.
pub fn begin_sign_in(
    source: &SourceConfig,
    open_browser: impl FnOnce(&str) -> Result<(), String>,
) -> Result<String, super::SourceError> {
    let client_id = required_client_id(source)?;
    let client_secret = client_secret()?;
    let mut slot = inflight();
    if let Some(existing) = slot.as_ref() {
        if existing.started.elapsed() < SIGN_IN_WAIT {
            let url = existing.authorize_url.clone();
            drop(slot);
            let _ = open_browser(&url);
            return Ok(url);
        }
        slot.take();
    }

    let verifier = new_verifier();
    let state = uuid::Uuid::new_v4().simple().to_string();
    let challenge = code_challenge(&verifier);
    let url = authorization_url(&client_id, &state, &challenge)?;
    let listener = bind_callback(CALLBACK_PORT)?;
    let (tx, rx) = mpsc::channel();
    let secret_for_thread = client_secret.clone();
    let client_for_thread = client_id.clone();
    thread::spawn(move || {
        let result = finish_sign_in(
            listener,
            &state,
            &verifier,
            &client_for_thread,
            secret_for_thread.as_deref(),
        );
        let _ = tx.send(result.map_err(|err| err.to_string()));
    });
    *slot = Some(Inflight {
        started: Instant::now(),
        authorize_url: url.clone(),
        rx,
    });
    drop(slot);
    let _ = open_browser(&url);
    Ok(url)
}

pub fn poll_sign_in() -> Result<Option<Account>, super::SourceError> {
    let mut slot = inflight();
    let Some(inflight) = slot.as_ref() else {
        return Ok(None);
    };
    match inflight.rx.try_recv() {
        Ok(Ok(account)) => {
            slot.take();
            Ok(Some(account))
        }
        Ok(Err(message)) => {
            slot.take();
            Err(super::SourceError::Message(message))
        }
        Err(TryRecvError::Empty) => {
            if inflight.started.elapsed() > SIGN_IN_WAIT + Duration::from_secs(15) {
                slot.take();
                Err(super::SourceError::Message(
                    "X sign-in timed out. Try again.".into(),
                ))
            } else {
                Ok(None)
            }
        }
        Err(TryRecvError::Disconnected) => {
            slot.take();
            Err(super::SourceError::Message(
                "X sign-in stopped. Try again.".into(),
            ))
        }
    }
}

pub fn fetch(source: &SourceConfig) -> Result<FetchResult, super::SourceError> {
    let client_id = required_client_id(source)?;
    let secret = client_secret()?;
    let Some(mut session) = load_session()? else {
        return Err(super::SourceError::Message(
            "Sign in to X to load posts from accounts you follow.".into(),
        ));
    };
    if session.client_id != client_id {
        return Err(super::SourceError::Message(
            "Sign in to X again. This client ID does not match the saved sign-in.".into(),
        ));
    }
    if !session_usable(&session) {
        return Err(super::SourceError::Message("Sign in to X again.".into()));
    }
    if session_stale(&session) {
        session = refresh_session(&client_id, secret.as_deref(), session)?;
    }
    let limit = max_results(source);
    let username = nonempty(&session.username);
    let posts = match timeline(&session, limit) {
        Ok(posts) => posts,
        Err(ApiFail::Unauthorized) => {
            let session = refresh_session(&client_id, secret.as_deref(), session)?;
            match timeline(&session, limit) {
                Ok(posts) => posts,
                Err(ApiFail::Unauthorized) => {
                    let _ = clear_session();
                    return Err(super::SourceError::Message("Sign in to X again.".into()));
                }
                Err(ApiFail::Other(message)) => {
                    return Err(super::SourceError::Message(message));
                }
            }
        }
        Err(ApiFail::Other(message)) => return Err(super::SourceError::Message(message)),
    };
    Ok(FetchResult {
        feed: FollowFeed {
            username,
            posts,
        },
        attribution: "X".into(),
        fetched_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        note: Some(
            "Posts from accounts you follow, newest first. Video and audio start muted."
                .into(),
        ),
    })
}

fn finish_sign_in(
    listener: TcpListener,
    state: &str,
    verifier: &str,
    client_id: &str,
    client_secret: Option<&str>,
) -> Result<Account, super::SourceError> {
    let code = accept_oauth_code(listener, state, SIGN_IN_WAIT)?;
    let token = exchange_code(client_id, client_secret, &code, verifier)?;
    let (user_id, username, name) = fetch_me(&token.access_token, client_secret.unwrap_or(""))?;
    let session = Session {
        access_token: token.access_token,
        refresh_token: token.refresh_token.unwrap_or_default(),
        expires_at: expiry_at(token.expires_in),
        user_id,
        username,
        name,
        client_id: client_id.to_string(),
    };
    store_session(&session)?;
    Ok(account_from(&session))
}

fn exchange_code(
    client_id: &str,
    client_secret: Option<&str>,
    code: &str,
    verifier: &str,
) -> Result<TokenSet, super::SourceError> {
    let form = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", REDIRECT_URI),
        ("code_verifier", verifier),
        ("client_id", client_id),
    ];
    post_token(&form, client_id, client_secret)
}

fn refresh_session(
    client_id: &str,
    client_secret: Option<&str>,
    session: Session,
) -> Result<Session, super::SourceError> {
    if session.refresh_token.is_empty() {
        let _ = clear_session();
        return Err(super::SourceError::Message("Sign in to X again.".into()));
    }
    let form = [
        ("grant_type", "refresh_token"),
        ("refresh_token", session.refresh_token.as_str()),
        ("client_id", client_id),
    ];
    match post_token(&form, client_id, client_secret) {
        Ok(token) => {
            let updated = Session {
                access_token: token.access_token,
                refresh_token: token
                    .refresh_token
                    .unwrap_or_else(|| session.refresh_token.clone()),
                expires_at: expiry_at(token.expires_in),
                ..session
            };
            store_session(&updated)?;
            Ok(updated)
        }
        Err(super::SourceError::Message(message)) if message.contains("Sign in to X again") => {
            let _ = clear_session();
            Err(super::SourceError::Message(message))
        }
        Err(err) => Err(err),
    }
}

fn post_token(
    form: &[(&str, &str)],
    client_id: &str,
    client_secret: Option<&str>,
) -> Result<TokenSet, super::SourceError> {
    let secret = client_secret.unwrap_or("");
    let client = http()?;
    let mut request = client
        .post(TOKEN_URL)
        .form(form)
        .header("Accept", "application/json");
    if let Some(client_secret) = client_secret {
        request = request.header("Authorization", basic_header(client_id, client_secret));
    }
    let response = request.send().map_err(|err| {
        super::SourceError::Message(format!(
            "X sign-in failed: {}",
            sanitize(&err.without_url().to_string(), secret, "")
        ))
    })?;
    let status = response.status();
    let body = response.text().unwrap_or_default();
    if status.as_u16() == 401 || status.as_u16() == 400 {
        return Err(super::SourceError::Message("Sign in to X again.".into()));
    }
    if !status.is_success() {
        return Err(super::SourceError::Message(api_message(
            status.as_u16(),
            &body,
            "",
            secret,
        )));
    }
    parse_token(&body).map_err(|_| {
        super::SourceError::Message("Sign in to X again.".into())
    })
}

fn fetch_me(access_token: &str, secret: &str) -> Result<(String, String, String), super::SourceError> {
    let client = http()?;
    let response = client
        .get(USERS_ME)
        .query(&[("user.fields", "name,username")])
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Accept", "application/json")
        .send()
        .map_err(|err| {
            super::SourceError::Message(format!(
                "X account lookup failed: {}",
                sanitize(&err.without_url().to_string(), secret, access_token)
            ))
        })?;
    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(super::SourceError::Message(api_message(
            status.as_u16(),
            &body,
            access_token,
            secret,
        )));
    }
    parse_me(&body)
}

fn timeline(session: &Session, limit: u32) -> Result<Vec<Post>, ApiFail> {
    if !digits_ok(&session.user_id) {
        return Err(ApiFail::Other(
            "Sign in to X again. The saved account id is missing.".into(),
        ));
    }
    let url = format!(
        "https://api.x.com/2/users/{}/timelines/reverse_chronological",
        session.user_id
    );
    let client = http().map_err(|err| ApiFail::Other(err.to_string()))?;
    let response = client
        .get(url)
        .query(&[
            ("max_results", limit.to_string()),
            (
                "tweet.fields",
                "created_at,author_id,attachments,entities,note_tweet,referenced_tweets".into(),
            ),
            (
                "expansions",
                "author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id"
                    .into(),
            ),
            (
                "media.fields",
                "media_key,type,url,preview_image_url,alt_text,variants".into(),
            ),
            ("user.fields", "name,username".into()),
        ])
        .header("Authorization", format!("Bearer {}", session.access_token))
        .header("Accept", "application/json")
        .send()
        .map_err(|err| {
            ApiFail::Other(format!(
                "X follow feed failed: {}",
                sanitize(&err.without_url().to_string(), "", &session.access_token)
            ))
        })?;
    let status = response.status();
    let reset = response
        .headers()
        .get("x-rate-limit-reset")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok());
    let body = response.text().unwrap_or_default();
    if status.as_u16() == 401 {
        return Err(ApiFail::Unauthorized);
    }
    if status.as_u16() == 429 {
        let wait = reset
            .map(|stamp| (stamp - chrono::Utc::now().timestamp()).max(1))
            .unwrap_or(60);
        return Err(ApiFail::Other(format!(
            "X is rate limiting the follow feed. Try again in about {wait} seconds."
        )));
    }
    if !status.is_success() {
        return Err(ApiFail::Other(api_message(
            status.as_u16(),
            &body,
            &session.access_token,
            "",
        )));
    }
    let value: Value = serde_json::from_str(body.trim()).map_err(|_| {
        ApiFail::Other("X follow feed response was not JSON.".into())
    })?;
    if value.get("data").is_none() && value.get("errors").is_some() {
        return Err(ApiFail::Other(api_message(
            status.as_u16(),
            &body,
            &session.access_token,
            "",
        )));
    }
    Ok(posts_from_timeline(&value))
}

fn posts_from_timeline(body: &Value) -> Vec<Post> {
    let Some(rows) = body.get("data").and_then(|value| value.as_array()) else {
        return Vec::new();
    };
    let includes = body.get("includes").cloned().unwrap_or_else(|| Value::Null);
    let mut posts = Vec::new();
    for row in rows {
        if let Some(post) = post_from(row, &includes) {
            posts.push(post);
        }
    }
    posts
}

fn post_from(tweet: &Value, includes: &Value) -> Option<Post> {
    let (shown, repost_author) = displayed_tweet(tweet, includes);
    let id = shown.get("id").and_then(|value| value.as_str()).unwrap_or("");
    if !digits_ok(id) {
        return None;
    }
    let author_id = shown.get("author_id").and_then(|value| value.as_str());
    let (author_name, author_handle) = user_label(includes, author_id);
    let reposted_by = repost_author.and_then(|author_id| {
        let (_, handle) = user_label(includes, Some(author_id));
        handle
    });
    let handle = author_handle.as_deref();
    let mut keys = media_keys(shown);
    if keys.is_empty() && repost_author.is_some() {
        keys = media_keys(tweet);
    }
    Some(Post {
        id: id.to_string(),
        text: tweet_text(shown),
        created_at: shown
            .get("created_at")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        author_name,
        author_handle: handle.map(str::to_string),
        reposted_by,
        url: post_url(handle, id),
        media: resolve_media(&keys, includes),
    })
}

fn displayed_tweet<'a>(tweet: &'a Value, includes: &'a Value) -> (&'a Value, Option<&'a str>) {
    let Some(refs) = tweet.get("referenced_tweets").and_then(|value| value.as_array()) else {
        return (tweet, None);
    };
    let Some(repost_id) = refs.iter().find_map(|item| {
        if item.get("type").and_then(|value| value.as_str()) == Some("retweeted") {
            item.get("id").and_then(|value| value.as_str())
        } else {
            None
        }
    }) else {
        return (tweet, None);
    };
    let Some(original) = includes
        .get("tweets")
        .and_then(|value| value.as_array())
        .and_then(|rows| {
            rows.iter()
                .find(|row| row.get("id").and_then(|value| value.as_str()) == Some(repost_id))
        })
    else {
        return (tweet, None);
    };
    let by = tweet.get("author_id").and_then(|value| value.as_str());
    (original, by)
}

fn tweet_text(tweet: &Value) -> String {
    let note = tweet
        .pointer("/note_tweet/text")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|text| !text.is_empty());
    let base = note.unwrap_or_else(|| {
        tweet.get("text")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim()
    });
    let expanded = expand_urls(base, tweet);
    let expanded = if let Some(note_entities) = tweet.get("note_tweet") {
        expand_urls(&expanded, note_entities)
    } else {
        expanded
    };
    cap_text(expanded.trim(), 4000)
}

fn expand_urls(text: &str, owner: &Value) -> String {
    let Some(urls) = owner.pointer("/entities/urls").and_then(|value| value.as_array()) else {
        return text.to_string();
    };
    let mut out = text.to_string();
    for item in urls {
        let Some(from) = item.get("url").and_then(|value| value.as_str()) else {
            continue;
        };
        let Some(to) = item.get("expanded_url").and_then(|value| value.as_str()) else {
            continue;
        };
        if from.starts_with("https://t.co/") && safe_https_page(to) {
            out = out.replace(from, to);
        }
    }
    out
}

fn user_label(includes: &Value, id: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(id) = id else {
        return (None, None);
    };
    let Some(user) = includes
        .get("users")
        .and_then(|value| value.as_array())
        .and_then(|rows| {
            rows.iter()
                .find(|row| row.get("id").and_then(|value| value.as_str()) == Some(id))
        })
    else {
        return (None, None);
    };
    let name = user
        .get("name")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| cap_text(text, 80));
    let handle = user
        .get("username")
        .and_then(|value| value.as_str())
        .and_then(clean_handle);
    (name, handle)
}

fn media_keys(tweet: &Value) -> Vec<String> {
    tweet
        .pointer("/attachments/media_keys")
        .and_then(|value| value.as_array())
        .map(|keys| {
            keys.iter()
                .filter_map(|key| key.as_str().map(str::to_string))
                .filter(|key| !key.is_empty() && key.len() <= 64)
                .collect()
        })
        .unwrap_or_default()
}

fn resolve_media(keys: &[String], includes: &Value) -> Vec<Media> {
    let Some(rows) = includes.get("media").and_then(|value| value.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for key in keys {
        let Some(item) = rows
            .iter()
            .find(|row| row.get("media_key").and_then(|value| value.as_str()) == Some(key.as_str()))
        else {
            continue;
        };
        if let Some(media) = media_from(item) {
            out.push(media);
        }
    }
    out
}

fn media_from(item: &Value) -> Option<Media> {
    let kind_raw = item.get("type").and_then(|value| value.as_str()).unwrap_or("");
    let alt = item
        .get("alt_text")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| cap_text(text, 400));
    let preview = item
        .get("preview_image_url")
        .and_then(|value| value.as_str())
        .and_then(safe_media_url);
    match kind_raw {
        "photo" => {
            let url = item
                .get("url")
                .and_then(|value| value.as_str())
                .and_then(safe_media_url)?;
            Some(Media {
                kind: MediaKind::Photo,
                url: Some(url),
                preview_url: preview,
                alt,
            })
        }
        "animated_gif" | "video" | "audio" => {
            let play = best_variant(item);
            let audio_only = play.as_ref().is_some_and(|play| play.audio_only) || kind_raw == "audio";
            let url = play.and_then(|play| play.url);
            if url.is_none() && preview.is_none() {
                return None;
            }
            let kind = if audio_only {
                MediaKind::Audio
            } else if kind_raw == "animated_gif" {
                MediaKind::AnimatedGif
            } else {
                MediaKind::Video
            };
            Some(Media {
                kind,
                url,
                preview_url: preview,
                alt,
            })
        }
        _ => None,
    }
}

struct Playable {
    url: Option<String>,
    audio_only: bool,
}

fn best_variant(item: &Value) -> Option<Playable> {
    let variants = item.get("variants")?.as_array()?;
    let mut best_video: Option<(i64, String)> = None;
    let mut best_audio: Option<(i64, String)> = None;
    for variant in variants {
        let content = variant
            .get("content_type")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let Some(url) = variant
            .get("url")
            .and_then(|value| value.as_str())
            .and_then(safe_media_url)
        else {
            continue;
        };
        let rate = variant
            .get("bit_rate")
            .and_then(|value| value.as_i64())
            .unwrap_or(0);
        if content == "video/mp4" {
            if best_video.as_ref().map(|(best, _)| rate >= *best).unwrap_or(true) {
                best_video = Some((rate, url));
            }
        } else if content.starts_with("audio/") {
            if best_audio.as_ref().map(|(best, _)| rate >= *best).unwrap_or(true) {
                best_audio = Some((rate, url));
            }
        }
    }
    if let Some((_, url)) = best_video {
        return Some(Playable {
            url: Some(url),
            audio_only: false,
        });
    }
    best_audio.map(|(_, url)| Playable {
        url: Some(url),
        audio_only: true,
    })
}

fn safe_media_url(raw: &str) -> Option<String> {
    let url = Url::parse(raw.trim()).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    if host == "twimg.com" || host.ends_with(".twimg.com") {
        Some(url.to_string())
    } else {
        None
    }
}

fn safe_https_page(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw.trim()) else {
        return false;
    };
    url.scheme() == "https" && url.host_str().is_some() && url.username().is_empty()
}

fn post_url(handle: Option<&str>, id: &str) -> String {
    match handle {
        Some(handle) => format!("https://x.com/{handle}/status/{id}"),
        None => format!("https://x.com/i/status/{id}"),
    }
}

fn parse_token(body: &str) -> Result<TokenSet, ()> {
    let value: Value = serde_json::from_str(body.trim()).map_err(|_| ())?;
    if value.get("error").is_some() {
        return Err(());
    }
    let access = value
        .get("access_token")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .trim();
    if access.is_empty() || access.len() > 4096 || access.chars().any(char::is_whitespace) {
        return Err(());
    }
    let refresh = value
        .get("refresh_token")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|text| !text.is_empty() && text.len() <= 4096 && !text.chars().any(char::is_whitespace))
        .map(str::to_string);
    let expires_in = value
        .get("expires_in")
        .and_then(|item| item.as_i64())
        .filter(|seconds| *seconds > 0 && *seconds < 60 * 60 * 24 * 30);
    Ok(TokenSet {
        access_token: access.to_string(),
        refresh_token: refresh,
        expires_in,
    })
}

fn parse_me(body: &str) -> Result<(String, String, String), super::SourceError> {
    let value: Value = serde_json::from_str(body.trim()).map_err(|_| {
        super::SourceError::Message("X account response was not JSON.".into())
    })?;
    let data = value.get("data").unwrap_or(&value);
    let id = data.get("id").and_then(|item| item.as_str()).unwrap_or("");
    if !digits_ok(id) {
        return Err(super::SourceError::Message(
            "X did not return an account id.".into(),
        ));
    }
    let username = data
        .get("username")
        .and_then(|item| item.as_str())
        .and_then(clean_handle)
        .unwrap_or_default();
    let name = data
        .get("name")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .unwrap_or("");
    Ok((id.to_string(), username, cap_text(name, 80)))
}

fn authorization_url(client_id: &str, state: &str, challenge: &str) -> Result<String, super::SourceError> {
    if !valid_client_id(client_id) {
        return Err(super::SourceError::Message(
            "Enter the X app client ID from the developer portal. That is not an access token.".into(),
        ));
    }
    let mut url = Url::parse(AUTHORIZE_URL).expect("authorize url");
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("scope", "tweet.read users.read offline.access")
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256");
    let text = url.to_string();
    if text.contains("client_secret") {
        return Err(super::SourceError::Message(
            "X sign-in link was not built.".into(),
        ));
    }
    Ok(text)
}

fn code_challenge(verifier: &str) -> String {
    b64url(Sha256::digest(verifier.as_bytes()).as_slice())
}

fn new_verifier() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn valid_client_id(value: &str) -> bool {
    let value = value.trim();
    (8..=128).contains(&value.len())
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~'))
}

fn required_client_id(source: &SourceConfig) -> Result<String, super::SourceError> {
    let id = param_str(source, "clientId").unwrap_or_default();
    if valid_client_id(&id) {
        Ok(id)
    } else {
        Err(super::SourceError::Message(
            "Enter the X app client ID from the developer portal. That is not an access token.".into(),
        ))
    }
}

fn max_results(source: &SourceConfig) -> u32 {
    param_u32(source, "limit").unwrap_or(20).clamp(5, 100)
}

fn param_str(source: &SourceConfig, key: &str) -> Option<String> {
    let value = source.params.get(key)?;
    let text = match value {
        Value::String(text) => text.trim().to_string(),
        Value::Number(number) => number.to_string(),
        _ => return None,
    };
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn param_u32(source: &SourceConfig, key: &str) -> Option<u32> {
    let value = source.params.get(key)?;
    match value {
        Value::Number(number) => number.as_u64().and_then(|n| u32::try_from(n).ok()),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn bind_callback(port: u16) -> Result<TcpListener, super::SourceError> {
    TcpListener::bind(("127.0.0.1", port)).map_err(|_| {
        super::SourceError::Message(format!(
            "Command Center could not listen on {REDIRECT_URI} for the X sign-in redirect. Close whatever is using that port. The X app callback URL has to be that address."
        ))
    })
}

fn accept_oauth_code(
    listener: TcpListener,
    expected_state: &str,
    timeout: Duration,
) -> Result<String, super::SourceError> {
    listener.set_nonblocking(true).map_err(|_| {
        super::SourceError::Message("X sign-in could not start.".into())
    })?;
    let deadline = Instant::now() + timeout;
    let mut hits = 0u32;
    while Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, addr)) => {
                hits += 1;
                if hits > 12 {
                    return Err(super::SourceError::Message(
                        "X sign-in got too many requests on the callback. Try again.".into(),
                    ));
                }
                if !addr.ip().is_loopback() {
                    let _ = write_html(
                        &mut stream,
                        403,
                        "Forbidden",
                        "This sign-in only accepts a local callback.",
                    );
                    continue;
                }
                stream.set_nonblocking(false).ok();
                let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
                let request = read_request(&mut stream).unwrap_or_default();
                match code_from_request(&request, expected_state) {
                    Ok(None) => {
                        let _ = write_html(&mut stream, 404, "Not found", "Not found.");
                    }
                    Ok(Some(code)) => {
                        let _ = write_html(
                            &mut stream,
                            200,
                            "OK",
                            "Signed in to X. You can close this tab and return to Command Center.",
                        );
                        return Ok(code);
                    }
                    Err(message) => {
                        let _ = write_html(&mut stream, 400, "Bad request", &message);
                        return Err(super::SourceError::Message(message));
                    }
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(30));
            }
            Err(_) => {
                return Err(super::SourceError::Message(
                    "X sign-in callback failed. Try again.".into(),
                ));
            }
        }
    }
    Err(super::SourceError::Message(
        "X sign-in timed out. Try again.".into(),
    ))
}

fn code_from_request(request: &str, expected_state: &str) -> Result<Option<String>, String> {
    let line = request.lines().next().unwrap_or("").trim();
    let Some(target) = line
        .strip_prefix("GET ")
        .and_then(|rest| rest.split_whitespace().next())
    else {
        return Err("X sign-in callback was not a browser request.".into());
    };
    let (path, query) = split_target(target);
    if path == "/favicon.ico" || (path != "/callback" && path != "/callback/") {
        return Ok(None);
    }
    if query_get(query, "error").as_deref() == Some("access_denied") {
        return Err("X sign-in was canceled.".into());
    }
    if query_get(query, "error").is_some() {
        return Err("X sign-in was not completed.".into());
    }
    if query_get(query, "state").as_deref().unwrap_or("") != expected_state {
        return Err("X sign-in did not match this computer. Try again.".into());
    }
    let code = query_get(query, "code").unwrap_or_default();
    if code.is_empty()
        || code.len() > 512
        || code.chars().any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return Err("X sign-in did not return a code. Try again.".into());
    }
    Ok(Some(code))
}

fn split_target(target: &str) -> (&str, &str) {
    let path_and_query = if let Some(rest) = target
        .strip_prefix("http://")
        .or_else(|| target.strip_prefix("https://"))
    {
        rest.find('/').map(|index| &rest[index..]).unwrap_or("/")
    } else {
        target
    };
    path_and_query.split_once('?').unwrap_or((path_and_query, ""))
}

fn query_get(query: &str, key: &str) -> Option<String> {
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned())
}

fn read_request(stream: &mut TcpStream) -> std::io::Result<String> {
    let mut collected = Vec::new();
    let mut buf = [0u8; 1024];
    while collected.len() < 8192 {
        let read = match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        collected.extend_from_slice(&buf[..read]);
        if collected.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&collected).into_owned())
}

fn write_html(stream: &mut TcpStream, status: u16, reason: &str, body: &str) -> std::io::Result<()> {
    let page = format!(
        "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Command Center</title></head><body style=\"margin:0;background:#0b0d10;color:#e8eaed;font-family:Segoe UI,sans-serif\"><main style=\"max-width:32rem;margin:12vh auto;padding:24px\"><p>{}</p></main></body></html>",
        escape_html(body)
    );
    let bytes = page.as_bytes();
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        bytes.len()
    );
    stream.write_all(header.as_bytes())?;
    stream.write_all(bytes)?;
    stream.flush()
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn http() -> Result<reqwest::blocking::Client, super::SourceError> {
    Ok(reqwest::blocking::Client::builder()
        .user_agent(
            "CommandCenter/0.1 (personal follow feed; +https://github.com/nlaero/CommandCenter)",
        )
        .timeout(Duration::from_secs(30))
        .build()?)
}

fn basic_header(client_id: &str, client_secret: &str) -> String {
    let raw = format!(
        "{}:{}",
        form_encode(client_id),
        form_encode(client_secret)
    );
    format!("Basic {}", b64_standard(raw.as_bytes()))
}

fn form_encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn token_form_body(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| format!("{}={}", form_encode(key), form_encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn api_message(status: u16, body: &str, token: &str, secret: &str) -> String {
    let trimmed = body.trim();
    let detail = serde_json::from_str::<Value>(trimmed)
        .ok()
        .and_then(|value| {
            value
                .get("detail")
                .and_then(|item| item.as_str())
                .map(str::to_string)
                .or_else(|| {
                    value
                        .get("title")
                        .and_then(|item| item.as_str())
                        .map(str::to_string)
                })
                .or_else(|| {
                    value
                        .pointer("/errors/0/message")
                        .or_else(|| value.pointer("/errors/0/detail"))
                        .and_then(|item| item.as_str())
                        .map(str::to_string)
                })
        })
        .unwrap_or_else(|| cap_text(trimmed, 180));
    if status == 403 {
        return "X refused the follow feed for this sign-in. The app needs the reverse chronological timeline.".into();
    }
    format!(
        "X HTTP {status}: {}",
        sanitize(&detail, secret, token)
    )
}

fn sanitize(text: &str, secret: &str, token: &str) -> String {
    let mut out = text.to_string();
    if secret.len() >= 4 {
        out = out.replace(secret, "[redacted]");
    }
    if token.len() >= 8 {
        out = out.replace(token, "[redacted]");
    }
    out
}

fn session_usable(session: &Session) -> bool {
    !session.access_token.is_empty() && digits_ok(&session.user_id) && valid_client_id(&session.client_id)
}

fn session_stale(session: &Session) -> bool {
    session.expires_at == 0 || chrono::Utc::now().timestamp() + 60 >= session.expires_at
}

fn expiry_at(expires_in: Option<i64>) -> i64 {
    let seconds = expires_in.unwrap_or(7200).clamp(30, 60 * 60 * 24 * 7);
    chrono::Utc::now().timestamp() + seconds - 30
}

fn account_from(session: &Session) -> Account {
    Account {
        signed_in: true,
        username: nonempty(&session.username),
        name: nonempty(&session.name),
    }
}

fn signed_out() -> Account {
    Account {
        signed_in: false,
        username: None,
        name: None,
    }
}

fn nonempty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn load_session() -> Result<Option<Session>, super::SourceError> {
    let Some(access_token) = secret_nonempty(ACCESS)? else {
        return Ok(None);
    };
    Ok(Some(Session {
        access_token,
        refresh_token: secret_nonempty(REFRESH)?.unwrap_or_default(),
        expires_at: secret_nonempty(EXPIRES)?
            .and_then(|value| value.parse().ok())
            .unwrap_or(0),
        user_id: secret_nonempty(USER_ID)?.unwrap_or_default(),
        username: secret_nonempty(USERNAME)?.unwrap_or_default(),
        name: secret_nonempty(NAME)?.unwrap_or_default(),
        client_id: secret_nonempty(CLIENT)?.unwrap_or_default(),
    }))
}

fn store_session(session: &Session) -> Result<(), super::SourceError> {
    let saved = (|| {
        put_secret(ACCESS, &session.access_token)?;
        put_secret(REFRESH, &session.refresh_token)?;
        put_secret(EXPIRES, &session.expires_at.to_string())?;
        put_secret(USER_ID, &session.user_id)?;
        put_secret(USERNAME, &session.username)?;
        put_secret(NAME, &session.name)?;
        put_secret(CLIENT, &session.client_id)?;
        Ok(())
    })();
    if saved.is_err() {
        let _ = clear_session();
    }
    saved
}

fn clear_session() -> Result<(), super::SourceError> {
    for name in [ACCESS, REFRESH, EXPIRES, USER_ID, USERNAME, NAME, CLIENT] {
        secrets::delete_secret(name)?;
    }
    Ok(())
}

fn put_secret(name: &str, value: &str) -> Result<(), super::SourceError> {
    secrets::set_secret(name, value)?;
    Ok(())
}

fn secret_nonempty(name: &str) -> Result<Option<String>, super::SourceError> {
    Ok(secrets::get_secret(name)?
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}

fn client_secret() -> Result<Option<String>, super::SourceError> {
    secret_nonempty(CLIENT_SECRET)
}

fn inflight() -> std::sync::MutexGuard<'static, Option<Inflight>> {
    INFLIGHT.lock().unwrap_or_else(|err| err.into_inner())
}

fn digits_ok(value: &str) -> bool {
    !value.is_empty() && value.len() <= 32 && value.chars().all(|ch| ch.is_ascii_digit())
}

fn clean_handle(handle: &str) -> Option<String> {
    let handle = handle.trim().trim_start_matches('@');
    if (1..=15).contains(&handle.len())
        && handle
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    {
        Some(handle.to_string())
    } else {
        None
    }
}

fn cap_text(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        out.push('…');
    }
    out
}

fn b64url(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    encode_b64(bytes, TABLE, false)
}

fn b64_standard(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    encode_b64(bytes, TABLE, true)
}

fn encode_b64(bytes: &[u8], table: &[u8], pad: bool) -> String {
    let mut out = String::new();
    let mut index = 0;
    while index + 3 <= bytes.len() {
        let n = ((bytes[index] as u32) << 16)
            | ((bytes[index + 1] as u32) << 8)
            | bytes[index + 2] as u32;
        out.push(table[((n >> 18) & 63) as usize] as char);
        out.push(table[((n >> 12) & 63) as usize] as char);
        out.push(table[((n >> 6) & 63) as usize] as char);
        out.push(table[(n & 63) as usize] as char);
        index += 3;
    }
    if index < bytes.len() {
        let remain = bytes.len() - index;
        let mut n = (bytes[index] as u32) << 16;
        if remain == 2 {
            n |= (bytes[index + 1] as u32) << 8;
        }
        out.push(table[((n >> 18) & 63) as usize] as char);
        out.push(table[((n >> 12) & 63) as usize] as char);
        if remain == 2 {
            out.push(table[((n >> 6) & 63) as usize] as char);
        }
        if pad {
            if remain == 1 {
                out.push('=');
            }
            out.push('=');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pkce_matches_the_rfc_vector() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            code_challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn authorize_url_has_no_client_secret() {
        let url = authorization_url(
            "my-client-id",
            "state-1",
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        )
        .unwrap();
        assert!(url.contains("client_id=my-client-id"));
        assert!(url.contains("redirect_uri="));
        assert!(url.contains("8737"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("tweet.read"));
        assert!(url.contains("offline.access"));
        assert!(!url.contains("client_secret"));
        assert!(!url.contains("super-secret-value"));
        assert!(authorization_url("short", "s", "c").is_err());
        assert!(authorization_url(&"a".repeat(200), "s", "c").is_err());
    }

    #[test]
    fn token_body_keeps_the_secret_in_the_header_only() {
        let body = token_form_body(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", "refresh-token-value"),
            ("client_id", "my-client-id"),
        ]);
        assert!(!body.contains("super-secret-value"));
        assert!(body.contains("client_id=my-client-id"));
        let header = basic_header("my-client-id", "super-secret-value");
        assert!(header.starts_with("Basic "));
        assert!(!header.contains("super-secret-value"));
        assert!(!header.contains("my-client-id"));
    }

    #[test]
    fn errors_strip_tokens() {
        let shown = sanitize(
            "failed bearer super-secret-value and access-token-value",
            "super-secret-value",
            "access-token-value",
        );
        assert!(!shown.contains("super-secret-value"), "{shown}");
        assert!(!shown.contains("access-token-value"), "{shown}");
        assert!(shown.contains("[redacted]"));
    }

    #[test]
    fn callback_checks_state_and_does_not_echo_the_code() {
        let ok = code_from_request("GET /callback?code=abc123&state=s1 HTTP/1.1\r\n", "s1").unwrap();
        assert_eq!(ok.as_deref(), Some("abc123"));
        let mismatch =
            code_from_request("GET /callback?code=abc123&state=nope HTTP/1.1\r\n", "s1").unwrap_err();
        assert!(!mismatch.contains("abc123"), "{mismatch}");
        assert!(mismatch.contains("did not match"));
        let denied = code_from_request(
            "GET /callback?error=access_denied&state=s1 HTTP/1.1\r\n",
            "s1",
        )
        .unwrap_err();
        assert!(denied.contains("canceled"));
        assert!(code_from_request("GET /favicon.ico HTTP/1.1\r\n", "s1")
            .unwrap()
            .is_none());
        let absolute = code_from_request(
            "GET http://127.0.0.1:8737/callback?code=from-abs&state=s1 HTTP/1.1\r\n",
            "s1",
        )
        .unwrap();
        assert_eq!(absolute.as_deref(), Some("from-abs"));
    }

    #[test]
    fn callback_listener_returns_the_code() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            accept_oauth_code(listener, "state-1", Duration::from_secs(3))
        });
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let favicon = client
            .get(format!("http://127.0.0.1:{port}/favicon.ico"))
            .send()
            .unwrap();
        assert_eq!(favicon.status(), 404);
        let response = client
            .get(format!(
                "http://127.0.0.1:{port}/callback?state=state-1&code=live-code"
            ))
            .send()
            .unwrap();
        let page = response.text().unwrap();
        assert!(page.contains("Signed in to X"), "{page}");
        assert!(!page.contains("live-code"), "{page}");
        assert_eq!(handle.join().unwrap().unwrap(), "live-code");
    }

    #[test]
    fn timeline_keeps_followed_posts_and_playable_media() {
        let body = json!({
            "data": [
                {
                    "id": "100",
                    "text": "RT truncated",
                    "author_id": "55",
                    "created_at": "2026-11-14T12:00:00.000Z",
                    "attachments": { "media_keys": ["m1"] },
                    "referenced_tweets": [{ "type": "retweeted", "id": "77" }]
                },
                {
                    "id": "101",
                    "text": "short",
                    "note_tweet": { "text": "the full note from someone you follow https://t.co/abc" },
                    "author_id": "56",
                    "created_at": "2026-11-14T11:00:00.000Z",
                    "entities": {
                        "urls": [{
                            "url": "https://t.co/abc",
                            "expanded_url": "https://example.com/story"
                        }]
                    },
                    "attachments": { "media_keys": ["m2", "m3", "m4"] }
                }
            ],
            "includes": {
                "users": [
                    { "id": "55", "name": "Reposter", "username": "repost" },
                    { "id": "56", "name": "Ada Lovelace", "username": "ada" },
                    { "id": "9", "name": "Original", "username": "orig" }
                ],
                "tweets": [{
                    "id": "77",
                    "text": "original post from a followed account",
                    "author_id": "9",
                    "attachments": { "media_keys": ["m1"] }
                }],
                "media": [
                    {
                        "media_key": "m1",
                        "type": "video",
                        "preview_image_url": "https://pbs.twimg.com/preview.jpg",
                        "alt_text": "a clip",
                        "variants": [
                            { "bit_rate": 256000, "content_type": "video/mp4", "url": "https://video.twimg.com/low.mp4" },
                            { "bit_rate": 832000, "content_type": "video/mp4", "url": "https://video.twimg.com/high.mp4?tag=12" },
                            { "content_type": "application/x-mpegURL", "url": "https://video.twimg.com/pl.m3u8" },
                            { "content_type": "video/mp4", "url": "http://evil.example/steal.mp4" }
                        ]
                    },
                    {
                        "media_key": "m2",
                        "type": "photo",
                        "url": "https://pbs.twimg.com/media/pic.jpg",
                        "alt_text": "photo"
                    },
                    {
                        "media_key": "m3",
                        "type": "video",
                        "variants": [
                            { "content_type": "audio/mp4", "url": "https://video.twimg.com/voice.mp4" }
                        ]
                    },
                    {
                        "media_key": "m4",
                        "type": "photo",
                        "url": "https://evil.example/pic.jpg"
                    }
                ]
            }
        });
        let posts = posts_from_timeline(&body);
        assert_eq!(posts.len(), 2);
        assert_eq!(posts[0].text, "original post from a followed account");
        assert_eq!(posts[0].author_handle.as_deref(), Some("orig"));
        assert_eq!(posts[0].reposted_by.as_deref(), Some("repost"));
        assert_eq!(posts[0].url, "https://x.com/orig/status/77");
        assert_eq!(posts[0].media.len(), 1);
        assert_eq!(posts[0].media[0].kind, MediaKind::Video);
        assert_eq!(
            posts[0].media[0].url.as_deref(),
            Some("https://video.twimg.com/high.mp4?tag=12")
        );
        assert!(posts[0].text.contains("followed"));
        assert!(posts[1].text.starts_with("the full note"));
        assert!(posts[1].text.contains("https://example.com/story"));
        assert!(!posts[1].text.contains("t.co"));
        assert_eq!(posts[1].media.len(), 2);
        assert_eq!(posts[1].media[0].kind, MediaKind::Photo);
        assert_eq!(posts[1].media[1].kind, MediaKind::Audio);
        assert!(posts.iter().all(|post| post
            .media
            .iter()
            .all(|media| media.url.as_deref().unwrap_or("").starts_with("https://"))));
    }

    #[test]
    fn limit_stays_inside_the_timeline_window() {
        let mut source = SourceConfig {
            type_id: "x.follow".into(),
            params: Default::default(),
            refresh: None,
            secrets: vec![],
            enabled: true,
            draft: false,
        };
        assert_eq!(max_results(&source), 20);
        source.params.insert("limit".into(), json!(2));
        assert_eq!(max_results(&source), 5);
        source.params.insert("limit".into(), json!(500));
        assert_eq!(max_results(&source), 100);
        source.params.insert("clientId".into(), json!("my-client-id"));
        assert_eq!(required_client_id(&source).unwrap(), "my-client-id");
        source.params.insert("clientId".into(), json!("super secret token"));
        assert!(required_client_id(&source).is_err());
    }
}
