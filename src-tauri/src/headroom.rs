// Headroom context compression (https://github.com/headroomlabs-ai/headroom), run as a local
// service in front of the CPA proxy: apps -> Headroom (8787) -> CPA proxy (8317) -> providers.
// Like the proxy it is an independent process, so closing the GUI never interrupts a session.
// Telemetry, the upload beacon, update checks and Headroom's own quota polling stay off: the
// hub already tracks quota, and nothing here should leave the machine on Headroom's behalf.
// Routing: while compression is on, the managed Claude Code and Claude Desktop configs point at
// Headroom instead of the proxy. Only the address string is swapped, after a backup, and the
// watchdog swaps it back if Headroom stops answering, so apps never lose their connection.

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::core_runtime::{configure_background_command, core_base_dir};
use crate::{agent_config_paths, managed_core_loopback_origin, AgentClient};

pub(crate) const HEADROOM_PORT: u16 = 8787;
const SETTINGS_FILE: &str = "headroom.json";
const PID_FILE: &str = "headroom.pid";
const LOG_FILE: &str = "headroom.log";
const BACKUP_SUFFIX: &str = ".before-compression-switch";
const ROUTABLE_CLIENTS: [AgentClient; 2] = [AgentClient::ClaudeCode, AgentClient::ClaudeDesktop];

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeadroomSettings {
    #[serde(default)]
    enabled: bool,
    #[serde(default = "default_true")]
    route_claude_code: bool,
    #[serde(default = "default_true")]
    route_claude_desktop: bool,
    /// Whether app configs currently point at Headroom. Differs from `enabled` while the
    /// watchdog has fallen back to the proxy because Headroom stopped answering.
    #[serde(default)]
    routed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
    /// Headroom's persistent memory (adds memory save/search tools to requests). Opt-in.
    #[serde(default)]
    memory: bool,
}

fn default_true() -> bool {
    true
}

impl Default for HeadroomSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            route_claude_code: true,
            route_claude_desktop: true,
            routed: false,
            last_error: None,
            memory: false,
        }
    }
}

impl HeadroomSettings {
    fn routes(&self, client: AgentClient) -> bool {
        match client {
            AgentClient::ClaudeCode => self.route_claude_code,
            AgentClient::ClaudeDesktop => self.route_claude_desktop,
            _ => false,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HeadroomStatus {
    installed: bool,
    binary: Option<String>,
    enabled: bool,
    running: bool,
    port: u16,
    proxy_port: u16,
    log_path: Option<String>,
    route_claude_code: bool,
    route_claude_desktop: bool,
    routed: bool,
    last_error: Option<String>,
    memory: bool,
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(core_base_dir()?.join(SETTINGS_FILE))
}

fn read_settings() -> HeadroomSettings {
    if cfg!(test) {
        return HeadroomSettings::default();
    }
    settings_path()
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_settings(settings: &HeadroomSettings) -> Result<(), String> {
    let text = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(settings_path()?, text).map_err(|error| format!("Failed to save compression settings: {error}"))
}

/// `uv tool install headroom-ai` puts the launcher in ~/.local/bin; fall back to PATH.
fn find_binary() -> Option<PathBuf> {
    let name = if cfg!(windows) { "headroom.exe" } else { "headroom" };
    let home = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    if let Some(candidate) = home.map(|home| home.join(".local").join("bin").join(name)) {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    env::var_os("PATH").and_then(|paths| {
        env::split_paths(&paths).map(|dir| dir.join(name)).find(|candidate| candidate.is_file())
    })
}

fn proxy_port(app: &tauri::AppHandle) -> u16 {
    use tauri::Manager;
    app.try_state::<crate::GuiConfigState>()
        .and_then(|state| state.snapshot().ok())
        .map(|config| config.port)
        .filter(|port| *port != 0)
        .unwrap_or(8317)
}

fn headroom_origin() -> String {
    format!("http://127.0.0.1:{HEADROOM_PORT}")
}

/// The address the hub writes into, and expects to find in, an app's config.
pub(crate) fn agent_origin(client: AgentClient, port: u16) -> String {
    let settings = read_settings();
    if settings.routed && settings.routes(client) {
        headroom_origin()
    } else {
        managed_core_loopback_origin(port)
    }
}

/// Replace quoted occurrences of `from` (alone, or followed by a path) with `to`. Everything
/// else in the text is left as it was.
fn swap_address_text(text: &str, from: &str, to: &str) -> String {
    text.replace(&format!("\"{from}\""), &format!("\"{to}\""))
        .replace(&format!("\"{from}/"), &format!("\"{to}/"))
}

fn swap_addresses(app: &tauri::AppHandle, clients: &[AgentClient], from: &str, to: &str) -> Result<(), String> {
    use tauri::Manager;
    let Ok(home) = app.path().home_dir() else {
        return Ok(());
    };
    for client in clients {
        for path in agent_config_paths(*client, &home) {
            let Ok(text) = fs::read_to_string(&path) else { continue };
            let updated = swap_address_text(&text, from, to);
            if updated == text {
                continue;
            }
            let mut backup = path.clone().into_os_string();
            backup.push(BACKUP_SUFFIX);
            fs::copy(&path, PathBuf::from(backup))
                .map_err(|error| format!("Failed to back up {}: {error}", path.display()))?;
            let mut temp = path.clone().into_os_string();
            temp.push(".compression-tmp");
            let temp = PathBuf::from(temp);
            fs::write(&temp, &updated).map_err(|error| format!("Failed to update {}: {error}", path.display()))?;
            fs::rename(&temp, &path).map_err(|error| format!("Failed to update {}: {error}", path.display()))?;
        }
    }
    Ok(())
}

fn route_apps(app: &tauri::AppHandle, settings: &mut HeadroomSettings, routed: bool) -> Result<(), String> {
    if settings.routed == routed {
        return Ok(());
    }
    let clients: Vec<AgentClient> = ROUTABLE_CLIENTS
        .into_iter()
        .filter(|client| settings.routes(*client))
        .collect();
    let proxy = managed_core_loopback_origin(proxy_port(app));
    let headroom = headroom_origin();
    if routed {
        swap_addresses(app, &clients, &proxy, &headroom)?;
    } else {
        swap_addresses(app, &clients, &headroom, &proxy)?;
    }
    settings.routed = routed;
    write_settings(settings)
}

async fn get_json(path: &str, timeout: Duration) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .no_proxy()
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(format!("http://127.0.0.1:{HEADROOM_PORT}{path}"))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Compression service returned HTTP {}", response.status().as_u16()));
    }
    response.json::<Value>().await.map_err(|error| error.to_string())
}

async fn is_running() -> bool {
    get_json("/health", Duration::from_millis(1500))
        .await
        .map(|health| health.get("status").and_then(Value::as_str) == Some("healthy"))
        .unwrap_or(false)
}

fn spawn(binary: &PathBuf, proxy_port: u16, memory: bool) -> Result<(), String> {
    let base = core_base_dir()?;
    let log = fs::File::create(base.join(LOG_FILE)).map_err(|error| format!("Failed to open compression log: {error}"))?;
    let log_err = log.try_clone().map_err(|error| error.to_string())?;
    let upstream = format!("http://127.0.0.1:{proxy_port}");
    let mut command = Command::new(binary);
    command
        .args([
            "proxy",
            "--port",
            &HEADROOM_PORT.to_string(),
            "--anthropic-api-url",
            &upstream,
            "--openai-api-url",
            &format!("{upstream}/v1"),
            "--no-subscription-tracking",
        ])
        .args(if memory { &["--memory", "--memory-storage", "project"][..] } else { &[][..] })
        .env("HEADROOM_BEACON", "off")
        .env("DO_NOT_TRACK", "1")
        .env("HEADROOM_UPDATE_CHECK", "off")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    configure_background_command(&mut command);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Own process group, outside the GUI's job, so it outlives the GUI like the proxy does.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB);
    }
    let child = command.spawn().map_err(|error| format!("Failed to start compression service: {error}"))?;
    fs::write(base.join(PID_FILE), child.id().to_string()).ok();
    Ok(())
}

fn stop_process() {
    let Ok(base) = core_base_dir() else { return };
    let pid_path = base.join(PID_FILE);
    if let Some(pid) = fs::read_to_string(&pid_path).ok().and_then(|text| text.trim().parse::<u32>().ok()) {
        #[cfg(windows)]
        {
            let mut command = Command::new("taskkill");
            command
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            configure_background_command(&mut command);
            let _ = command.status();
        }
        #[cfg(not(windows))]
        {
            let _ = Command::new("kill").arg(pid.to_string()).status();
        }
    }
    let _ = fs::remove_file(pid_path);
}

/// Stop any Headroom serving our port that the PID file no longer points at (e.g. after the hub
/// restarted it). Matches the exact command line the hub starts, so nothing else is touched.
fn stop_strays() {
    let pattern = format!("proxy --port {HEADROOM_PORT}");
    #[cfg(windows)]
    {
        let script = format!(
            "Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like '*headroom*' -and $_.CommandLine -like '*{pattern}*' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}"
        );
        let mut command = Command::new("powershell");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_background_command(&mut command);
        let _ = command.status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("pkill").args(["-f", &format!("headroom.*{pattern}")]).status();
    }
}

fn stop_service() {
    stop_process();
    stop_strays();
}

async fn wait_until(running: bool, attempts: u32) -> bool {
    for _ in 0..attempts {
        if is_running().await == running {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    false
}

async fn start_service(app: &tauri::AppHandle) -> Result<(), String> {
    if is_running().await {
        return Ok(());
    }
    let binary = find_binary().ok_or_else(|| "Headroom is not installed".to_string())?;
    spawn(&binary, proxy_port(app), read_settings().memory)?;
    if wait_until(true, 90).await {
        Ok(())
    } else {
        Err("Compression service did not become ready".to_string())
    }
}

/// Bring the service and routing in line with the setting. If Headroom can't be reached, apps
/// are pointed back at the proxy so they keep working; the next tick routes them again.
pub(crate) async fn ensure_running(app: &tauri::AppHandle) -> Result<(), String> {
    let mut settings = read_settings();
    if !settings.enabled {
        return route_apps(app, &mut settings, false);
    }
    match start_service(app).await {
        Ok(()) => {
            settings.last_error = None;
            route_apps(app, &mut settings, true)
        }
        Err(error) => {
            settings.last_error = Some(error.clone());
            route_apps(app, &mut settings, false)?;
            Err(error)
        }
    }
}

/// Keep the service up while compression is on (Headroom's own app does the same after a crash).
pub(crate) fn start_watchdog(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let _ = ensure_running(&app).await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });
}

#[tauri::command]
pub(crate) async fn headroom_status(app: tauri::AppHandle) -> Result<HeadroomStatus, String> {
    let binary = find_binary();
    let settings = read_settings();
    Ok(HeadroomStatus {
        installed: binary.is_some(),
        binary: binary.map(|path| path.to_string_lossy().into_owned()),
        enabled: settings.enabled,
        running: is_running().await,
        port: HEADROOM_PORT,
        proxy_port: proxy_port(&app),
        log_path: core_base_dir().ok().map(|base| base.join(LOG_FILE).to_string_lossy().into_owned()),
        route_claude_code: settings.route_claude_code,
        route_claude_desktop: settings.route_claude_desktop,
        routed: settings.routed,
        last_error: settings.last_error,
        memory: settings.memory,
    })
}

#[tauri::command]
pub(crate) async fn headroom_set_enabled(app: tauri::AppHandle, enabled: bool) -> Result<HeadroomStatus, String> {
    let mut settings = read_settings();
    settings.enabled = enabled;
    write_settings(&settings)?;
    if enabled {
        if let Err(error) = ensure_running(&app).await {
            // Leave compression off rather than half-on when the first start fails.
            let mut settings = read_settings();
            settings.enabled = false;
            write_settings(&settings)?;
            stop_process();
            return Err(error);
        }
    } else {
        route_apps(&app, &mut settings, false)?;
        stop_service();
        wait_until(false, 20).await;
    }
    headroom_status(app).await
}

/// Stop the service while compression is off. Apps are already pointed at the proxy, so this only
/// ends the background process; turning compression on starts it again.
#[tauri::command]
pub(crate) async fn headroom_stop_service(app: tauri::AppHandle) -> Result<HeadroomStatus, String> {
    let mut settings = read_settings();
    if settings.enabled {
        return Err("Turn compression off before stopping the service".to_string());
    }
    route_apps(&app, &mut settings, false)?;
    stop_service();
    if !wait_until(false, 20).await {
        return Err("Compression service is still running".to_string());
    }
    headroom_status(app).await
}

/// Choose which apps go through compression. Takes effect immediately when it is on.
#[tauri::command]
pub(crate) async fn headroom_set_routes(
    app: tauri::AppHandle,
    claude_code: bool,
    claude_desktop: bool,
) -> Result<HeadroomStatus, String> {
    let mut settings = read_settings();
    let was_routed = settings.routed;
    route_apps(&app, &mut settings, false)?;
    settings.route_claude_code = claude_code;
    settings.route_claude_desktop = claude_desktop;
    write_settings(&settings)?;
    if was_routed {
        route_apps(&app, &mut settings, true)?;
    }
    headroom_status(app).await
}

/// Turn Headroom's memory on or off. A running service restarts so the change applies; apps are
/// pointed at the proxy during the restart and back afterwards.
#[tauri::command]
pub(crate) async fn headroom_set_memory(app: tauri::AppHandle, memory: bool) -> Result<HeadroomStatus, String> {
    let mut settings = read_settings();
    settings.memory = memory;
    write_settings(&settings)?;
    if settings.enabled && is_running().await {
        route_apps(&app, &mut settings, false)?;
        stop_process();
        wait_until(false, 20).await;
        ensure_running(&app).await?;
    }
    headroom_status(app).await
}

/// The parts of Headroom's /stats the Compression page shows.
#[tauri::command]
pub(crate) async fn headroom_stats() -> Result<Value, String> {
    let stats = get_json("/stats", Duration::from_secs(5)).await?;
    let pick = |key: &str| stats.get(key).cloned().unwrap_or(Value::Null);
    Ok(serde_json::json!({
        "summary": pick("summary"),
        "agentUsage": pick("agent_usage"),
        "savingsHistory": pick("savings_history"),
        "persistentSavings": pick("persistent_savings"),
        "compressionsByStrategy": pick("compressions_by_strategy"),
        "tokensSavedByStrategy": pick("tokens_saved_by_strategy"),
        "recentRequests": pick("recent_requests"),
    }))
}

/// One file `headroom learn` proposes to write, as it would look after writing.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LearnProposal {
    path: String,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LearnPreview {
    summary: Option<String>,
    proposals: Vec<LearnProposal>,
    output: String,
}

const LEARN_TARGET: &str = "CLAUDE.local.md";
const LEARN_MODEL: &str = "openai/claude-sonnet-4-6";

/// Pull the "[WOULD WRITE] <path>" blocks out of a dry run. Each block is the whole file after
/// writing, framed by rule lines and indented two spaces.
fn parse_learn_output(output: &str) -> Vec<LearnProposal> {
    let mut proposals = Vec::new();
    let mut lines = output.lines().peekable();
    while let Some(line) = lines.next() {
        let Some(path) = line.trim().strip_prefix("[WOULD WRITE]") else { continue };
        let path = path.trim().to_string();
        if lines.peek().is_some_and(|next| next.trim().starts_with('─')) {
            lines.next();
        }
        let mut body = Vec::new();
        for line in lines.by_ref() {
            if line.trim().starts_with('─') {
                break;
            }
            body.push(line.strip_prefix("  ").unwrap_or(line));
        }
        while body.last().is_some_and(|line| line.trim().is_empty()) {
            body.pop();
        }
        proposals.push(LearnProposal { path, content: format!("{}\n", body.join("\n")) });
    }
    proposals
}

/// Only the personal, git-ignored CLAUDE.local.md is offered. Learn also wants to append to the
/// memory index (MEMORY.md), which is meant to stay one line per memory, so that is never written.
fn is_learn_target(path: &str) -> bool {
    std::path::Path::new(path).file_name().and_then(|name| name.to_str()) == Some(LEARN_TARGET)
}

/// Dry-run `headroom learn` for one project. Analysis goes through the proxy: learn sends Claude
/// model names straight to api.anthropic.com, so an OpenAI-style name is used to keep the request
/// on this machine, and LiteLLM's price-list download is switched off.
#[tauri::command]
pub(crate) async fn headroom_learn_preview(app: tauri::AppHandle, project: String) -> Result<LearnPreview, String> {
    use tauri::Manager;
    let binary = find_binary().ok_or_else(|| "Headroom is not installed".to_string())?;
    let project_path = PathBuf::from(project.trim());
    if !project_path.is_dir() {
        return Err(format!("Folder not found: {}", project_path.display()));
    }
    let config = app
        .try_state::<crate::GuiConfigState>()
        .and_then(|state| state.snapshot().ok())
        .ok_or_else(|| "Hub settings are not loaded yet".to_string())?;
    let api_key = crate::effective_agent_api_key(&config).to_string();
    if api_key.is_empty() {
        return Err("The proxy has no client key to use for the analysis".to_string());
    }
    let base = format!("{}/v1", managed_core_loopback_origin(proxy_port(&app)));
    let output = tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new(binary);
        command
            .args(["learn", "--project"])
            .arg(&project_path)
            .args(["--agent", "claude", "--model", LEARN_MODEL, "--main-only"])
            .env_remove("ANTHROPIC_API_KEY")
            .env_remove("ANTHROPIC_BASE_URL")
            .env_remove("ANTHROPIC_API_BASE")
            .env_remove("ANTHROPIC_AUTH_TOKEN")
            .env("OPENAI_API_KEY", &api_key)
            .env("OPENAI_BASE_URL", &base)
            .env("LITELLM_LOCAL_MODEL_COST_MAP", "True")
            .env("HEADROOM_BEACON", "off")
            .env("DO_NOT_TRACK", "1")
            .env("HEADROOM_UPDATE_CHECK", "off")
            .env("PYTHONIOENCODING", "utf-8")
            .env("NO_PROXY", "127.0.0.1,localhost")
            .stdin(Stdio::null());
        configure_background_command(&mut command);
        command.output().map(|output| (output, api_key))
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| format!("Failed to run the analysis: {error}"))?;
    let (output, api_key) = output;
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
    .replace(&api_key, "<key>");
    let summary = text
        .lines()
        .find(|line| line.trim_start().starts_with("Sessions:"))
        .map(|line| line.trim().to_string());
    let proposals = parse_learn_output(&text).into_iter().filter(|p| is_learn_target(&p.path)).collect();
    Ok(LearnPreview { summary, proposals, output: text })
}

/// Write a CLAUDE.local.md the preview proposed, keeping a backup of the old one.
#[tauri::command]
pub(crate) fn headroom_learn_apply(path: String, content: String) -> Result<(), String> {
    if !is_learn_target(&path) {
        return Err(format!("Only {LEARN_TARGET} can be written"));
    }
    let path = PathBuf::from(path);
    if path.is_file() {
        let mut backup = path.clone().into_os_string();
        backup.push(".before-learn");
        fs::copy(&path, PathBuf::from(backup)).map_err(|error| format!("Failed to back up {}: {error}", path.display()))?;
    }
    fs::write(&path, content).map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::swap_address_text;

    #[test]
    fn swaps_only_quoted_addresses() {
        let from = "http://127.0.0.1:8317";
        let to = "http://127.0.0.1:8787";
        let text = r#"{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:8317","OTHER":"http://127.0.0.1:83170"},"u":"http://127.0.0.1:8317/v1","note":"see http://127.0.0.1:8317 docs"}"#;
        let swapped = swap_address_text(text, from, to);
        assert!(swapped.contains(r#""ANTHROPIC_BASE_URL":"http://127.0.0.1:8787""#));
        assert!(swapped.contains(r#""u":"http://127.0.0.1:8787/v1""#));
        assert!(swapped.contains(r#""OTHER":"http://127.0.0.1:83170""#));
        assert!(swapped.contains("see http://127.0.0.1:8317 docs"));
        assert_eq!(swap_address_text(&swapped, to, from), text);
    }

    #[test]
    fn toml_strings_swap_too() {
        let text = "base_url = \"http://127.0.0.1:8317/v1\"\n";
        assert_eq!(
            swap_address_text(text, "http://127.0.0.1:8317", "http://127.0.0.1:8787"),
            "base_url = \"http://127.0.0.1:8787/v1\"\n"
        );
    }

    #[test]
    fn parses_learn_dry_run_blocks_and_keeps_only_claude_local() {
        use super::{is_learn_target, parse_learn_output};
        let output = "  Sessions: 4  |  Calls: 10\n\n  [WOULD WRITE] C:/p/CLAUDE.local.md\n  ────────\n  ## Headroom Learned Patterns\n  - one\n  \n  ────────\n\n  [WOULD WRITE] C:/x/memory/MEMORY.md\n  ────────\n  - index\n  ────────\n  Dry run — use --apply to write.\n";
        let proposals = parse_learn_output(output);
        assert_eq!(proposals.len(), 2);
        assert_eq!(proposals[0].path, "C:/p/CLAUDE.local.md");
        assert_eq!(proposals[0].content, "## Headroom Learned Patterns\n- one\n");
        assert!(is_learn_target(&proposals[0].path));
        assert!(!is_learn_target(&proposals[1].path));
        assert!(!is_learn_target("C:/p/CLAUDE.md"));
    }
}
