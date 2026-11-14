use crate::config::{self, ConfigError};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

const SERVICE: &str = "command-center";
const FALLBACK_FILE: &str = "secrets.local.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct FallbackStore {
    secrets: BTreeMap<String, String>,
}

fn fallback_path() -> Result<PathBuf, ConfigError> {
    let paths = config::resolve_paths()?;
    Ok(PathBuf::from(paths.root).join(FALLBACK_FILE))
}

fn read_fallback() -> Result<FallbackStore, ConfigError> {
    let path = fallback_path()?;
    if !path.exists() {
        return Ok(FallbackStore::default());
    }
    let raw = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&raw)?)
}

fn write_fallback(store: &FallbackStore) -> Result<(), ConfigError> {
    let paths = config::resolve_paths()?;
    config::ensure_dirs(&paths)?;
    let path = fallback_path()?;
    let raw = serde_json::to_string_pretty(store)?;
    fs::write(path, raw)?;
    Ok(())
}

/// Store a secret in the OS keyring when possible; otherwise a local file under the config root.
pub fn set_secret(name: &str, value: &str) -> Result<(), ConfigError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return delete_secret(name);
    }

    match keyring::Entry::new(SERVICE, name) {
        Ok(entry) => match entry.set_password(trimmed) {
            Ok(()) => {
                // Keep fallback clean if keyring works.
                if let Ok(mut store) = read_fallback() {
                    if store.secrets.remove(name).is_some() {
                        let _ = write_fallback(&store);
                    }
                }
                Ok(())
            }
            Err(_) => set_fallback(name, trimmed),
        },
        Err(_) => set_fallback(name, trimmed),
    }
}

fn set_fallback(name: &str, value: &str) -> Result<(), ConfigError> {
    let mut store = read_fallback()?;
    store.secrets.insert(name.to_string(), value.to_string());
    write_fallback(&store)
}

pub fn get_secret(name: &str) -> Result<Option<String>, ConfigError> {
    if let Ok(entry) = keyring::Entry::new(SERVICE, name) {
        if let Ok(value) = entry.get_password() {
            if !value.trim().is_empty() {
                return Ok(Some(value));
            }
        }
    }
    let store = read_fallback()?;
    Ok(store.secrets.get(name).cloned())
}

pub fn delete_secret(name: &str) -> Result<(), ConfigError> {
    if let Ok(entry) = keyring::Entry::new(SERVICE, name) {
        let _ = entry.delete_credential();
    }
    let mut store = read_fallback()?;
    if store.secrets.remove(name).is_some() {
        write_fallback(&store)?;
    }
    Ok(())
}

pub fn fallback_names() -> Result<Vec<String>, ConfigError> {
    Ok(read_fallback()?.secrets.keys().cloned().collect())
}

pub fn set_secrets(secrets: &BTreeMap<String, String>) -> Result<(), ConfigError> {
    for (name, value) in secrets {
        set_secret(name, value)?;
    }
    Ok(())
}
