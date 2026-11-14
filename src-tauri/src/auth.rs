//! Auth-server client: register, login, refresh, logout, and `/auth/me`.
//!
//! Tokens live in the OS keyring (`command-center` service). Source API secrets
//! are never attached to these requests. Unit tests talk only to 127.0.0.1.
//! They refuse the tailnet address so `cargo test` cannot call the live server.

use crate::config::{AuthSettings, ConfigError, DEFAULT_AUTH_BASE_URL};
use crate::secrets;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, Error as TlsError, SignatureScheme};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::BufReader;
use std::net::IpAddr;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

const KEY_ACCESS: &str = "auth.access_token";
const KEY_REFRESH: &str = "auth.refresh_token";
const KEY_USERNAME: &str = "auth.username";
const KEY_USER_ID: &str = "auth.user_id";
const KEY_EXPIRES: &str = "auth.access_expires_at";

const MIN_PASSWORD: usize = 8;

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("{0}")]
    Message(String),
    #[error("{0}")]
    Unreachable(String),
    #[error("{message}")]
    Api {
        status: u16,
        code: String,
        message: String,
    },
}

impl AuthError {
    fn unreachable(detail: impl Into<String>) -> Self {
        let detail = detail.into();
        let message = if detail.is_empty() {
            "auth-server unreachable. Check the server URL and that this computer can reach it."
                .into()
        } else {
            format!(
                "auth-server unreachable. Check the server URL and that this computer can reach it. ({detail})"
            )
        };
        Self::Unreachable(message)
    }

    pub fn is_unreachable(&self) -> bool {
        matches!(self, Self::Unreachable(_))
    }

    fn is_rejected(&self) -> bool {
        match self {
            Self::Api { status, code, .. } => {
                *status == 401 || code == "invalid_token" || code == "invalid_credentials"
            }
            _ => false,
        }
    }

    #[cfg(test)]
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Api { code, .. } => Some(code.as_str()),
            _ => None,
        }
    }
}

fn friendly_code(code: &str) -> String {
    match code {
        "invalid_credentials" => "Username or password is incorrect.".into(),
        "invalid_token" => "Session expired. Sign in again.".into(),
        "rate_limited" => "Too many attempts. Wait a few minutes and try again.".into(),
        "username_taken" => "That username is already taken.".into(),
        "weak_password" => "Password must be at least 8 characters.".into(),
        "registration_disabled" => "Registration is turned off on this auth-server.".into(),
        "bad_request" => "Check the username and password and try again.".into(),
        "internal" => "auth-server had a problem. Try again in a moment.".into(),
        other => format!("auth-server rejected the request ({other})."),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub id: String,
    pub username: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub enabled: bool,
    pub base_url: String,
    pub allow_insecure_http: bool,
    pub signed_in: bool,
    pub offline: bool,
    pub user: Option<AuthUser>,
    pub suggested_username: Option<String>,
    pub reachable: Option<bool>,
    pub status_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthProbe {
    pub reachable: bool,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
    user: AuthUser,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialBody<'a> {
    username: &'a str,
    password: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RefreshBody<'a> {
    refresh_token: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogoutBody<'a> {
    refresh_token: &'a str,
}

pub trait TokenStore {
    fn get(&self, key: &str) -> Result<Option<String>, AuthError>;
    fn set(&self, key: &str, value: &str) -> Result<(), AuthError>;
    fn delete(&self, key: &str) -> Result<(), AuthError>;
}

pub struct KeyringStore;

impl TokenStore for KeyringStore {
    fn get(&self, key: &str) -> Result<Option<String>, AuthError> {
        secrets::get_secret(key)
            .map(|value| value.filter(|v| !v.trim().is_empty()))
            .map_err(config_err)
    }

    fn set(&self, key: &str, value: &str) -> Result<(), AuthError> {
        secrets::set_secret(key, value).map_err(config_err)
    }

    fn delete(&self, key: &str) -> Result<(), AuthError> {
        secrets::delete_secret(key).map_err(config_err)
    }
}

fn config_err(err: ConfigError) -> AuthError {
    AuthError::Message(err.to_string())
}

pub struct AuthService<S: TokenStore> {
    store: S,
}

impl AuthService<KeyringStore> {
    pub fn keyring() -> Self {
        Self {
            store: KeyringStore,
        }
    }
}

impl<S: TokenStore> AuthService<S> {
    #[cfg(test)]
    pub fn with_store(store: S) -> Self {
        Self { store }
    }

    pub fn session(&self, settings: &AuthSettings) -> AuthSession {
        let _guard = token_lock();
        self.session_locked(settings)
    }

    /// Authenticated JSON call. Refreshes a stale access token first.
    /// Must not be called while `session` already holds the token lock.
    pub(crate) fn authorized(
        &self,
        settings: &AuthSettings,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<(u16, Option<Value>), AuthError> {
        let _guard = token_lock();
        let settings = normalize_settings(settings.clone())?;
        let token = self.ensure_access_locked(&settings)?;
        self.request(&settings, method, path, body, Some(&token))
    }

    pub(crate) fn stored_user_id(&self) -> Option<String> {
        self.store_get(KEY_USER_ID)
    }

    #[cfg(test)]
    pub fn seed_session(&self, user_id: &str, username: &str, access: &str) {
        self.store.set(KEY_USER_ID, user_id).expect("user id");
        self.store.set(KEY_USERNAME, username).expect("username");
        self.store.set(KEY_ACCESS, access).expect("access");
        self.store
            .set(KEY_EXPIRES, &(now_unix() + 900).to_string())
            .expect("expiry");
    }

    fn ensure_access_locked(&self, settings: &AuthSettings) -> Result<String, AuthError> {
        if self.access_fresh() {
            if let Some(token) = self.store_get(KEY_ACCESS) {
                return Ok(token);
            }
        }
        if let Some(refresh) = self.store_get(KEY_REFRESH) {
            let tokens = self.refresh_tokens(settings, &refresh)?;
            self.persist_tokens(&tokens)?;
            return Ok(tokens.access_token);
        }
        Err(AuthError::Message(
            "Sign in before syncing the board.".into(),
        ))
    }

    pub fn probe(&self, settings: &AuthSettings) -> AuthProbe {
        let _guard = token_lock();
        self.probe_locked(settings)
    }

    /// Normalize settings. If the origin changed, revoke the old refresh (best effort)
    /// and drop local tokens so they are not sent to a different server.
    pub fn prepare_settings(
        &self,
        previous: &AuthSettings,
        next: AuthSettings,
    ) -> Result<AuthSettings, AuthError> {
        let _guard = token_lock();
        let mut normalized = normalize_settings(next)?;
        // The board always uses an account. A client cannot turn sign-in off.
        normalized.enabled = true;
        let old_origin = canonical_or_raw(&previous.base_url);
        if old_origin != normalized.base_url {
            if let Ok(old) = normalize_settings(previous.clone()) {
                let _ = self.revoke_locked(&old);
            }
            self.clear_tokens()?;
        }
        Ok(normalized)
    }

    pub fn register(
        &self,
        settings: &AuthSettings,
        username: &str,
        password: &str,
    ) -> Result<AuthSession, AuthError> {
        let _guard = token_lock();
        let settings = self.require_enabled(settings)?;
        let username = check_username(username)?;
        if password.len() < MIN_PASSWORD {
            return Err(AuthError::Api {
                status: 400,
                code: "weak_password".into(),
                message: friendly_code("weak_password"),
            });
        }
        let tokens = self.post_json(
            &settings,
            reqwest::Method::POST,
            "/auth/register",
            &CredentialBody {
                username: &username,
                password,
            },
            None,
        )?;
        let tokens = parse_tokens(tokens.0, tokens.1)?;
        self.persist_tokens(&tokens)?;
        Ok(self.signed_in(&settings, tokens.user, false, Some(true), None))
    }

    pub fn login(
        &self,
        settings: &AuthSettings,
        username: &str,
        password: &str,
    ) -> Result<AuthSession, AuthError> {
        let _guard = token_lock();
        let settings = self.require_enabled(settings)?;
        let username = check_username(username)?;
        if password.is_empty() {
            return Err(AuthError::Message("Enter a password.".into()));
        }
        let tokens = self.post_json(
            &settings,
            reqwest::Method::POST,
            "/auth/login",
            &CredentialBody {
                username: &username,
                password,
            },
            None,
        )?;
        let tokens = parse_tokens(tokens.0, tokens.1)?;
        self.persist_tokens(&tokens)?;
        Ok(self.signed_in(&settings, tokens.user, false, Some(true), None))
    }

    pub fn logout(&self, settings: &AuthSettings) -> Result<AuthSession, AuthError> {
        let _guard = token_lock();
        let settings = normalize_settings(settings.clone()).unwrap_or_else(|_| settings.clone());
        let warning = match self.revoke_locked(&settings) {
            Ok(()) => None,
            Err(err) if err.is_unreachable() => Some(
                "Signed out on this computer. auth-server was unreachable, so the refresh token may still be valid there until it expires.".into(),
            ),
            Err(_) => None,
        };
        self.clear_tokens()?;
        Ok(self.signed_out(&settings, warning, None))
    }

    fn require_enabled(&self, settings: &AuthSettings) -> Result<AuthSettings, AuthError> {
        let settings = normalize_settings(settings.clone())?;
        if !settings.enabled {
            return Err(AuthError::Message(
                "Sign-in is turned off for this computer. Turn on Require sign-in in Settings → Account.".into(),
            ));
        }
        Ok(settings)
    }

    fn session_locked(&self, settings: &AuthSettings) -> AuthSession {
        let settings = match normalize_settings(settings.clone()) {
            Ok(settings) => settings,
            Err(err) => {
                return self.signed_out(settings, Some(err.to_string()), Some(false));
            }
        };
        if !settings.enabled {
            return self.signed_out(&settings, None, None);
        }

        if let Some(refresh) = self.store_get(KEY_REFRESH) {
            match self.refresh_tokens(&settings, &refresh) {
                Ok(tokens) => {
                    if let Err(err) = self.persist_tokens(&tokens) {
                        return self.signed_out(&settings, Some(err.to_string()), Some(true));
                    }
                    return self.signed_in(&settings, tokens.user, false, Some(true), None);
                }
                Err(err) if err.is_unreachable() => {
                    if self.access_fresh() {
                        if let Some(user) = self.stored_user() {
                            return self.signed_in(
                                &settings,
                                user,
                                true,
                                Some(false),
                                Some(err.to_string()),
                            );
                        }
                    }
                    return self.signed_out(&settings, Some(err.to_string()), Some(false));
                }
                Err(err) if err.is_rejected() => {
                    let _ = self.clear_tokens();
                    return self.signed_out(&settings, Some(err.to_string()), Some(true));
                }
                Err(err) => {
                    return self.signed_out(&settings, Some(err.to_string()), None);
                }
            }
        }

        if self.access_fresh() {
            if let Some(access) = self.store_get(KEY_ACCESS) {
                match self.current_user(&settings, &access) {
                    Ok(user) => {
                        let _ = self.store.set(KEY_USERNAME, &user.username);
                        let _ = self.store.set(KEY_USER_ID, &user.id);
                        return self.signed_in(&settings, user, false, Some(true), None);
                    }
                    Err(err) if err.is_unreachable() => {
                        if let Some(user) = self.stored_user() {
                            return self.signed_in(
                                &settings,
                                user,
                                true,
                                Some(false),
                                Some(err.to_string()),
                            );
                        }
                        return self.signed_out(&settings, Some(err.to_string()), Some(false));
                    }
                    Err(err) if err.is_rejected() => {
                        let _ = self.clear_tokens();
                        return self.signed_out(&settings, Some(err.to_string()), Some(true));
                    }
                    Err(err) => {
                        return self.signed_out(&settings, Some(err.to_string()), None);
                    }
                }
            }
        }

        let probe = self.probe_locked(&settings);
        self.signed_out(
            &settings,
            if probe.reachable {
                None
            } else {
                Some(probe.message.clone())
            },
            Some(probe.reachable),
        )
    }

    fn probe_locked(&self, settings: &AuthSettings) -> AuthProbe {
        let settings = match normalize_settings(settings.clone()) {
            Ok(settings) => settings,
            Err(err) => {
                return AuthProbe {
                    reachable: false,
                    message: err.to_string(),
                };
            }
        };
        match self.request(&settings, reqwest::Method::GET, "/health", None, None) {
            Ok((200, Some(body))) if body.get("ok").and_then(|v| v.as_bool()) == Some(true) => {
                AuthProbe {
                    reachable: true,
                    message: "auth-server reachable".into(),
                }
            }
            Ok((status, _)) => AuthProbe {
                reachable: false,
                message: format!("auth-server replied HTTP {status} on /health."),
            },
            Err(err) => AuthProbe {
                reachable: false,
                message: err.to_string(),
            },
        }
    }

    fn refresh_tokens(
        &self,
        settings: &AuthSettings,
        refresh: &str,
    ) -> Result<TokenResponse, AuthError> {
        let (status, body) = self.post_json(
            settings,
            reqwest::Method::POST,
            "/auth/refresh",
            &RefreshBody {
                refresh_token: refresh,
            },
            None,
        )?;
        parse_tokens(status, body)
    }

    fn current_user(&self, settings: &AuthSettings, access: &str) -> Result<AuthUser, AuthError> {
        let (status, body) = self.request(
            settings,
            reqwest::Method::GET,
            "/auth/me",
            None,
            Some(access),
        )?;
        if status != 200 {
            return Err(error_from(status, body.as_ref()));
        }
        let body = body
            .ok_or_else(|| AuthError::Message("auth-server returned an empty profile.".into()))?;
        serde_json::from_value(body)
            .map_err(|_| AuthError::Message("auth-server returned an unexpected profile.".into()))
    }

    fn revoke_locked(&self, settings: &AuthSettings) -> Result<(), AuthError> {
        let Some(refresh) = self.store_get(KEY_REFRESH) else {
            return Ok(());
        };
        let (status, body) = self.post_json(
            settings,
            reqwest::Method::POST,
            "/auth/logout",
            &LogoutBody {
                refresh_token: &refresh,
            },
            None,
        )?;
        if status == 204 || status == 200 || status == 401 {
            return Ok(());
        }
        Err(error_from(status, body.as_ref()))
    }

    fn post_json<B: Serialize>(
        &self,
        settings: &AuthSettings,
        method: reqwest::Method,
        path: &str,
        body: &B,
        bearer: Option<&str>,
    ) -> Result<(u16, Option<Value>), AuthError> {
        let value = serde_json::to_value(body)
            .map_err(|err| AuthError::Message(format!("could not encode request: {err}")))?;
        self.request(settings, method, path, Some(value), bearer)
    }

    fn request(
        &self,
        settings: &AuthSettings,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        bearer: Option<&str>,
    ) -> Result<(u16, Option<Value>), AuthError> {
        let origin = check_url(&settings.base_url, settings.allow_insecure_http)?;
        reject_tailnet_in_tests(&origin);
        let url = format!("{}{}", origin.as_str().trim_end_matches('/'), path);
        let client = build_client(settings)?;
        let mut req = client.request(method, &url);
        if let Some(token) = bearer {
            req = req.bearer_auth(token);
        }
        if let Some(body) = body {
            req = req.json(&body);
        }
        let response = req.send().map_err(map_transport)?;
        let status = response.status().as_u16();
        let bytes = response.bytes().map_err(map_transport)?;
        if bytes.is_empty() {
            return Ok((status, None));
        }
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(value) => Ok((status, Some(value))),
            Err(_) if (200..300).contains(&status) => Err(AuthError::Message(
                "auth-server returned a response that was not JSON.".into(),
            )),
            Err(_) => Err(error_from(status, None)),
        }
    }

    fn persist_tokens(&self, tokens: &TokenResponse) -> Result<(), AuthError> {
        self.store.set(KEY_ACCESS, &tokens.access_token)?;
        self.store.set(KEY_REFRESH, &tokens.refresh_token)?;
        self.store.set(KEY_USER_ID, &tokens.user.id)?;
        self.store.set(KEY_USERNAME, &tokens.user.username)?;
        self.store.set(
            KEY_EXPIRES,
            &expires_at_from_ttl(tokens.expires_in).to_string(),
        )?;
        Ok(())
    }

    fn clear_tokens(&self) -> Result<(), AuthError> {
        self.store.delete(KEY_ACCESS)?;
        self.store.delete(KEY_REFRESH)?;
        self.store.delete(KEY_USER_ID)?;
        self.store.delete(KEY_EXPIRES)?;
        Ok(())
    }

    fn store_get(&self, key: &str) -> Option<String> {
        self.store.get(key).ok().flatten()
    }

    fn stored_user(&self) -> Option<AuthUser> {
        let id = self.store_get(KEY_USER_ID)?;
        let username = self.store_get(KEY_USERNAME)?;
        if id.is_empty() || username.is_empty() {
            return None;
        }
        Some(AuthUser { id, username })
    }

    fn access_fresh(&self) -> bool {
        let Some(raw) = self.store_get(KEY_EXPIRES) else {
            return false;
        };
        let Ok(exp) = raw.parse::<u64>() else {
            return false;
        };
        now_unix() < exp
    }

    fn signed_in(
        &self,
        settings: &AuthSettings,
        user: AuthUser,
        offline: bool,
        reachable: Option<bool>,
        status_message: Option<String>,
    ) -> AuthSession {
        AuthSession {
            enabled: settings.enabled,
            base_url: settings.base_url.clone(),
            allow_insecure_http: settings.allow_insecure_http,
            signed_in: true,
            offline,
            suggested_username: Some(user.username.clone()),
            user: Some(user),
            reachable,
            status_message,
        }
    }

    fn signed_out(
        &self,
        settings: &AuthSettings,
        status_message: Option<String>,
        reachable: Option<bool>,
    ) -> AuthSession {
        AuthSession {
            enabled: settings.enabled,
            base_url: settings.base_url.clone(),
            allow_insecure_http: settings.allow_insecure_http,
            signed_in: false,
            offline: false,
            user: None,
            suggested_username: self.store_get(KEY_USERNAME),
            reachable,
            status_message,
        }
    }
}

fn token_lock() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|err| err.into_inner())
}

pub fn normalize_settings(mut settings: AuthSettings) -> Result<AuthSettings, AuthError> {
    let raw = settings.base_url.trim();
    let raw = if raw.is_empty() {
        DEFAULT_AUTH_BASE_URL
    } else {
        raw
    };
    settings.base_url = canonical_url(&check_url(raw, settings.allow_insecure_http)?)?;
    settings.ca_file = settings
        .ca_file
        .take()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(pin) = settings.tls_pin_sha256.take() {
        let pin = pin.trim().to_string();
        if !pin.is_empty() {
            decode_pin(&pin)?;
            settings.tls_pin_sha256 = Some(pin);
        }
    }
    Ok(settings)
}

fn canonical_or_raw(raw: &str) -> String {
    normalize_settings(AuthSettings {
        base_url: raw.to_string(),
        ..AuthSettings::default()
    })
    .map(|settings| settings.base_url)
    .unwrap_or_else(|_| raw.trim().trim_end_matches('/').to_string())
}

fn check_username(username: &str) -> Result<String, AuthError> {
    let username = username.trim();
    if username.is_empty() {
        return Err(AuthError::Api {
            status: 400,
            code: "bad_request".into(),
            message: "Enter a username.".into(),
        });
    }
    Ok(username.to_string())
}

fn parse_tokens(status: u16, body: Option<Value>) -> Result<TokenResponse, AuthError> {
    if status != 200 {
        return Err(error_from(status, body.as_ref()));
    }
    let body = body.ok_or_else(|| {
        AuthError::Message("auth-server returned an empty token response.".into())
    })?;
    serde_json::from_value(body).map_err(|_| {
        AuthError::Message("auth-server returned an unexpected token response.".into())
    })
}

fn error_from(status: u16, body: Option<&Value>) -> AuthError {
    let code = body
        .and_then(|value| value.get("error"))
        .and_then(|value| value.as_str())
        .unwrap_or(if status == 401 {
            "invalid_token"
        } else {
            "bad_request"
        });
    AuthError::Api {
        status,
        message: friendly_code(code),
        code: code.to_string(),
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn expires_at_from_ttl(ttl: i64) -> u64 {
    let now = now_unix();
    if ttl <= 0 {
        return now.saturating_sub(1);
    }
    now.saturating_add(ttl as u64)
}

fn check_url(raw: &str, allow_insecure_http: bool) -> Result<Url, AuthError> {
    check_url_policy(raw, allow_insecure_http)
}

/// Plain HTTP is allowed on installed builds for:
/// - Tailscale `100.64.0.0/10` (and the Tailscale IPv6 prefix)
/// - private LAN `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
/// - loopback (`localhost`, `127.0.0.0/8`, `::1`)
///
/// Public hosts still require HTTPS. `allow_insecure_http` only adds a named
/// lab host (`.local` / `.lan`) or another non-public lab address such as
/// link-local. It never permits a public host.
fn check_url_policy(raw: &str, allow_insecure_http: bool) -> Result<Url, AuthError> {
    let url = Url::parse(raw.trim())
        .map_err(|_| AuthError::Message("Auth-server URL is not a valid URL.".into()))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AuthError::Message(
            "Auth-server URL must not include a username or password.".into(),
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(AuthError::Message(
            "Auth-server URL must not include a query or fragment.".into(),
        ));
    }
    let path = url.path();
    if path != "/" && !path.is_empty() {
        return Err(AuthError::Message(
            "Auth-server URL must be an origin, without a path.".into(),
        ));
    }
    match url.scheme() {
        "https" => Ok(url),
        "http" => {
            let host = url.host_str().unwrap_or("");
            if is_tailnet_host(host) || is_private_lan_host(host) || is_loopback_host(host) {
                warn_plain_http(&url);
                return Ok(url);
            }
            if !allow_insecure_http {
                return Err(AuthError::Message(
                    "Auth-server URL must be https:// for a public host. Plain HTTP is allowed for private LAN addresses (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), loopback, and Tailscale (100.64.0.0/10). Allow HTTP also covers a named lab host (.local or .lan).".into(),
                ));
            }
            if !is_lab_host(host) {
                return Err(AuthError::Message(
                    "Plain HTTP is only allowed for private LAN addresses, loopback, Tailscale, or a named lab host (.local or .lan) when Allow HTTP is on.".into(),
                ));
            }
            warn_plain_http(&url);
            Ok(url)
        }
        _ => Err(AuthError::Message(
            "Auth-server URL must start with https:// or http://.".into(),
        )),
    }
}

fn canonical_url(url: &Url) -> Result<String, AuthError> {
    let host = match url.host() {
        Some(url::Host::Ipv6(ip)) => format!("[{ip}]"),
        Some(_) => url
            .host_str()
            .ok_or_else(|| AuthError::Message("Auth-server URL is missing a host.".into()))?
            .to_string(),
        None => {
            return Err(AuthError::Message(
                "Auth-server URL is missing a host.".into(),
            ))
        }
    };
    if let Some(port) = url.port() {
        Ok(format!("{}://{host}:{port}", url.scheme()))
    } else {
        Ok(format!("{}://{host}", url.scheme()))
    }
}

fn warn_plain_http(url: &Url) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static ONCE: AtomicBool = AtomicBool::new(false);
    if ONCE.swap(true, Ordering::Relaxed) {
        return;
    }
    eprintln!(
        "command-center auth: plain HTTP ({url}). Allowed for a private LAN address, loopback, or the tailnet; do not use HTTP on a public network."
    );
}

fn is_tailnet_host(host: &str) -> bool {
    let host = host.trim_matches(|ch| ch == '[' || ch == ']');
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ipv4_in_cidr(ip, [100, 64, 0, 0], 10),
        Ok(IpAddr::V6(ip)) => {
            let octets = ip.octets();
            octets[0] == 0xfd
                && octets[1] == 0x7a
                && octets[2] == 0x11
                && octets[3] == 0x5c
                && octets[4] == 0xa1
                && octets[5] == 0xe0
        }
        Err(_) => false,
    }
}

fn is_private_lan_host(host: &str) -> bool {
    let host = host.trim_matches(|ch| ch == '[' || ch == ']');
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            ipv4_in_cidr(ip, [10, 0, 0, 0], 8)
                || ipv4_in_cidr(ip, [172, 16, 0, 0], 12)
                || ipv4_in_cidr(ip, [192, 168, 0, 0], 16)
        }
        _ => false,
    }
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_matches(|ch| ch == '[' || ch == ']');
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_loopback(),
        Ok(IpAddr::V6(ip)) => ip.is_loopback(),
        Err(_) => false,
    }
}

fn is_lab_host(host: &str) -> bool {
    if is_tailnet_host(host) || is_loopback_host(host) {
        return true;
    }
    let host = host.trim_matches(|ch| ch == '[' || ch == ']');
    let named = host.to_ascii_lowercase();
    if named.ends_with(".localhost") || named.ends_with(".local") || named.ends_with(".lan") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            ip.is_private()
                || ip.is_link_local()
                || ipv4_in_cidr(ip, [10, 0, 0, 0], 8)
                || ipv4_in_cidr(ip, [192, 168, 0, 0], 16)
                || ipv4_in_cidr(ip, [172, 16, 0, 0], 12)
        }
        Ok(IpAddr::V6(ip)) => ip.is_unique_local() || ip.is_loopback(),
        Err(_) => false,
    }
}

fn ipv4_in_cidr(ip: std::net::Ipv4Addr, base: [u8; 4], prefix: u32) -> bool {
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    (u32::from(ip) & mask)
        == (u32::from(std::net::Ipv4Addr::new(base[0], base[1], base[2], base[3])) & mask)
}

fn reject_tailnet_in_tests(url: &Url) {
    if cfg!(test) {
        let host = url.host_str().unwrap_or("");
        if is_tailnet_host(host) {
            panic!("refusing to contact a tailnet auth-server from tests ({url})");
        }
    }
}

fn map_transport(err: reqwest::Error) -> AuthError {
    let chain = error_chain(&err);
    if chain.to_ascii_lowercase().contains("tls pin") {
        return AuthError::Message(
            "auth-server certificate does not match the saved TLS pin.".into(),
        );
    }
    if err.is_timeout() || err.is_connect() || err.is_request() {
        return AuthError::unreachable(short_reason(&chain));
    }
    AuthError::Message(format!("auth-server request failed ({chain})"))
}

fn error_chain(err: &dyn std::error::Error) -> String {
    let mut parts = vec![err.to_string()];
    let mut source = err.source();
    while let Some(next) = source {
        parts.push(next.to_string());
        source = next.source();
    }
    parts.join(": ")
}

fn short_reason(chain: &str) -> String {
    if chain.len() > 180 {
        format!("{}…", &chain[..180])
    } else {
        chain.to_string()
    }
}

fn decode_pin(raw: &str) -> Result<[u8; 32], AuthError> {
    let hex: String = raw
        .chars()
        .filter(|ch| !ch.is_whitespace() && *ch != ':')
        .collect();
    if hex.len() != 64 || !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(AuthError::Message(
            "TLS pin must be a SHA-256 hex string (64 digits).".into(),
        ));
    }
    let mut out = [0u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).map_err(|_| {
            AuthError::Message("TLS pin must be a SHA-256 hex string (64 digits).".into())
        })?;
    }
    Ok(out)
}

fn pin_matches(der: &[u8], pin: &[u8; 32]) -> bool {
    if ct_eq(&sha256(der), pin) {
        return true;
    }
    if let Ok((_, cert)) = x509_parser::parse_x509_certificate(der) {
        let spki = cert.tbs_certificate.subject_pki.raw;
        if ct_eq(&sha256(spki), pin) {
            return true;
        }
    }
    false
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(bytes);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn ct_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right) {
        diff |= a ^ b;
    }
    diff == 0
}

fn build_client(settings: &AuthSettings) -> Result<reqwest::blocking::Client, AuthError> {
    if let Some(pin) = settings.tls_pin_sha256.as_deref() {
        let origin = check_url(&settings.base_url, settings.allow_insecure_http)?;
        if origin.scheme() != "https" {
            return Err(AuthError::Message(
                "A TLS pin only applies to an https:// auth-server URL.".into(),
            ));
        }
        let config = pinned_tls_config(pin, settings.ca_file.as_deref())?;
        return reqwest::blocking::Client::builder()
            .use_preconfigured_tls(config)
            .timeout(Duration::from_secs(12))
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("CommandCenter/0.1 (auth)")
            .build()
            .map_err(|err| AuthError::Message(format!("could not build auth client: {err}")));
    }

    let mut builder = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(12))
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("CommandCenter/0.1 (auth)");
    for cert in native_reqwest_certs() {
        builder = builder.add_root_certificate(cert);
    }
    if let Some(path) = settings.ca_file.as_deref() {
        let pem = fs::read(path).map_err(|err| {
            AuthError::Message(format!("could not read auth CA file {path}: {err}"))
        })?;
        let cert = reqwest::Certificate::from_pem(&pem).map_err(|err| {
            AuthError::Message(format!(
                "auth CA file {path} is not a PEM certificate: {err}"
            ))
        })?;
        builder = builder.add_root_certificate(cert);
    }
    builder
        .build()
        .map_err(|err| AuthError::Message(format!("could not build auth client: {err}")))
}

fn native_reqwest_certs() -> Vec<reqwest::Certificate> {
    rustls_native_certs::load_native_certs()
        .certs
        .into_iter()
        .filter_map(|cert| reqwest::Certificate::from_der(cert.as_ref()).ok())
        .collect()
}

fn pinned_tls_config(pin: &str, ca_file: Option<&str>) -> Result<rustls::ClientConfig, AuthError> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    for cert in rustls_native_certs::load_native_certs().certs {
        let _ = roots.add(cert);
    }
    if let Some(path) = ca_file {
        let pem = fs::read(path).map_err(|err| {
            AuthError::Message(format!("could not read auth CA file {path}: {err}"))
        })?;
        let mut reader = BufReader::new(pem.as_slice());
        let certs = rustls_pemfile::certs(&mut reader)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| {
                AuthError::Message(format!(
                    "auth CA file {path} is not a PEM certificate: {err}"
                ))
            })?;
        if certs.is_empty() {
            return Err(AuthError::Message(format!(
                "auth CA file {path} did not contain a certificate"
            )));
        }
        for cert in certs {
            roots.add(cert).map_err(|err| {
                AuthError::Message(format!("could not add auth CA certificate: {err}"))
            })?;
        }
    }
    let inner = rustls::client::WebPkiServerVerifier::builder(std::sync::Arc::new(roots))
        .build()
        .map_err(|err| AuthError::Message(format!("could not build TLS verifier: {err}")))?;
    let verifier = std::sync::Arc::new(PinVerifier {
        inner,
        pin: decode_pin(pin)?,
    });
    Ok(rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth())
}

#[derive(Debug)]
struct PinVerifier {
    inner: std::sync::Arc<dyn ServerCertVerifier>,
    pin: [u8; 32],
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        self.inner.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        )?;
        if !pin_matches(end_entity.as_ref(), &self.pin) {
            return Err(TlsError::General(
                "auth-server TLS pin did not match".into(),
            ));
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, HashMap};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::thread;

    #[derive(Clone, Default)]
    struct MemoryStore {
        values: Arc<Mutex<BTreeMap<String, String>>>,
    }

    impl TokenStore for MemoryStore {
        fn get(&self, key: &str) -> Result<Option<String>, AuthError> {
            Ok(self
                .values
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .get(key)
                .cloned())
        }

        fn set(&self, key: &str, value: &str) -> Result<(), AuthError> {
            self.values
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .insert(key.to_string(), value.to_string());
            Ok(())
        }

        fn delete(&self, key: &str) -> Result<(), AuthError> {
            self.values
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .remove(key);
            Ok(())
        }
    }

    #[derive(Default)]
    struct Fake {
        users: Mutex<Vec<(String, String, String)>>,
        refresh: Mutex<HashMap<String, (String, bool)>>,
        access: Mutex<HashMap<String, String>>,
        seen: Mutex<Vec<Seen>>,
    }

    struct Seen {
        path: String,
        body: String,
        authorization: String,
    }

    fn settings(base: &str) -> AuthSettings {
        AuthSettings {
            enabled: true,
            base_url: base.into(),
            allow_insecure_http: true,
            ca_file: None,
            tls_pin_sha256: None,
        }
    }

    fn spawn_fake() -> (String, Arc<Fake>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let fake = Arc::new(Fake::default());
        let serve = Arc::clone(&fake);
        thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut stream) = conn else { continue };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                if let Ok((_method, path, headers, body)) = read_http(&mut stream) {
                    let authorization = headers
                        .iter()
                        .find(|(key, _)| key == "authorization")
                        .map(|(_, value)| value.clone())
                        .unwrap_or_default();
                    serve.seen.lock().unwrap().push(Seen {
                        path: path.clone(),
                        body: String::from_utf8_lossy(&body).to_string(),
                        authorization,
                    });
                    let (status, payload) = dispatch(&serve, &_method, &path, &headers, &body);
                    let raw = payload.unwrap_or_default();
                    let reason = match status {
                        200 => "OK",
                        204 => "No Content",
                        400 => "Bad Request",
                        401 => "Unauthorized",
                        409 => "Conflict",
                        _ => "Error",
                    };
                    let head = format!(
                        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        raw.len()
                    );
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(&raw);
                }
            }
        });
        (format!("http://127.0.0.1:{port}"), fake)
    }

    fn dispatch(
        fake: &Fake,
        method: &str,
        path: &str,
        headers: &[(String, String)],
        body: &[u8],
    ) -> (u16, Option<Vec<u8>>) {
        let json: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
        match (method, path) {
            ("GET", "/health") => (
                200,
                Some(br#"{"ok":true,"service":"auth-server"}"#.to_vec()),
            ),
            ("POST", "/auth/register") => register(fake, &json),
            ("POST", "/auth/login") => login(fake, &json),
            ("POST", "/auth/refresh") => refresh(fake, &json),
            ("POST", "/auth/logout") => logout(fake, &json),
            ("GET", "/auth/me") => me(fake, headers),
            _ => (404, Some(br#"{"error":"bad_request"}"#.to_vec())),
        }
    }

    fn register(fake: &Fake, json: &Value) -> (u16, Option<Vec<u8>>) {
        let username = json.get("username").and_then(|v| v.as_str()).unwrap_or("");
        let password = json.get("password").and_then(|v| v.as_str()).unwrap_or("");
        if username.trim().is_empty() {
            return (400, Some(br#"{"error":"bad_request"}"#.to_vec()));
        }
        if password.len() < 8 {
            return (400, Some(br#"{"error":"weak_password"}"#.to_vec()));
        }
        let norm = username.trim().to_ascii_lowercase();
        let mut users = fake.users.lock().unwrap();
        if users.iter().any(|(_, _, existing)| existing == &norm) {
            return (409, Some(br#"{"error":"username_taken"}"#.to_vec()));
        }
        let id = format!("user-{}", users.len() + 1);
        users.push((id.clone(), username.trim().to_string(), norm));
        drop(users);
        (200, Some(issue(fake, &id, username.trim())))
    }

    fn login(fake: &Fake, json: &Value) -> (u16, Option<Vec<u8>>) {
        let username = json.get("username").and_then(|v| v.as_str()).unwrap_or("");
        let password = json.get("password").and_then(|v| v.as_str()).unwrap_or("");
        let norm = username.trim().to_ascii_lowercase();
        let users = fake.users.lock().unwrap();
        let Some((id, display, _)) = users.iter().find(|(_, _, existing)| existing == &norm) else {
            return (401, Some(br#"{"error":"invalid_credentials"}"#.to_vec()));
        };
        if password != "correct-password" {
            return (401, Some(br#"{"error":"invalid_credentials"}"#.to_vec()));
        }
        let id = id.clone();
        let display = display.clone();
        drop(users);
        (200, Some(issue(fake, &id, &display)))
    }

    fn issue(fake: &Fake, id: &str, username: &str) -> Vec<u8> {
        let access = format!("access-{id}-{}", fake.access.lock().unwrap().len() + 1);
        let refresh = format!("refresh-{id}-{}", fake.refresh.lock().unwrap().len() + 1);
        fake.access
            .lock()
            .unwrap()
            .insert(access.clone(), id.to_string());
        fake.refresh
            .lock()
            .unwrap()
            .insert(refresh.clone(), (id.to_string(), false));
        serde_json::to_vec(&serde_json::json!({
            "accessToken": access,
            "refreshToken": refresh,
            "expiresIn": 900,
            "user": { "id": id, "username": username }
        }))
        .unwrap()
    }

    fn refresh(fake: &Fake, json: &Value) -> (u16, Option<Vec<u8>>) {
        let token = json
            .get("refreshToken")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let mut table = fake.refresh.lock().unwrap();
        let Some((user_id, revoked)) = table.get(token).cloned() else {
            return (401, Some(br#"{"error":"invalid_token"}"#.to_vec()));
        };
        if revoked {
            return (401, Some(br#"{"error":"invalid_token"}"#.to_vec()));
        }
        if let Some(entry) = table.get_mut(token) {
            entry.1 = true;
        }
        drop(table);
        let users = fake.users.lock().unwrap();
        let Some((_, username, _)) = users.iter().find(|(id, _, _)| id == &user_id) else {
            return (401, Some(br#"{"error":"invalid_token"}"#.to_vec()));
        };
        let username = username.clone();
        drop(users);
        (200, Some(issue(fake, &user_id, &username)))
    }

    fn logout(fake: &Fake, json: &Value) -> (u16, Option<Vec<u8>>) {
        if let Some(token) = json.get("refreshToken").and_then(|v| v.as_str()) {
            if let Some(entry) = fake.refresh.lock().unwrap().get_mut(token) {
                entry.1 = true;
            }
        }
        (204, None)
    }

    fn me(fake: &Fake, headers: &[(String, String)]) -> (u16, Option<Vec<u8>>) {
        let header = headers
            .iter()
            .find(|(key, _)| key == "authorization")
            .map(|(_, value)| value.as_str())
            .unwrap_or("");
        let Some(token) = header.strip_prefix("Bearer ") else {
            return (401, Some(br#"{"error":"invalid_token"}"#.to_vec()));
        };
        let Some(user_id) = fake.access.lock().unwrap().get(token).cloned() else {
            return (401, Some(br#"{"error":"invalid_token"}"#.to_vec()));
        };
        let users = fake.users.lock().unwrap();
        let Some((_, username, _)) = users.iter().find(|(id, _, _)| id == &user_id) else {
            return (401, Some(br#"{"error":"invalid_token"}"#.to_vec()));
        };
        (
            200,
            Some(
                serde_json::to_vec(&serde_json::json!({
                    "id": user_id,
                    "username": username
                }))
                .unwrap(),
            ),
        )
    }

    fn read_http(
        stream: &mut std::net::TcpStream,
    ) -> std::io::Result<(String, String, Vec<(String, String)>, Vec<u8>)> {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 2048];
        let header_end = loop {
            let n = stream.read(&mut tmp)?;
            if n == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "closed",
                ));
            }
            buf.extend_from_slice(&tmp[..n]);
            if let Some(pos) = buf.windows(4).position(|window| window == b"\r\n\r\n") {
                break pos;
            }
            if buf.len() > 65_536 {
                return Err(std::io::Error::other("headers too large"));
            }
        };
        let header = String::from_utf8_lossy(&buf[..header_end]).to_string();
        let mut lines = header.split("\r\n");
        let request = lines.next().unwrap_or("");
        let mut parts = request.split_whitespace();
        let method = parts.next().unwrap_or("").to_string();
        let path = parts.next().unwrap_or("/").to_string();
        let mut headers = Vec::new();
        let mut length = 0usize;
        for line in lines {
            if let Some((key, value)) = line.split_once(':') {
                let key = key.trim().to_ascii_lowercase();
                let value = value.trim().to_string();
                if key == "content-length" {
                    length = value.parse().unwrap_or(0);
                }
                headers.push((key, value));
            }
        }
        let mut body = buf[header_end + 4..].to_vec();
        while body.len() < length {
            let n = stream.read(&mut tmp)?;
            if n == 0 {
                break;
            }
            body.extend_from_slice(&tmp[..n]);
        }
        body.truncate(length);
        Ok((method, path, headers, body))
    }

    #[test]
    fn default_tailnet_url_is_allowed_without_the_insecure_flag() {
        let url = check_url_policy(DEFAULT_AUTH_BASE_URL, false).unwrap();
        assert_eq!(canonical_url(&url).unwrap(), DEFAULT_AUTH_BASE_URL);
        assert!(is_tailnet_host("100.101.141.93"));
        assert!(is_tailnet_host("100.64.0.1"));
        assert!(is_tailnet_host("100.127.255.255"));
        assert!(!is_tailnet_host("100.63.255.255"));
        assert!(!is_tailnet_host("100.128.0.1"));
        assert!(!is_tailnet_host("8.8.8.8"));
    }

    #[test]
    fn private_lan_loopback_and_tailnet_http_are_allowed() {
        for raw in [
            "http://10.0.0.85:8080",
            "http://10.0.0.0:8080",
            "http://10.255.255.255:8080",
            "http://192.168.0.1:8080",
            "http://192.168.255.254:8080",
            "http://172.16.0.1:8080",
            "http://172.31.255.254:8080",
            "http://127.0.0.1:8080",
            "http://127.255.255.254:9",
            "http://localhost:8080",
            "http://[::1]:8080",
            DEFAULT_AUTH_BASE_URL,
            "http://100.64.0.1:8080",
            "http://100.127.255.255:8080",
        ] {
            let url = check_url_policy(raw, false).unwrap_or_else(|err| panic!("{raw}: {err}"));
            assert_eq!(url.scheme(), "http", "{raw}");
        }

        let lan = check_url_policy("http://10.0.0.85:8080", false).unwrap();
        assert_eq!(canonical_url(&lan).unwrap(), "http://10.0.0.85:8080");

        for raw in [
            "http://9.255.255.255:8080",
            "http://11.0.0.1:8080",
            "http://172.15.255.255:8080",
            "http://172.32.0.1:8080",
            "http://192.167.0.1:8080",
            "http://192.169.0.1:8080",
            "http://8.8.8.8:8080",
            "http://1.1.1.1",
            "http://example.com",
            "http://auth.example.com:8080",
            "http://100.63.255.255:8080",
            "http://100.128.0.1:8080",
        ] {
            let err = check_url_policy(raw, true).unwrap_err();
            let message = err.to_string();
            assert!(
                message.contains("Plain HTTP") || message.contains("https://"),
                "{raw}: {message}"
            );
            assert!(
                !message.contains("Release builds"),
                "installed builds should accept private LAN HTTP, got {message} for {raw}"
            );
        }

        let named = check_url_policy("http://auth.local:8080", false).unwrap_err();
        assert!(named.to_string().contains("https://"));
        assert!(check_url_policy("http://auth.local:8080", true).is_ok());
        assert!(check_url_policy("http://printer.lan:8080", true).is_ok());
        assert!(check_url_policy("https://auth.example", false).is_ok());
        assert!(check_url_policy("http://10.0.0.85:8080", false).is_ok());
    }

    #[test]
    fn pin_decodes_colon_hex() {
        let pin = decode_pin("aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99").unwrap();
        assert_eq!(pin[0], 0xaa);
        assert_eq!(pin[31], 0x99);
        assert!(decode_pin("abcd").is_err());
    }

    #[test]
    fn credential_json_is_only_username_and_password() {
        let value = serde_json::to_value(CredentialBody {
            username: "ada",
            password: "correct-password",
        })
        .unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(object.len(), 2);
        assert_eq!(object.get("username").unwrap(), "ada");
        assert!(object.get("password").is_some());
        assert!(object.get("refreshToken").is_none());
        let refresh = serde_json::to_value(RefreshBody {
            refresh_token: "abc",
        })
        .unwrap();
        assert_eq!(refresh["refreshToken"], "abc");
    }

    #[test]
    fn disabled_auth_does_not_contact_the_tailnet() {
        let service = AuthService::with_store(MemoryStore::default());
        let session = service.session(&AuthSettings {
            enabled: false,
            ..AuthSettings::default()
        });
        assert!(!session.enabled);
        assert!(!session.signed_in);
        assert_eq!(session.base_url, DEFAULT_AUTH_BASE_URL);
    }

    #[test]
    #[should_panic(expected = "refusing to contact a tailnet auth-server")]
    fn tests_do_not_call_the_tailnet_server() {
        let service = AuthService::with_store(MemoryStore::default());
        let _ = service.probe(&AuthSettings {
            enabled: true,
            ..AuthSettings::default()
        });
    }

    #[test]
    fn register_login_refresh_logout_and_restore() {
        let (base, fake) = spawn_fake();
        let store = MemoryStore::default();
        let service = AuthService::with_store(store.clone());
        let cfg = settings(&base);

        let created = service.register(&cfg, "Ada", "correct-password").unwrap();
        assert!(created.signed_in);
        assert_eq!(created.user.as_ref().unwrap().username, "Ada");
        assert!(!created.offline);

        let register_body = fake
            .seen
            .lock()
            .unwrap()
            .iter()
            .find(|seen| seen.path == "/auth/register")
            .unwrap()
            .body
            .clone();
        let register_json: Value = serde_json::from_str(&register_body).unwrap();
        assert_eq!(register_json["username"], "Ada");
        assert_eq!(register_json["password"], "correct-password");
        assert_eq!(register_json.as_object().unwrap().len(), 2);

        let me = service.current_user(&cfg, &store.get(KEY_ACCESS).unwrap().unwrap());
        assert_eq!(me.unwrap().username, "Ada");
        let me_seen = fake
            .seen
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|seen| seen.path == "/auth/me")
            .unwrap()
            .authorization
            .clone();
        assert!(me_seen.starts_with("Bearer access-"));
        assert!(!me_seen.contains("correct-password"));

        let short = service.register(&cfg, "ada", "short").unwrap_err();
        assert_eq!(short.code(), Some("weak_password"));

        let taken = service
            .register(&cfg, "ADA", "correct-password")
            .unwrap_err();
        assert_eq!(taken.code(), Some("username_taken"));

        let bad = service.login(&cfg, "Ada", "wrong-password").unwrap_err();
        assert_eq!(bad.code(), Some("invalid_credentials"));

        store.delete(KEY_ACCESS).unwrap();
        let restored = AuthService::with_store(store.clone()).session(&cfg);
        assert!(restored.signed_in);
        assert!(!restored.offline);
        assert_eq!(restored.user.unwrap().id, "user-1");
        let new_refresh = store.get(KEY_REFRESH).unwrap().unwrap();
        assert!(new_refresh.starts_with("refresh-"));

        let old = "refresh-user-1-1";
        // Presenting the rotated token through the live service store fails closed.
        store.set(KEY_REFRESH, old).unwrap();
        store.delete(KEY_ACCESS).unwrap();
        store
            .set(KEY_EXPIRES, &(now_unix() + 60).to_string())
            .unwrap();
        let rejected = AuthService::with_store(store.clone()).session(&cfg);
        assert!(!rejected.signed_in);
        assert_eq!(rejected.suggested_username.as_deref(), Some("Ada"));
        assert!(store.get(KEY_REFRESH).unwrap().is_none());

        let signed_in = service.login(&cfg, "Ada", "correct-password").unwrap();
        assert!(signed_in.signed_in);
        let logged_out = service.logout(&cfg).unwrap();
        assert!(!logged_out.signed_in);
        assert_eq!(logged_out.suggested_username.as_deref(), Some("Ada"));
        assert!(store.get(KEY_REFRESH).unwrap().is_none());
        assert!(store.get(KEY_ACCESS).unwrap().is_none());

        let after = service.session(&cfg);
        assert!(!after.signed_in);
        assert_eq!(after.reachable, Some(true));

        // Unreachable auth-server with a still-valid access token stays signed in offline.
        store.set(KEY_ACCESS, "access-user-1-1").unwrap();
        store.set(KEY_REFRESH, "refresh-missing").unwrap();
        store.set(KEY_USER_ID, "user-1").unwrap();
        store.set(KEY_USERNAME, "Ada").unwrap();
        store
            .set(KEY_EXPIRES, &(now_unix() + 600).to_string())
            .unwrap();
        let offline_cfg = settings("http://127.0.0.1:1");
        let offline = service.session(&offline_cfg).clone();
        assert!(offline.signed_in);
        assert!(offline.offline);
        assert!(offline
            .status_message
            .unwrap()
            .contains("auth-server unreachable"));
    }

    /// Manual check against a local auth-server process.
    /// Set AUTH_TEST_URL=http://127.0.0.1:PORT. Refuses the tailnet host.
    /// Not part of `cargo test` (ignored) and not wired into CI.
    #[test]
    #[ignore = "manual local auth-server only; never the tailnet host"]
    fn manual_local_auth_server() {
        let base = std::env::var("AUTH_TEST_URL").unwrap_or_default();
        if base.trim().is_empty() {
            return;
        }
        let parsed = Url::parse(base.trim()).expect("AUTH_TEST_URL");
        let host = parsed.host_str().unwrap_or("");
        if is_tailnet_host(host) || host == "100.101.141.93" {
            panic!("refusing to call the tailnet auth-server from tests");
        }
        if !is_loopback_host(host) {
            panic!("AUTH_TEST_URL must be loopback");
        }
        let cfg = settings(base.trim());
        let store = MemoryStore::default();
        let service = AuthService::with_store(store.clone());
        let name = format!("cc-{}", uuid::Uuid::new_v4().simple());
        let created = service
            .register(&cfg, &name, "correct-password")
            .expect("register");
        assert!(created.signed_in);
        let me = service
            .current_user(&cfg, &store.get(KEY_ACCESS).unwrap().unwrap())
            .unwrap();
        assert_eq!(me.username, name);
        store.delete(KEY_ACCESS).unwrap();
        let restored = service.session(&cfg);
        assert!(restored.signed_in, "refresh should restore the session");
        let logged_out = service.logout(&cfg).unwrap();
        assert!(!logged_out.signed_in);
        let again = service.login(&cfg, &name, "correct-password").unwrap();
        assert!(again.signed_in);
        service.logout(&cfg).unwrap();
        let rejected = service.session(&cfg);
        assert!(!rejected.signed_in);
    }
}
