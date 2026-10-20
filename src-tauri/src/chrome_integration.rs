//! Claude in Chrome: what's installed and what's linked, read-only.
//!
//! The extension isn't an MCP server the hub can switch on. Claude Code links to it through a native messaging
//! host it registers the first time Chrome is turned on (`claude --chrome` or `/chrome`), and only when Claude
//! Code is signed in with an account: a token or API key, as the hub's proxy routing uses, keeps it off.
//! So this reports the three things that decide whether it works and leaves every change to the user.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

pub(crate) const EXTENSION_ID: &str = "fcoeoabgfenejglbffodgkkbkcdhcgfn";
const NATIVE_HOST: &str = "com.anthropic.claude_code_browser_extension";
const STORE_URL: &str = "https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn";
/// The oldest extension version Claude Code works with.
const MIN_VERSION: [u32; 3] = [1, 0, 36];

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChromeBrowserState {
    id: &'static str,
    name: &'static str,
    /// The browser has a profile folder on this computer.
    installed: bool,
    /// Highest extension version found in any profile.
    extension_version: Option<String>,
    extension_too_old: bool,
    /// Claude Code's native messaging host is registered for this browser and its manifest exists.
    linked: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChromeIntegration {
    browsers: Vec<ChromeBrowserState>,
    /// Claude Code authenticates with a token or API key from its settings or the environment.
    token_auth: bool,
    /// That token sends Claude Code through a proxy on this computer, such as the hub's.
    routed_through_local_proxy: bool,
    store_url: &'static str,
}

struct BrowserSpec {
    id: &'static str,
    name: &'static str,
    /// Under %LOCALAPPDATA% on Windows.
    user_data: &'static str,
    /// Under HKCU\Software.
    registry: &'static str,
}

const BROWSERS: [BrowserSpec; 2] = [
    BrowserSpec { id: "chrome", name: "Google Chrome", user_data: r"Google\Chrome\User Data", registry: r"Google\Chrome" },
    BrowserSpec { id: "edge", name: "Microsoft Edge", user_data: r"Microsoft\Edge\User Data", registry: r"Microsoft\Edge" },
];

fn parse_version(value: &str) -> Option<Vec<u32>> {
    // Profile folders are named "1.0.101_0"; the suffix after "_" is Chrome's install counter.
    let version = value.split('_').next()?;
    version.split('.').map(|part| part.parse().ok()).collect()
}

/// The highest extension version installed in any profile of a browser's user data folder.
fn extension_version(user_data: &Path) -> Option<String> {
    let mut best: Option<(Vec<u32>, String)> = None;
    for profile in fs::read_dir(user_data).ok()?.flatten() {
        let Ok(versions) = fs::read_dir(profile.path().join("Extensions").join(EXTENSION_ID)) else { continue };
        for version in versions.flatten() {
            let name = version.file_name().to_string_lossy().to_string();
            let Some(parsed) = parse_version(&name) else { continue };
            if best.as_ref().is_none_or(|(current, _)| parsed > *current) {
                let shown = name.split('_').next().unwrap_or(&name).to_string();
                best = Some((parsed, shown));
            }
        }
    }
    best.map(|(_, shown)| shown)
}

fn too_old(version: &str) -> bool {
    parse_version(version).is_some_and(|parsed| parsed < MIN_VERSION.to_vec())
}

/// The manifest path from `reg query ... /ve` output, e.g. "    (Default)    REG_SZ    C:\path\host.json".
fn manifest_from_reg_output(output: &str) -> Option<PathBuf> {
    output.lines().find_map(|line| {
        let (_, value) = line.split_once("REG_SZ")?;
        let value = value.trim();
        (!value.is_empty()).then(|| PathBuf::from(value))
    })
}

#[cfg(windows)]
fn native_host_manifest(registry: &str) -> Option<PathBuf> {
    use std::process::{Command, Stdio};
    let key = format!(r"HKCU\Software\{registry}\NativeMessagingHosts\{NATIVE_HOST}");
    let mut command = Command::new("reg");
    command.args(["query", &key, "/ve"]).stdin(Stdio::null()).stderr(Stdio::null());
    crate::core_runtime::configure_background_command(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    manifest_from_reg_output(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(not(windows))]
fn native_host_manifest(_registry: &str) -> Option<PathBuf> {
    None
}

/// Token or API key auth in Claude Code's user settings `env` block or the hub's own environment,
/// and whether its base URL points at this computer.
fn claude_code_auth(settings: Option<&Value>, environment: &dyn Fn(&str) -> Option<String>) -> (bool, bool) {
    let from_settings = |name: &str| {
        settings
            .and_then(|value| value.get("env"))
            .and_then(|env| env.get(name))
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|value| !value.trim().is_empty())
    };
    let read = |name: &str| from_settings(name).or_else(|| environment(name).filter(|value| !value.trim().is_empty()));
    let token_auth = read("ANTHROPIC_AUTH_TOKEN").is_some() || read("ANTHROPIC_API_KEY").is_some();
    let local = read("ANTHROPIC_BASE_URL").is_some_and(|url| {
        let url = url.to_ascii_lowercase();
        ["://127.0.0.1", "://localhost", "://[::1]"].iter().any(|host| url.contains(host))
    });
    (token_auth, token_auth && local)
}

fn inspect(home: &Path, local_app_data: Option<&Path>) -> ChromeIntegration {
    let browsers = BROWSERS
        .iter()
        .map(|spec| {
            let user_data = local_app_data.map(|base| base.join(spec.user_data));
            let installed = user_data.as_deref().is_some_and(Path::is_dir);
            let version = user_data.as_deref().and_then(extension_version);
            ChromeBrowserState {
                id: spec.id,
                name: spec.name,
                installed,
                extension_too_old: version.as_deref().is_some_and(too_old),
                extension_version: version,
                linked: native_host_manifest(spec.registry).is_some_and(|manifest| manifest.is_file()),
            }
        })
        .collect();
    let settings = fs::read_to_string(home.join(".claude").join("settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let (token_auth, routed_through_local_proxy) =
        claude_code_auth(settings.as_ref(), &|name| std::env::var(name).ok());
    ChromeIntegration { browsers, token_auth, routed_through_local_proxy, store_url: STORE_URL }
}

#[tauri::command]
pub(crate) async fn get_chrome_integration() -> Result<ChromeIntegration, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let home = dirs_home().ok_or_else(|| "Couldn't find your user folder".to_string())?;
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        Ok(inspect(&home, local.as_deref()))
    })
    .await
    .map_err(|error| format!("Chrome check failed: {error}"))?
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cpa-chrome-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn finds_the_highest_extension_version_across_profiles() {
        let data = temp("versions");
        for (profile, version) in [("Default", "1.0.100_0"), ("Default", "1.0.101_0"), ("Profile 2", "1.0.99_1")] {
            fs::create_dir_all(data.join(profile).join("Extensions").join(EXTENSION_ID).join(version)).unwrap();
        }
        fs::create_dir_all(data.join("Profile 3").join("Extensions").join("someotherextension").join("9.9.9_0")).unwrap();
        assert_eq!(extension_version(&data).as_deref(), Some("1.0.101"));
        assert_eq!(extension_version(&data.join("missing")), None);
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn compares_versions_numerically() {
        assert!(too_old("1.0.35"));
        assert!(!too_old("1.0.36"));
        assert!(!too_old("1.0.101"));
        assert!(!too_old("2.0.0"));
    }

    #[test]
    fn reads_the_manifest_path_from_reg_output() {
        let output = "\r\nHKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.anthropic.claude_code_browser_extension\r\n    (Default)    REG_SZ    C:\\Users\\me\\AppData\\Roaming\\Claude Code\\host.json\r\n\r\n";
        assert_eq!(manifest_from_reg_output(output), Some(PathBuf::from(r"C:\Users\me\AppData\Roaming\Claude Code\host.json")));
        assert_eq!(manifest_from_reg_output("ERROR: not found"), None);
    }

    #[test]
    fn token_auth_through_a_local_proxy_is_reported() {
        let none = |_: &str| None;
        let proxy = json!({ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8317", "ANTHROPIC_AUTH_TOKEN": "x" } });
        assert_eq!(claude_code_auth(Some(&proxy), &none), (true, true));
        let remote = json!({ "env": { "ANTHROPIC_BASE_URL": "https://gateway.example.com", "ANTHROPIC_API_KEY": "x" } });
        assert_eq!(claude_code_auth(Some(&remote), &none), (true, false));
        assert_eq!(claude_code_auth(Some(&json!({ "env": { "ANTHROPIC_AUTH_TOKEN": " " } })), &none), (false, false));
        assert_eq!(claude_code_auth(None, &none), (false, false));
        let environment = |name: &str| (name == "ANTHROPIC_API_KEY").then(|| "x".to_string());
        assert_eq!(claude_code_auth(None, &environment), (true, false));
    }

    #[test]
    fn inspect_reports_installed_browsers_without_the_extension() {
        let home = temp("home");
        let local = temp("local");
        fs::create_dir_all(local.join(r"Google\Chrome\User Data").join("Default")).unwrap();
        let result = inspect(&home, Some(&local));
        let chrome = &result.browsers[0];
        assert!(chrome.installed);
        assert_eq!(chrome.extension_version, None);
        assert!(!result.browsers[1].installed);
        assert_eq!(result.browsers[1].extension_version, None);
        fs::remove_dir_all(home).unwrap();
        fs::remove_dir_all(local).unwrap();
    }
}
