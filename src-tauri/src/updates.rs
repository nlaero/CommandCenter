//! GitHub release checks for Command Center and auth-server.
//!
//! The check looks at published releases only. A tag counts as an update when its
//! version is higher than what is installed. Prereleases that are older (such as
//! v0.1.0-test.1 next to 0.1.0) are not offered. Nothing is downloaded until the
//! user asks.

use crate::local_server;
use semver::Version;
use serde::Deserialize;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const APP_REPO: &str = "nlaero/CommandCenter";
const AUTH_REPO: &str = "nlaero/command-center-auth";
const MAX_DOWNLOAD_BYTES: u64 = 200 * 1024 * 1024;
const CACHE_TTL: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReport {
    pub app_version: String,
    pub checked_at: String,
    pub products: Vec<ProductStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductStatus {
    pub id: String,
    pub name: String,
    pub repo: String,
    pub current_version: Option<String>,
    pub current_detail: String,
    pub latest_version: Option<String>,
    pub latest_tag: Option<String>,
    pub prerelease: bool,
    pub published_at: Option<String>,
    pub html_url: Option<String>,
    pub notes: Option<String>,
    pub update_available: bool,
    pub can_apply: bool,
    pub apply_label: String,
    pub asset_name: Option<String>,
    pub message: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub product: String,
    pub message: String,
    pub path: Option<String>,
    pub started_installer: bool,
}

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    #[serde(default)]
    browser_download_url: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Clone)]
struct AssetPick {
    name: String,
    url: String,
    size: u64,
    digest: Option<String>,
}

struct Selection {
    update_available: bool,
    can_apply: bool,
    apply_label: String,
    latest_version: Option<String>,
    latest_tag: Option<String>,
    prerelease: bool,
    published_at: Option<String>,
    html_url: String,
    notes: Option<String>,
    asset: Option<AssetPick>,
    message: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    App,
    Auth,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AuthPlace {
    LocalReady,
    LocalMissingBin,
    Remote,
    Absent,
}

struct CacheEntry {
    at: Instant,
    report: UpdateReport,
}

fn cache() -> &'static std::sync::Mutex<Option<CacheEntry>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<Option<CacheEntry>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(None))
}

pub fn check(root: &Path, base_url: &str, force: bool) -> Result<UpdateReport, String> {
    if !force {
        let guard = cache().lock().unwrap_or_else(|err| err.into_inner());
        if let Some(entry) = guard.as_ref() {
            if entry.at.elapsed() < CACHE_TTL {
                return Ok(entry.report.clone());
            }
        }
    }

    let current = app_version()?;
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let app_releases = fetch_releases(APP_REPO);
    let auth_releases = if crate::config::AUTH_IN_APP {
        Some(fetch_releases(AUTH_REPO))
    } else {
        None
    };
    let (place, version, detail) = if crate::config::AUTH_IN_APP {
        auth_place(root, base_url)
    } else {
        (AuthPlace::Absent, None, String::new())
    };

    let current_text = current.to_string();
    let auth_text = version.as_ref().map(Version::to_string);
    let app = match &app_releases {
        Ok(releases) => product(
            "command-center",
            "Command Center",
            APP_REPO,
            Some(current_text.clone()),
            "This copy of Command Center".into(),
            app_selection(&current, releases, os, arch),
            None,
        ),
        Err(err) => error_product(
            "command-center",
            "Command Center",
            APP_REPO,
            Some(current_text.as_str()),
            "This copy of Command Center",
            err,
        ),
    };
    let auth = match auth_releases.as_ref() {
        None => None,
        Some(Ok(releases)) => Some(product(
            "auth-server",
            "auth-server",
            AUTH_REPO,
            auth_text.clone(),
            detail.clone(),
            auth_selection(version.as_ref(), releases, os, arch, place),
            None,
        )),
        Some(Err(err)) => Some(error_product(
            "auth-server",
            "auth-server",
            AUTH_REPO,
            auth_text.as_deref(),
            &detail,
            err,
        )),
    };

    let mut products = vec![app];
    if let Some(auth) = auth {
        products.push(auth);
    }
    let report = UpdateReport {
        app_version: current.to_string(),
        checked_at: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        products,
    };
    if report.products.iter().all(|item| item.error.is_none()) {
        let mut guard = cache().lock().unwrap_or_else(|err| err.into_inner());
        *guard = Some(CacheEntry {
            at: Instant::now(),
            report: report.clone(),
        });
    }
    Ok(report)
}

pub fn apply(root: &Path, base_url: &str, product_id: &str) -> Result<ApplyResult, String> {
    match product_id {
        "command-center" => apply_app(root),
        "auth-server" if crate::config::AUTH_IN_APP => apply_auth(root, base_url),
        "auth-server" => Err("This build does not update auth-server.".into()),
        _ => Err("Unknown update.".into()),
    }
}

fn apply_app(root: &Path) -> Result<ApplyResult, String> {
    let current = app_version()?;
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let releases = fetch_releases(APP_REPO)?;
    let selection = app_selection(&current, &releases, os, arch);
    if !selection.can_apply {
        return Err(selection.message);
    }
    let asset = selection
        .asset
        .ok_or_else(|| "The release has no Windows installer.".to_string())?;
    let path = download_asset(root, APP_REPO, &asset)?;
    start_installer(&path)?;
    clear_cache();
    Ok(ApplyResult {
        product: "command-center".into(),
        message: format!(
            "Saved the installer to {} and started it. Finish the setup window to update Command Center. You can leave this window open until the installer asks you to close it.",
            path.display()
        ),
        path: Some(path.display().to_string()),
        started_installer: true,
    })
}

fn apply_auth(root: &Path, base_url: &str) -> Result<ApplyResult, String> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let (place, version, _detail) = auth_place(root, base_url);
    let releases = fetch_releases(AUTH_REPO)?;
    let selection = auth_selection(version.as_ref(), &releases, os, arch, place);
    if !selection.can_apply {
        return Err(selection.message);
    }
    let asset = selection
        .asset
        .ok_or_else(|| "The auth-server release has no file for this computer.".to_string())?;
    let version_text = selection
        .latest_version
        .clone()
        .ok_or_else(|| "The auth-server release has no version.".to_string())?;
    let bytes = download_bytes(AUTH_REPO, &asset)?;
    let binary = local_server::find_binary()
        .ok_or_else(|| "The auth-server program is not in this install.".to_string())?;
    let running = local_server::status(root).running;
    if running {
        local_server::stop_installed(root)?;
    }
    replace_file(&binary, &bytes)?;
    write_version_file(root, &version_text)?;
    clear_cache();
    let message = if running {
        match local_server::start_installed(root) {
            Ok(()) => format!("auth-server is now {version_text} and was started again."),
            Err(err) => {
                format!("auth-server is now {version_text}, but it did not start. {err}")
            }
        }
    } else {
        format!("auth-server is now {version_text}. It was not running, so it was left stopped.")
    };
    Ok(ApplyResult {
        product: "auth-server".into(),
        message,
        path: Some(binary.display().to_string()),
        started_installer: false,
    })
}

fn app_version() -> Result<Version, String> {
    Version::parse(env!("CARGO_PKG_VERSION"))
        .map_err(|_| "This copy has an unreadable version.".to_string())
}

fn app_selection(current: &Version, releases: &[GhRelease], os: &str, arch: &str) -> Selection {
    let scan = scan(releases, current);
    let stable = scan.stable.clone();
    let pre = scan.pre.clone();
    let highest = scan.highest.clone();
    let chosen = stable.clone().or(pre.clone());
    let update_available = chosen.is_some();
    let chosen_release = chosen.as_ref().map(|item| &releases[item.index]);
    let asset = chosen_release.and_then(|release| pick_asset(&release.assets, os, arch, Kind::App));
    let prerelease = chosen_release
        .map(|release| release.prerelease)
        .unwrap_or(false);
    let can_apply = update_available
        && os == "windows"
        && asset
            .as_ref()
            .map(|item| is_windows_setup(&item.name))
            .unwrap_or(false);
    let mut message = if let Some(item) = chosen.as_ref() {
        let mut text = format!("{} is available. This copy is {current}.", item.version);
        if prerelease {
            text.push_str(" It is marked as a prerelease.");
        }
        if let Some(pre) = pre.as_ref() {
            if stable.is_some() && pre.version > item.version {
                text.push_str(&format!(
                    " A newer prerelease {} is also on GitHub; this install stays on the stable release.",
                    releases[pre.index].tag_name
                ));
            }
        }
        text
    } else if releases
        .iter()
        .any(|release| !release.draft && parse_version(&release.tag_name).is_some())
    {
        if let Some(highest) = highest.as_ref() {
            let release = &releases[highest.index];
            if release.prerelease && highest.version < *current {
                format!(
                    "Command Center {current} is current. The latest GitHub tag is prerelease {}, which is not a newer release.",
                    release.tag_name
                )
            } else {
                format!("Command Center {current} is current.")
            }
        } else {
            format!("Command Center {current} is current.")
        }
    } else {
        "No Command Center release is published yet.".into()
    };
    if update_available && !can_apply {
        let windows_only = chosen_release
            .map(|release| {
                release
                    .assets
                    .iter()
                    .any(|asset| is_windows_setup(&asset.name))
            })
            .unwrap_or(false);
        if os != "windows" && windows_only {
            message.push_str(
                " The published file is a Windows installer. Open the release page to download it.",
            );
        } else if asset.is_none() {
            message.push_str(" Open the release page to download it.");
        } else {
            message.push_str(" Open the release page to install it.");
        }
    }
    selection_from(
        chosen_release,
        asset,
        update_available,
        can_apply,
        prerelease,
        &message,
        APP_REPO,
        Kind::App,
    )
}

fn auth_selection(
    current: Option<&Version>,
    releases: &[GhRelease],
    os: &str,
    arch: &str,
    place: AuthPlace,
) -> Selection {
    let floor = current.cloned().unwrap_or_else(|| Version::new(0, 0, 0));
    let scan = scan(releases, &floor);
    let stable = scan.stable.clone();
    let pre = scan.pre.clone();
    let highest = scan.highest.clone();
    let preferred = stable.clone().or(pre.clone());
    let update_available = current.is_some() && preferred.is_some();
    let display = if current.is_none() {
        preferred.clone().or(highest.clone())
    } else if update_available {
        preferred.clone()
    } else {
        None
    };
    let display_release = display.as_ref().map(|item| &releases[item.index]);
    let asset =
        display_release.and_then(|release| pick_asset(&release.assets, os, arch, Kind::Auth));
    let prerelease = update_available
        && display
            .as_ref()
            .map(|item| releases[item.index].prerelease)
            .unwrap_or(false);
    let published = preferred.is_some() || highest.is_some();
    let can_apply = matches!(place, AuthPlace::LocalReady)
        && asset.is_some()
        && (update_available || (current.is_none() && published));

    let mut message = if update_available {
        let item = preferred.as_ref().expect("update has a release");
        let running = current
            .map(|version| version.to_string())
            .unwrap_or_else(|| "unknown".into());
        let mut text = format!(
            "{} is available. This computer is using {running}.",
            item.version
        );
        if prerelease {
            text.push_str(" It is marked as a prerelease.");
        }
        text
    } else if current.is_none() {
        if let Some(item) = preferred.as_ref().or(highest.as_ref()) {
            format!(
                "The latest auth-server release is {}. This install does not report a version.",
                item.version
            )
        } else {
            "No auth-server release is published yet.".into()
        }
    } else if highest.is_some() {
        format!("auth-server {floor} is current.")
    } else {
        "No auth-server release is published yet.".into()
    };

    if update_available && matches!(place, AuthPlace::Remote) {
        message.push_str(" Update that server on the machine that runs it.");
    } else if update_available && matches!(place, AuthPlace::LocalMissingBin | AuthPlace::Absent) {
        message.push_str(" Install auth-server on this computer before updating it from here.");
    } else if update_available && asset.is_none() && matches!(place, AuthPlace::LocalReady) {
        message.push_str(" The release does not include a file this computer can install.");
    } else if !update_available && current.is_none() && can_apply {
        message.push_str(" You can still install that release on this computer.");
    }

    let mut selection = selection_from(
        display_release,
        asset,
        update_available,
        can_apply,
        prerelease,
        &message,
        AUTH_REPO,
        Kind::Auth,
    );
    if can_apply && !update_available {
        selection.apply_label = "Install published release".into();
    }
    selection
}

fn selection_from(
    release: Option<&GhRelease>,
    asset: Option<AssetPick>,
    update_available: bool,
    can_apply: bool,
    prerelease: bool,
    message: &str,
    repo: &str,
    kind: Kind,
) -> Selection {
    let apply_label = if can_apply && kind == Kind::App {
        "Download and install".into()
    } else if can_apply {
        "Update server".into()
    } else {
        String::new()
    };
    Selection {
        update_available,
        can_apply,
        apply_label,
        latest_version: release
            .and_then(|item| parse_version(&item.tag_name).map(|version| version.to_string())),
        latest_tag: release.map(|item| item.tag_name.clone()),
        prerelease,
        published_at: release.and_then(|item| item.published_at.clone()),
        html_url: release
            .map(|item| item.html_url.clone())
            .filter(|url| !url.is_empty())
            .unwrap_or_else(|| releases_page(repo)),
        notes: release.and_then(|item| excerpt(item.body.as_deref())),
        asset,
        message: message.to_string(),
    }
}

fn product(
    id: &str,
    name: &str,
    repo: &str,
    current_version: Option<String>,
    current_detail: String,
    selection: Selection,
    error: Option<String>,
) -> ProductStatus {
    ProductStatus {
        id: id.into(),
        name: name.into(),
        repo: repo.into(),
        current_version,
        current_detail,
        latest_version: selection.latest_version,
        latest_tag: selection.latest_tag,
        prerelease: selection.prerelease,
        published_at: selection.published_at,
        html_url: Some(selection.html_url),
        notes: selection.notes,
        update_available: selection.update_available,
        can_apply: selection.can_apply,
        apply_label: selection.apply_label,
        asset_name: selection.asset.as_ref().map(|item| item.name.clone()),
        message: selection.message,
        error,
    }
}

fn error_product(
    id: &str,
    name: &str,
    repo: &str,
    current_version: Option<&str>,
    detail: &str,
    err: &str,
) -> ProductStatus {
    ProductStatus {
        id: id.into(),
        name: name.into(),
        repo: repo.into(),
        current_version: current_version.map(str::to_string),
        current_detail: detail.into(),
        latest_version: None,
        latest_tag: None,
        prerelease: false,
        published_at: None,
        html_url: Some(releases_page(repo)),
        notes: None,
        update_available: false,
        can_apply: false,
        apply_label: String::new(),
        asset_name: None,
        message: err.into(),
        error: Some(err.into()),
    }
}

#[derive(Clone)]
struct Indexed {
    index: usize,
    version: Version,
}

struct Scan {
    stable: Option<Indexed>,
    pre: Option<Indexed>,
    highest: Option<Indexed>,
}

fn scan(releases: &[GhRelease], current: &Version) -> Scan {
    let mut stable = None;
    let mut pre = None;
    let mut highest = None;
    for (index, release) in releases.iter().enumerate() {
        if release.draft {
            continue;
        }
        let Some(version) = parse_version(&release.tag_name) else {
            continue;
        };
        let item = Indexed {
            index,
            version: version.clone(),
        };
        let higher = highest
            .as_ref()
            .map(|existing: &Indexed| item.version > existing.version)
            .unwrap_or(true);
        if higher {
            highest = Some(item.clone());
        }
        if item.version <= *current {
            continue;
        }
        if release.prerelease {
            let better = pre
                .as_ref()
                .map(|existing: &Indexed| item.version > existing.version)
                .unwrap_or(true);
            if better {
                pre = Some(item);
            }
        } else {
            let better = stable
                .as_ref()
                .map(|existing: &Indexed| item.version > existing.version)
                .unwrap_or(true);
            if better {
                stable = Some(item);
            }
        }
    }
    Scan {
        stable,
        pre,
        highest,
    }
}

fn parse_version(tag: &str) -> Option<Version> {
    let trimmed = tag.trim().trim_start_matches(['v', 'V']);
    Version::parse(trimmed).ok()
}

fn pick_asset(assets: &[GhAsset], os: &str, arch: &str, kind: Kind) -> Option<AssetPick> {
    let mut best: Option<(AssetPick, u8)> = None;
    for asset in assets {
        let Some(score) = asset_score(&asset.name, os, arch, kind) else {
            continue;
        };
        if asset.browser_download_url.is_empty() {
            continue;
        }
        let pick = AssetPick {
            name: asset.name.clone(),
            url: asset.browser_download_url.clone(),
            size: asset.size,
            digest: asset.digest.clone(),
        };
        let replace = best
            .as_ref()
            .map(|(_, current)| score > *current)
            .unwrap_or(true);
        if replace {
            best = Some((pick, score));
        }
    }
    best.map(|(pick, _)| pick)
}

fn asset_score(name: &str, os: &str, arch: &str, kind: Kind) -> Option<u8> {
    if is_junk(name) || !arch_ok(name, arch) {
        return None;
    }
    let n = name.to_ascii_lowercase();
    let bonus = arch_bonus(&n, arch);
    match kind {
        Kind::App => match os {
            "windows" if is_windows_setup(name) => Some(20 + bonus),
            "linux" if n.ends_with(".appimage") || n.ends_with(".deb") => Some(20 + bonus),
            "macos" if n.ends_with(".dmg") => Some(20 + bonus),
            _ => None,
        },
        Kind::Auth => {
            if n.contains("setup") || is_archive(name) {
                return None;
            }
            match os {
                "windows" if n == "auth-server.exe" => Some(50 + bonus),
                "windows" if n.ends_with("auth-server.exe") => Some(40 + bonus),
                "windows" if n.contains("auth-server") && n.ends_with(".exe") => Some(30 + bonus),
                "linux" | "macos" if n == "auth-server" => Some(50),
                "linux"
                    if n.contains("auth-server")
                        && (n.contains("linux") || n.contains("unknown-linux"))
                        && !n.ends_with(".exe") =>
                {
                    Some(40 + bonus)
                }
                "macos"
                    if n.contains("auth-server")
                        && (n.contains("darwin") || n.contains("apple") || n.contains("macos"))
                        && !n.ends_with(".exe") =>
                {
                    Some(40 + bonus)
                }
                _ => None,
            }
        }
    }
}

fn is_windows_setup(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with("-setup.exe")
}

fn is_junk(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.ends_with(".blockmap") || n.ends_with(".sig") || n.ends_with(".sha256")
}

fn is_archive(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.ends_with(".zip") || n.ends_with(".tar.gz") || n.ends_with(".tgz") || n.ends_with(".7z")
}

fn arch_ok(name: &str, arch: &str) -> bool {
    let n = name.to_ascii_lowercase();
    let mentions_x64 = n.contains("x64") || n.contains("x86_64") || n.contains("amd64");
    let mentions_arm = n.contains("arm64") || n.contains("aarch64");
    match arch {
        "x86_64" if mentions_arm && !mentions_x64 => false,
        "aarch64" if mentions_x64 && !mentions_arm => false,
        _ => true,
    }
}

fn arch_bonus(name: &str, arch: &str) -> u8 {
    let mentions_x64 = name.contains("x64") || name.contains("x86_64") || name.contains("amd64");
    let mentions_arm = name.contains("arm64") || name.contains("aarch64");
    match arch {
        "x86_64" if mentions_x64 => 2,
        "aarch64" if mentions_arm => 2,
        _ => 1,
    }
}

fn excerpt(body: Option<&str>) -> Option<String> {
    let text = body?.trim();
    if text.is_empty() {
        return None;
    }
    let mut cut: String = text.chars().take(500).collect();
    if text.chars().count() > 500 {
        cut.push('…');
    }
    Some(cut)
}

fn releases_page(repo: &str) -> String {
    format!("https://github.com/{repo}/releases")
}

fn known_repo(repo: &str) -> Result<(), String> {
    if repo == APP_REPO || repo == AUTH_REPO {
        Ok(())
    } else {
        Err("Unknown repository.".into())
    }
}

fn fetch_releases(repo: &str) -> Result<Vec<GhRelease>, String> {
    known_repo(repo)?;
    let url = format!("https://api.github.com/repos/{repo}/releases?per_page=30");
    let client = http_client(Duration::from_secs(20))?;
    let response = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .map_err(|err| format!("Could not reach GitHub. {err}"))?;
    let status = response.status();
    let body = response
        .text()
        .map_err(|err| format!("Could not read GitHub's response. {err}"))?;
    if !status.is_success() {
        return Err(github_error(status, &body));
    }
    serde_json::from_str(&body)
        .map_err(|_| "GitHub returned a release list this app could not read.".into())
}

fn github_error(status: reqwest::StatusCode, body: &str) -> String {
    if status.as_u16() == 403 || status.as_u16() == 429 {
        return "GitHub rate limit reached. Try again in a little while.".into();
    }
    if status.as_u16() == 404 {
        return "GitHub could not find that repository's releases.".into();
    }
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .and_then(|item| item.as_str())
                .map(str::to_string)
        });
    match message {
        Some(message) if !message.is_empty() => format!("GitHub returned HTTP {status}: {message}"),
        _ => format!("GitHub returned HTTP {status}."),
    }
}

fn http_client(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .user_agent(format!("command-center/{}", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 8 {
                return attempt.error("too many redirects");
            }
            let host = attempt.url().host_str().map(str::to_string);
            match host.as_deref() {
                Some(host) if allowed_download_host(host) => attempt.follow(),
                Some(host) => attempt.error(format!("refusing redirect to {host}")),
                None => attempt.stop(),
            }
        }))
        .build()
        .map_err(|err| format!("Could not start the download client. {err}"))
}

fn allowed_download_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    matches!(
        host.as_str(),
        "github.com"
            | "api.github.com"
            | "objects.githubusercontent.com"
            | "release-assets.githubusercontent.com"
            | "github-releases.githubusercontent.com"
    )
}

fn release_download_ok(repo: &str, raw: &str) -> Result<(), String> {
    known_repo(repo)?;
    let url = url::Url::parse(raw).map_err(|_| "The release file URL is not valid.".to_string())?;
    if url.scheme() != "https" {
        return Err("The release file URL is not https.".into());
    }
    let host = url.host_str().unwrap_or("");
    if !allowed_download_host(host) {
        return Err("The release file URL is not on GitHub.".into());
    }
    let path = url.path();
    let github_prefix = format!("/{repo}/releases/download/");
    let api_prefix = format!("/repos/{repo}/releases/assets/");
    if (host.eq_ignore_ascii_case("github.com") && path.starts_with(&github_prefix))
        || (host.eq_ignore_ascii_case("api.github.com") && path.starts_with(&api_prefix))
    {
        Ok(())
    } else {
        Err("The release file URL does not belong to that repository.".into())
    }
}

fn download_asset(root: &Path, repo: &str, asset: &AssetPick) -> Result<PathBuf, String> {
    let bytes = download_bytes(repo, asset)?;
    let name = safe_file_name(&asset.name)?;
    let dir = root.join("updates");
    fs::create_dir_all(&dir).map_err(|err| format!("Could not create {}: {err}", dir.display()))?;
    let path = dir.join(&name);
    let partial = dir.join(format!("{name}.partial"));
    fs::write(&partial, &bytes).map_err(|err| format!("Could not save the installer: {err}"))?;
    if path.exists() {
        let _ = fs::remove_file(&path);
    }
    fs::rename(&partial, &path).map_err(|err| format!("Could not save the installer: {err}"))?;
    Ok(path)
}

fn download_bytes(repo: &str, asset: &AssetPick) -> Result<Vec<u8>, String> {
    if asset.size > MAX_DOWNLOAD_BYTES {
        return Err("The release file is larger than this app will download.".into());
    }
    release_download_ok(repo, &asset.url)?;
    let client = http_client(Duration::from_secs(120))?;
    let response = client
        .get(&asset.url)
        .send()
        .map_err(|err| format!("Could not download the release. {err}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("The download returned HTTP {status}."));
    }
    if let Some(len) = response.content_length() {
        if len > MAX_DOWNLOAD_BYTES {
            return Err("The release file is larger than this app will download.".into());
        }
    }
    let bytes = response
        .bytes()
        .map_err(|err| format!("Could not download the release. {err}"))?;
    if bytes.is_empty() {
        return Err("The download was empty.".into());
    }
    if bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
        return Err("The release file is larger than this app will download.".into());
    }
    verify_digest(&bytes, asset.digest.as_deref())?;
    Ok(bytes.to_vec())
}

fn verify_digest(bytes: &[u8], digest: Option<&str>) -> Result<(), String> {
    let Some(digest) = digest.map(str::trim).filter(|item| !item.is_empty()) else {
        return Ok(());
    };
    let Some(expected) = digest.strip_prefix("sha256:") else {
        return Err("The release digest is not sha256.".into());
    };
    let actual = hex_encode(&Sha256::digest(bytes));
    if actual.eq_ignore_ascii_case(expected.trim()) {
        Ok(())
    } else {
        Err("The download did not match the GitHub sha256 digest.".into())
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0xf) as usize] as char);
    }
    out
}

fn safe_file_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 180
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.chars().any(|ch| ch.is_control())
    {
        return Err("The release file name is not usable.".into());
    }
    Ok(name.to_string())
}

fn start_installer(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new(path)
            .spawn()
            .map(|_| ())
            .map_err(|err| format!("Could not start the installer: {err}"))
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("This computer does not run the Windows installer.".into())
    }
}

fn replace_file(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = dest
        .parent()
        .ok_or_else(|| "auth-server has no directory.".to_string())?;
    let file_name = dest
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("auth-server");
    let tmp = parent.join(format!(".{file_name}-update"));
    fs::write(&tmp, bytes).map_err(|err| format!("Could not write the new auth-server: {err}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755))
            .map_err(|err| format!("Could not mark auth-server executable: {err}"))?;
    }
    match fs::rename(&tmp, dest) {
        Ok(()) => Ok(()),
        Err(err) => {
            let removed = fs::remove_file(dest);
            if removed.is_ok() {
                fs::rename(&tmp, dest).map_err(|rename_err| {
                    format!(
                        "Could not replace {}. {rename_err}. The new file is still at {}.",
                        dest.display(),
                        tmp.display()
                    )
                })
            } else {
                Err(format!(
                    "Could not replace {}. {err}. The new file is still at {}.",
                    dest.display(),
                    tmp.display()
                ))
            }
        }
    }
}

fn version_file(root: &Path) -> PathBuf {
    root.join("server").join("auth-server-version.txt")
}

fn read_version_file(root: &Path) -> Option<Version> {
    let text = fs::read_to_string(version_file(root)).ok()?;
    parse_version(text.trim())
}

fn write_version_file(root: &Path, version: &str) -> Result<(), String> {
    let path = version_file(root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Could not record the auth-server version: {err}"))?;
    }
    fs::write(&path, format!("{version}\n"))
        .map_err(|err| format!("Could not record the auth-server version: {err}"))
}

fn auth_place(root: &Path, base_url: &str) -> (AuthPlace, Option<Version>, String) {
    let endpoint = local_server::local_endpoint(root);
    let binary = local_server::find_binary().is_some();
    let local_target = endpoint
        .as_ref()
        .map(|(port, _)| local_server::targets_local_server(base_url, *port))
        .unwrap_or(false);
    let probe = probe_url(
        base_url,
        endpoint.as_ref().map(|(port, _)| *port),
        local_target,
    );
    let health = probe.as_deref().and_then(health_version);
    let file_version = read_version_file(root);

    if local_target {
        let version = health.or(file_version);
        let detail = if version.is_some() {
            "Installed on this computer".to_string()
        } else {
            "Installed on this computer, version not recorded".to_string()
        };
        let place = if binary {
            AuthPlace::LocalReady
        } else {
            AuthPlace::LocalMissingBin
        };
        return (place, version, detail);
    }
    if !base_url.trim().is_empty() {
        let host = display_host(base_url);
        let detail = if health.is_some() {
            format!("Reported by {host}")
        } else {
            format!("{host} did not report a version")
        };
        return (AuthPlace::Remote, health, detail);
    }
    (
        AuthPlace::Absent,
        None,
        "Not installed on this computer".into(),
    )
}

fn probe_url(base_url: &str, local_port: Option<u16>, local_target: bool) -> Option<String> {
    let base = base_url.trim().trim_end_matches('/');
    if !base.is_empty() {
        return Some(base.to_string());
    }
    if local_target {
        local_port.map(|port| format!("http://127.0.0.1:{port}"))
    } else {
        None
    }
}

fn display_host(base_url: &str) -> String {
    url::Url::parse(base_url.trim())
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| "the server".into())
}

fn health_version(base: &str) -> Option<Version> {
    let url = url::Url::parse(base).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    let health = url.join("/health").ok()?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .ok()?;
    let response = client.get(health).send().ok()?;
    if !response.status().is_success() {
        return None;
    }
    let text = response.text().ok()?;
    if text.len() > 16 * 1024 {
        return None;
    }
    version_from_health(&text)
}

fn version_from_health(body: &str) -> Option<Version> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let raw = value.get("version").and_then(|item| item.as_str())?;
    parse_version(raw)
}

fn clear_cache() {
    let mut guard = cache().lock().unwrap_or_else(|err| err.into_inner());
    *guard = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ver(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    fn rel(tag: &str, prerelease: bool, asset: Option<&str>) -> GhRelease {
        GhRelease {
            tag_name: tag.into(),
            draft: false,
            prerelease,
            html_url: format!("https://github.com/nlaero/CommandCenter/releases/tag/{tag}"),
            body: Some("Notes from the release.".into()),
            published_at: Some("2026-11-14T01:24:18Z".into()),
            assets: asset
                .map(|name| GhAsset {
                    name: name.into(),
                    browser_download_url: format!(
                        "https://github.com/nlaero/CommandCenter/releases/download/{tag}/{name}"
                    ),
                    size: 1000,
                    digest: None,
                })
                .into_iter()
                .collect(),
        }
    }

    #[test]
    fn older_prerelease_is_not_an_update() {
        let releases = vec![rel(
            "v0.1.0-test.1",
            true,
            Some("Command.Center_0.1.0_x64-setup.exe"),
        )];
        let status = app_selection(&ver("0.1.0"), &releases, "windows", "x86_64");
        assert!(!status.update_available);
        assert!(!status.can_apply);
        assert!(status.message.contains("0.1.0"));
        assert!(status.message.contains("v0.1.0-test.1"));
    }

    #[test]
    fn newer_stable_installs_on_windows() {
        let releases = vec![rel(
            "v0.2.0",
            false,
            Some("Command.Center_0.2.0_x64-setup.exe"),
        )];
        let status = app_selection(&ver("0.1.0"), &releases, "windows", "x86_64");
        assert!(status.update_available);
        assert!(status.can_apply);
        assert_eq!(status.apply_label, "Download and install");
        assert_eq!(
            status.asset.as_ref().map(|item| item.name.as_str()),
            Some("Command.Center_0.2.0_x64-setup.exe")
        );
        assert!(!status.prerelease);
    }

    #[test]
    fn windows_installer_is_not_started_on_linux() {
        let releases = vec![rel(
            "v0.2.0",
            false,
            Some("Command.Center_0.2.0_x64-setup.exe"),
        )];
        let status = app_selection(&ver("0.1.0"), &releases, "linux", "x86_64");
        assert!(status.update_available);
        assert!(!status.can_apply);
        assert!(status.message.to_lowercase().contains("windows"));
    }

    #[test]
    fn newer_prerelease_is_offered_when_it_is_actually_newer() {
        let releases = vec![rel(
            "v0.1.1-test.1",
            true,
            Some("Command.Center_0.1.1_x64-setup.exe"),
        )];
        let status = app_selection(&ver("0.1.0"), &releases, "windows", "x86_64");
        assert!(status.update_available);
        assert!(status.prerelease);
        assert!(status.message.contains("prerelease"));
    }

    #[test]
    fn stable_wins_over_a_newer_prerelease() {
        let releases = vec![
            rel(
                "v0.3.0-test.1",
                true,
                Some("Command.Center_0.3.0_x64-setup.exe"),
            ),
            rel("v0.2.0", false, Some("Command.Center_0.2.0_x64-setup.exe")),
        ];
        let status = app_selection(&ver("0.1.0"), &releases, "windows", "x86_64");
        assert_eq!(status.latest_version.as_deref(), Some("0.2.0"));
        assert!(!status.prerelease);
        assert!(status.message.contains("v0.3.0-test.1"));
    }

    #[test]
    fn drafts_are_ignored() {
        let mut draft = rel("v0.9.0", false, Some("Command.Center_0.9.0_x64-setup.exe"));
        draft.draft = true;
        let releases = vec![
            draft,
            rel("v0.2.0", false, Some("Command.Center_0.2.0_x64-setup.exe")),
        ];
        let status = app_selection(&ver("0.1.0"), &releases, "windows", "x86_64");
        assert_eq!(status.latest_version.as_deref(), Some("0.2.0"));
    }

    #[test]
    fn equal_version_is_current() {
        let releases = vec![rel(
            "v0.1.0",
            false,
            Some("Command.Center_0.1.0_x64-setup.exe"),
        )];
        let status = app_selection(&ver("0.1.0"), &releases, "windows", "x86_64");
        assert!(!status.update_available);
        assert!(status.message.contains("current"));
    }

    #[test]
    fn auth_remote_is_not_replaced() {
        let releases = vec![rel("v0.2.0", false, Some("auth-server.exe"))];
        let status = auth_selection(
            Some(&ver("0.1.0")),
            &releases,
            "windows",
            "x86_64",
            AuthPlace::Remote,
        );
        assert!(status.update_available);
        assert!(!status.can_apply);
        assert!(status.message.contains("machine that runs it"));
    }

    #[test]
    fn auth_local_can_apply() {
        let releases = vec![rel("v0.2.0", false, Some("auth-server.exe"))];
        let status = auth_selection(
            Some(&ver("0.1.0")),
            &releases,
            "windows",
            "x86_64",
            AuthPlace::LocalReady,
        );
        assert!(status.update_available);
        assert!(status.can_apply);
        assert_eq!(status.apply_label, "Update server");
    }

    #[test]
    fn unknown_auth_version_is_not_a_banner_update() {
        let releases = vec![rel("v0.2.0", false, Some("auth-server.exe"))];
        let status = auth_selection(None, &releases, "windows", "x86_64", AuthPlace::LocalReady);
        assert!(!status.update_available);
        assert!(status.can_apply);
        assert_eq!(status.apply_label, "Install published release");
        assert!(status.message.contains("does not report a version"));
    }

    #[test]
    fn no_auth_release() {
        let status = auth_selection(None, &[], "windows", "x86_64", AuthPlace::Absent);
        assert!(!status.update_available);
        assert!(!status.can_apply);
        assert!(status.message.contains("No auth-server release"));
    }

    #[test]
    fn linux_auth_binary_is_preferred_by_name() {
        let assets = vec![
            GhAsset {
                name: "auth-server.exe".into(),
                browser_download_url: "https://github.com/nlaero/command-center-auth/releases/download/v0.2.0/auth-server.exe".into(),
                size: 10,
                digest: None,
            },
            GhAsset {
                name: "auth-server".into(),
                browser_download_url: "https://github.com/nlaero/command-center-auth/releases/download/v0.2.0/auth-server".into(),
                size: 10,
                digest: None,
            },
        ];
        let pick = pick_asset(&assets, "linux", "x86_64", Kind::Auth).unwrap();
        assert_eq!(pick.name, "auth-server");
    }

    #[test]
    fn parses_the_published_command_center_release() {
        let body = r#"[{
            "tag_name": "v0.1.0-test.1",
            "draft": false,
            "prerelease": true,
            "html_url": "https://github.com/nlaero/CommandCenter/releases/tag/v0.1.0-test.1",
            "body": "Windows installer",
            "published_at": "2026-11-14T01:24:18Z",
            "assets": [{
                "name": "Command.Center_0.1.0_x64-setup.exe",
                "browser_download_url": "https://github.com/nlaero/CommandCenter/releases/download/v0.1.0-test.1/Command.Center_0.1.0_x64-setup.exe",
                "size": 2610915,
                "digest": "sha256:59923502a375bcc881a65a2a8e8f3b5e397aa95b33fa0e6c4c147ecae5bf790f"
            }]
        }]"#;
        let releases: Vec<GhRelease> = serde_json::from_str(body).unwrap();
        let status = app_selection(&ver("0.1.0"), &releases, "windows", "x86_64");
        assert!(!status.update_available);
        assert!(status.message.contains("prerelease"));
    }

    #[test]
    fn download_urls_stay_on_the_release() {
        assert!(release_download_ok(
            APP_REPO,
            "https://github.com/nlaero/CommandCenter/releases/download/v0.2.0/Command.Center_0.2.0_x64-setup.exe"
        )
        .is_ok());
        assert!(release_download_ok(
            APP_REPO,
            "https://github.com/nlaero/command-center-auth/releases/download/v0.2.0/auth-server.exe"
        )
        .is_err());
        assert!(release_download_ok(
            APP_REPO,
            "http://github.com/nlaero/CommandCenter/releases/download/v0.2.0/a.exe"
        )
        .is_err());
        assert!(release_download_ok(
            APP_REPO,
            "https://evil.example/nlaero/CommandCenter/releases/download/v0.2.0/a.exe"
        )
        .is_err());
    }

    #[test]
    fn redirect_hosts_are_github_only() {
        assert!(allowed_download_host("github.com"));
        assert!(allowed_download_host(
            "release-assets.githubusercontent.com"
        ));
        assert!(allowed_download_host("objects.githubusercontent.com"));
        assert!(!allowed_download_host("evil.githubusercontent.com.example"));
        assert!(!allowed_download_host("example.com"));
    }

    #[test]
    fn sha256_digest_is_checked() {
        let bytes = b"command-center";
        let digest = format!("sha256:{}", hex_encode(&Sha256::digest(bytes)));
        assert!(verify_digest(bytes, Some(&digest)).is_ok());
        assert!(verify_digest(bytes, Some("sha256:deadbeef")).is_err());
        assert!(verify_digest(bytes, None).is_ok());
        assert!(verify_digest(bytes, Some("md5:abcd")).is_err());
    }

    #[test]
    fn health_json_version_is_optional() {
        assert_eq!(
            version_from_health(r#"{"ok":true,"service":"auth-server","version":"v0.2.0"}"#)
                .unwrap()
                .to_string(),
            "0.2.0"
        );
        assert!(version_from_health(r#"{"ok":true,"service":"auth-server"}"#).is_none());
    }

    #[test]
    fn version_file_roundtrip_and_local_target() {
        let dir = std::env::temp_dir().join(format!("cc-updates-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("server")).unwrap();
        write_version_file(&dir, "0.2.0").unwrap();
        assert_eq!(read_version_file(&dir).unwrap().to_string(), "0.2.0");
        let _ = fs::remove_dir_all(dir);
        assert!(local_server::targets_local_server("", 8080));
        assert!(local_server::targets_local_server(
            "http://127.0.0.1:8080",
            8080
        ));
        assert!(!local_server::targets_local_server(
            "http://100.101.141.93:8080",
            8080
        ));
        assert!(!local_server::targets_local_server(
            "http://127.0.0.1:9090",
            8080
        ));
    }

    #[test]
    #[ignore = "talks to GitHub; run with --ignored when you want a live check"]
    fn live_github_releases_parse() {
        let app = fetch_releases(APP_REPO).expect("command center releases");
        let auth = fetch_releases(AUTH_REPO).expect("auth-server releases");
        let app_status = app_selection(&ver("0.1.0"), &app, "windows", "x86_64");
        let auth_status = auth_selection(None, &auth, "linux", "x86_64", AuthPlace::Absent);
        eprintln!("app: {}", app_status.message);
        eprintln!("auth: {}", auth_status.message);
        assert!(!app_status.message.is_empty());
        assert!(!auth_status.message.is_empty());
    }

    #[test]
    fn file_names_cannot_escape_the_updates_folder() {
        assert!(safe_file_name("Command.Center_0.2.0_x64-setup.exe").is_ok());
        assert!(safe_file_name("../auth-server.exe").is_err());
        assert!(safe_file_name("a/b.exe").is_err());
        assert!(safe_file_name("").is_err());
    }

    #[test]
    fn replace_file_overwrites_bytes() {
        let dir = std::env::temp_dir().join(format!("cc-replace-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("auth-server");
        fs::write(&dest, b"old").unwrap();
        replace_file(&dest, b"new-bytes").unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"new-bytes");
        let _ = fs::remove_dir_all(dir);
    }
}
