//! App Routing: a CLIProxyAPI scheduler plugin that decides which account pays for an app's requests.
//!
//! The hub writes one rule per app: the accounts it may use (and the providers they belong to), and whether it may
//! fall back to the rest. For a request from an app with a rule, the plugin picks the highest account in the routing
//! order (the proxy's priority) that's on the app's list and can take the request now. Apps without a rule, and
//! providers a rule doesn't cover, are declined, so the proxy routes them exactly as it would without this plugin.
//!
//! Conversations stay on one account: the plugin remembers which account each conversation (by its session header)
//! was given, and keeps it there while that account is still on the list and available. The proxy's own session
//! affinity can't do this for requests the plugin picks, and its lookup is unavailable while a scheduler plugin is
//! loaded, so the memory lives here.

#[allow(dead_code)]
#[path = "../../secret-guard/src/apps.rs"]
mod apps;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::ffi::CStr;
use std::os::raw::c_char;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

pub use apps::client_app;

const ABI_VERSION: u32 = 1;
const SCHEMA_VERSION: u32 = 6;
const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Conversations remembered at most; past this, ones idle longest are forgotten first.
const MAX_SESSIONS: usize = 10_000;
const DEFAULT_STICKY_MINUTES: u64 = 60;
/// Headers the proxy itself reads a conversation id from (selector.go), in its order. The body ids it also uses
/// aren't given to schedulers.
const SESSION_HEADERS: &[&str] = &[
    "x-claude-code-session-id", "session-id", "session_id", "x-session-id", "x-session-affinity", "x-client-request-id",
];

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Rule {
    /// Account file names (or proxy auth ids) the app may use.
    #[serde(default)]
    pub accounts: Vec<String>,
    /// Providers the rule covers; requests to other providers are left to the proxy. Empty covers all.
    #[serde(default)]
    pub providers: Vec<String>,
    /// Refuse rather than fall back to other accounts when none of the app's can take the request.
    #[serde(default)]
    pub only: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub rules: BTreeMap<String, Rule>,
    #[serde(default)]
    pub sticky_minutes: Option<u64>,
}

#[derive(Default)]
struct State {
    config: Config,
    /// Conversation key -> (auth id, last used, seconds).
    sessions: HashMap<String, (String, u64)>,
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State::default()))
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The proxy's provider names and the hub's differ in places; both sides go through this before comparing.
fn provider_key(value: &str) -> String {
    let value = value.trim().to_ascii_lowercase().replace('_', "-");
    match value.as_str() {
        "anthropic" => "claude".into(),
        "openai" => "codex".into(),
        "cognition" => "devin".into(),
        "anti-gravity" => "antigravity".into(),
        "x-ai" | "grok" => "xai".into(),
        _ => value,
    }
}

/// An account name as both sides can agree on it: the file name, without folders, `.json` or case.
fn account_key(value: &str) -> String {
    let base = value.rsplit(['/', '\\']).next().unwrap_or(value).trim().to_ascii_lowercase();
    base.strip_suffix(".json").map(str::to_string).unwrap_or(base)
}

fn header<'a>(headers: &'a Value, name: &str) -> Option<&'a str> {
    let (_, value) = headers.as_object()?.iter().find(|(key, _)| key.eq_ignore_ascii_case(name))?;
    value.as_array().and_then(|values| values.first()).and_then(Value::as_str).or(value.as_str()).map(str::trim).filter(|v| !v.is_empty())
}

fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    value.get(name).or_else(|| value.get(&name.to_ascii_lowercase()))
}

struct Candidate<'a> {
    id: &'a str,
    provider: String,
    priority: i64,
    names: Vec<String>,
}

fn candidates(request: &Value) -> Vec<Candidate<'_>> {
    let Some(list) = field(request, "Candidates").and_then(Value::as_array) else { return Vec::new() };
    list.iter()
        .filter_map(|candidate| {
            let id = field(candidate, "ID").or_else(|| candidate.get("id")).and_then(Value::as_str)?;
            let mut names = vec![account_key(id)];
            if let Some(attributes) = field(candidate, "Attributes").and_then(Value::as_object) {
                for key in ["path", "file", "file_name", "filename", "name"] {
                    if let Some(value) = attributes.get(key).and_then(Value::as_str) {
                        names.push(account_key(value));
                    }
                }
            }
            Some(Candidate {
                id,
                provider: provider_key(field(candidate, "Provider").and_then(Value::as_str).unwrap_or("")),
                priority: field(candidate, "Priority").and_then(Value::as_i64).unwrap_or(0),
                names,
            })
        })
        .collect()
}

fn app_name(app: &str) -> &'static str {
    match app {
        "claude-desktop" => "Claude Desktop",
        "claude-code" => "Claude Code",
        "codex" => "Codex",
        "opencode" => "OpenCode",
        "openclaw" => "OpenClaw",
        "hermes" => "Hermes",
        "kimi-code" => "Kimi Code",
        "grok-build" => "Grok Build",
        "antigravity-cli" => "Antigravity",
        "zcode" => "ZCode",
        "workbuddy" => "WorkBuddy",
        "deepseek-harness" => "DeepSeek Harness",
        _ => "this app",
    }
}

fn declined() -> Value {
    json!({"Handled": false})
}

/// The pick for one `scheduler.pick` request, at `now` (seconds).
pub fn pick(request: &Value, now: u64) -> Value {
    let headers = field(request, "Options").and_then(|options| field(options, "Headers")).cloned().unwrap_or(Value::Null);
    let app = client_app(header(&headers, "user-agent").unwrap_or(""));
    let mut st = state().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(rule) = st.config.rules.get(app).filter(|rule| !rule.accounts.is_empty()).cloned() else { return declined() };

    let all = candidates(request);
    let mut requested: Vec<String> = field(request, "Providers").and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).map(provider_key).collect()).unwrap_or_default();
    if let Some(primary) = field(request, "Provider").and_then(Value::as_str).filter(|p| !p.is_empty()) {
        requested.push(provider_key(primary));
    }
    requested.extend(all.iter().map(|candidate| candidate.provider.clone()));
    let covered: Vec<String> = rule.providers.iter().map(|p| provider_key(p)).collect();
    if !covered.is_empty() && !requested.iter().any(|provider| covered.contains(provider)) {
        return declined();
    }

    let wanted: Vec<String> = rule.accounts.iter().map(|account| account_key(account)).collect();
    let allowed: Vec<&Candidate> = all.iter().filter(|candidate| candidate.names.iter().any(|name| wanted.contains(name))).collect();

    let ttl = st.config.sticky_minutes.unwrap_or(DEFAULT_STICKY_MINUTES) * 60;
    let session = SESSION_HEADERS.iter().find_map(|name| header(&headers, name));
    let key = session.map(|session| {
        let mut providers = requested.clone();
        providers.sort();
        providers.dedup();
        format!("{app}\u{1f}{}\u{1f}{session}", providers.join(","))
    });

    // The conversation's account, while it's still on the list and can take the request.
    let remembered = key.as_ref()
        .and_then(|key| st.sessions.get(key))
        .filter(|(_, last)| ttl > 0 && now.saturating_sub(*last) <= ttl)
        .and_then(|(id, _)| allowed.iter().find(|candidate| candidate.id == id))
        .map(|candidate| candidate.id.to_string());
    // Otherwise the highest in the routing order; the proxy lists candidates in its own order, so ties keep it.
    let chosen = remembered.or_else(|| {
        allowed.iter().fold(None::<&&Candidate>, |best, candidate| match best {
            Some(best) if best.priority >= candidate.priority => Some(best),
            _ => Some(candidate),
        }).map(|candidate| candidate.id.to_string())
    });

    match chosen {
        Some(id) => {
            if let (Some(key), true) = (key, ttl > 0) {
                st.sessions.insert(key, (id.clone(), now));
                if st.sessions.len() > MAX_SESSIONS {
                    forget_idle(&mut st.sessions, now, ttl);
                }
            }
            json!({"AuthID": id, "Handled": true})
        }
        None if rule.only => json!({
            "Handled": true,
            "Reject": true,
            "RejectCode": "app_routing_only",
            "RejectReason": format!("None of the accounts {} may use can take this request right now. App Routing is set to use only those accounts; change it in the hub.", app_name(app)),
        }),
        None => declined(),
    }
}

/// Drops expired conversations, then the ones idle longest, down to three quarters of the limit.
fn forget_idle(sessions: &mut HashMap<String, (String, u64)>, now: u64, ttl: u64) {
    sessions.retain(|_, (_, last)| now.saturating_sub(*last) <= ttl);
    if sessions.len() <= MAX_SESSIONS * 3 / 4 {
        return;
    }
    let mut by_age: Vec<(String, u64)> = sessions.iter().map(|(key, (_, last))| (key.clone(), *last)).collect();
    by_age.sort_by_key(|(_, last)| *last);
    let excess = sessions.len() - MAX_SESSIONS * 3 / 4;
    for (key, _) in by_age.into_iter().take(excess) {
        sessions.remove(&key);
    }
}

fn configure(request: &[u8]) -> Result<(), String> {
    let value: Value = serde_json::from_slice(request).map_err(|e| e.to_string())?;
    let yaml = match value.get("config_yaml").and_then(Value::as_str) {
        Some(b64) if !b64.is_empty() => B64.decode(b64).map_err(|e| e.to_string())?,
        _ => Vec::new(),
    };
    let config: Config = if yaml.is_empty() { Config::default() } else { serde_yaml::from_slice(&yaml).map_err(|e| format!("app-routing config: {e}"))? };
    let mut st = state().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // A conversation remembered on an account the new rules no longer allow is simply re-picked next time.
    st.config = config;
    Ok(())
}

fn registration() -> Value {
    json!({
        "schema_version": SCHEMA_VERSION,
        "metadata": {
            "Name": "App Routing",
            "Version": VERSION,
            "Author": "Tim's AI Hub",
            // The proxy refuses plugins without a repository link.
            "GitHubRepository": "https://github.com/timrmcclain/EasyCLIProxyAPI",
            "ConfigFields": [
                {"Name": "sticky_minutes", "Type": "integer", "Description": "Minutes a quiet conversation keeps its account."}
            ]
        },
        // Every available account, not just the top priority tier, so an app can be given an account lower down.
        "capabilities": {"scheduler": true, "scheduler_across_priorities": true}
    })
}

fn ok(result: Value) -> String {
    json!({"ok": true, "result": result}).to_string()
}

fn err(code: &str, message: &str) -> String {
    json!({"ok": false, "error": {"code": code, "message": message}}).to_string()
}

pub fn handle(method: &str, request: &[u8]) -> String {
    match method {
        "plugin.register" | "plugin.reconfigure" => match configure(request) {
            Ok(()) => ok(registration()),
            Err(e) => err("invalid_config", &e),
        },
        "scheduler.pick" => match serde_json::from_slice::<Value>(request) {
            Ok(value) => ok(pick(&value, now_secs())),
            Err(_) => ok(declined()),
        },
        _ => err("unknown_method", "unknown method"),
    }
}

// ---- C ABI -----------------------------------------------------------------

#[repr(C)]
pub struct CliproxyBuffer {
    ptr: *mut u8,
    len: usize,
}

type PluginCall = unsafe extern "C" fn(*const c_char, *const u8, usize, *mut CliproxyBuffer) -> i32;
type PluginFree = unsafe extern "C" fn(*mut std::ffi::c_void, usize);
type PluginShutdown = unsafe extern "C" fn();

#[repr(C)]
pub struct CliproxyPluginApi {
    abi_version: u32,
    call: Option<PluginCall>,
    free_buffer: Option<PluginFree>,
    shutdown: Option<PluginShutdown>,
}

/// # Safety
/// Called by the proxy's plugin loader with a valid `plugin` table.
#[no_mangle]
pub unsafe extern "C" fn cliproxy_plugin_init(_host: *const std::ffi::c_void, plugin: *mut CliproxyPluginApi) -> i32 {
    if plugin.is_null() {
        return 1;
    }
    (*plugin).abi_version = ABI_VERSION;
    (*plugin).call = Some(plugin_call);
    (*plugin).free_buffer = Some(plugin_free);
    (*plugin).shutdown = Some(plugin_shutdown);
    0
}

unsafe extern "C" fn plugin_call(method: *const c_char, request: *const u8, request_len: usize, response: *mut CliproxyBuffer) -> i32 {
    if response.is_null() {
        return 1;
    }
    (*response).ptr = std::ptr::null_mut();
    (*response).len = 0;
    let method = if method.is_null() { "" } else { CStr::from_ptr(method).to_str().unwrap_or("") };
    let request = if request.is_null() || request_len == 0 { &[][..] } else { std::slice::from_raw_parts(request, request_len) };
    // A panic must never cross into the proxy: on any failure, leave the pick to the proxy.
    let text = std::panic::catch_unwind(|| handle(method, request)).unwrap_or_else(|_| {
        if method == "scheduler.pick" { ok(declined()) } else { err("plugin_panic", "app-routing failed") }
    });
    let boxed = text.into_bytes().into_boxed_slice();
    (*response).len = boxed.len();
    (*response).ptr = Box::into_raw(boxed) as *mut u8;
    0
}

unsafe extern "C" fn plugin_free(ptr: *mut std::ffi::c_void, len: usize) {
    if !ptr.is_null() {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr as *mut u8, len)));
    }
}

unsafe extern "C" fn plugin_shutdown() {}

#[cfg(test)]
mod tests {
    use super::*;

    // The plugin keeps one global state, as the proxy loads it once; tests that configure it run one at a time.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn configure_yaml(yaml: &str) {
        let request = json!({"config_yaml": B64.encode(yaml)});
        let reply: Value = serde_json::from_str(&handle("plugin.register", request.to_string().as_bytes())).unwrap();
        assert_eq!(reply["ok"], true, "{reply}");
        state().lock().unwrap().sessions.clear();
    }

    const DESKTOP: &str = "claude-cli/2.1.0 (claude-desktop-3p)";
    const CODE: &str = "claude-cli/2.1.0 (external, cli)";

    fn request(user_agent: &str, session: Option<&str>, candidates: &[(&str, i64)]) -> Value {
        let mut headers = json!({"User-Agent": [user_agent]});
        if let Some(session) = session {
            headers["X-Claude-Code-Session-Id"] = json!([session]);
        }
        json!({
            "Provider": "claude", "Providers": ["claude"], "Model": "claude-sonnet-5-5", "Stream": true,
            "Options": {"Headers": headers},
            "Candidates": candidates.iter().map(|(id, priority)| json!({"ID": id, "Provider": "claude", "Priority": priority, "Status": "active"})).collect::<Vec<_>>(),
        })
    }

    const RULES: &str = "rules:\n  claude-desktop:\n    accounts: [work-a@x.com.json, work-b@x.com.json]\n    providers: [anthropic]\n  codex:\n    accounts: [codex-me.json]\n    providers: [codex]\n    only: true\n";

    #[test]
    fn registers_as_a_scheduler_across_priorities() {
        let _serial = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        let reply: Value = serde_json::from_str(&handle("plugin.register", br#"{"schema_version": 7}"#)).unwrap();
        assert_eq!(reply["result"]["capabilities"], json!({"scheduler": true, "scheduler_across_priorities": true}));
        assert_eq!(reply["result"]["metadata"]["Name"], "App Routing");
    }

    #[test]
    fn apps_without_a_rule_are_left_to_the_proxy() {
        let _serial = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        configure_yaml(RULES);
        let pick = pick(&request(CODE, None, &[("personal.json", 30), ("work-a@x.com.json", 20)]), 100);
        assert_eq!(pick, json!({"Handled": false}));
        assert_eq!(super::pick(&request("curl/8.5", None, &[("work-a@x.com.json", 20)]), 100), json!({"Handled": false}));
    }

    #[test]
    fn an_app_gets_its_highest_account_in_the_routing_order() {
        let _serial = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        configure_yaml(RULES);
        let candidates = [("personal.json", 30), ("work-b@x.com.json", 10), ("work-a@x.com.json", 20)];
        assert_eq!(pick(&request(DESKTOP, None, &candidates), 100), json!({"AuthID": "work-a@x.com.json", "Handled": true}));
        // work-a is out (not offered): the next of the app's own accounts, never personal.
        assert_eq!(pick(&request(DESKTOP, None, &[("personal.json", 30), ("work-b@x.com.json", 10)]), 100)["AuthID"], "work-b@x.com.json");
    }

    #[test]
    fn names_match_without_folders_extension_or_case() {
        let _serial = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        configure_yaml(RULES);
        assert_eq!(pick(&request(DESKTOP, None, &[("auths/Work-A@X.com", 1)]), 100)["AuthID"], "auths/Work-A@X.com");
        let mut by_path = request(DESKTOP, None, &[("opaque-id-1", 1)]);
        by_path["Candidates"][0]["Attributes"] = json!({"path": "C:\\cpa\\auth\\work-b@x.com.json"});
        assert_eq!(pick(&by_path, 100)["AuthID"], "opaque-id-1");
    }

    #[test]
    fn prefer_falls_back_and_only_refuses() {
        let _serial = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        configure_yaml(RULES);
        assert_eq!(pick(&request(DESKTOP, None, &[("personal.json", 30)]), 100), json!({"Handled": false}), "prefer: the proxy routes it");
        let mut codex = request("codex_cli_rs/0.50.0", None, &[("other-codex.json", 30)]);
        codex["Provider"] = json!("codex");
        codex["Providers"] = json!(["codex"]);
        codex["Candidates"][0]["Provider"] = json!("codex");
        let refused = pick(&codex, 100);
        assert_eq!(refused["Reject"], true);
        assert_eq!(refused["RejectCode"], "app_routing_only");
        assert!(refused["RejectReason"].as_str().unwrap().contains("Codex"));
    }

    #[test]
    fn a_rule_leaves_other_providers_alone_even_when_only() {
        let _serial = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        configure_yaml(RULES);
        let mut gemini = request("codex_cli_rs/0.50.0", None, &[("gemini.json", 30)]);
        gemini["Provider"] = json!("gemini");
        gemini["Providers"] = json!(["gemini"]);
        gemini["Candidates"][0]["Provider"] = json!("gemini");
        assert_eq!(pick(&gemini, 100), json!({"Handled": false}));
    }

    #[test]
    fn a_conversation_stays_on_its_account() {
        let _serial = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        configure_yaml(RULES);
        // Started on work-b (work-a was out at the time).
        assert_eq!(pick(&request(DESKTOP, Some("s1"), &[("work-b@x.com.json", 10)]), 100)["AuthID"], "work-b@x.com.json");
        // work-a is back and higher in the order, but the conversation keeps work-b.
        let both = [("work-a@x.com.json", 20), ("work-b@x.com.json", 10)];
        assert_eq!(pick(&request(DESKTOP, Some("s1"), &both), 200)["AuthID"], "work-b@x.com.json");
        // A new conversation takes the top one.
        assert_eq!(pick(&request(DESKTOP, Some("s2"), &both), 200)["AuthID"], "work-a@x.com.json");
        // work-b runs out: the conversation moves, and then stays where it moved.
        assert_eq!(pick(&request(DESKTOP, Some("s1"), &[("work-a@x.com.json", 20)]), 300)["AuthID"], "work-a@x.com.json");
        assert_eq!(pick(&request(DESKTOP, Some("s1"), &both), 400)["AuthID"], "work-a@x.com.json");
    }

    #[test]
    fn a_quiet_conversation_is_forgotten_after_the_sticky_time() {
        let _serial = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        configure_yaml(&format!("{RULES}sticky_minutes: 10\n"));
        assert_eq!(pick(&request(DESKTOP, Some("s1"), &[("work-b@x.com.json", 10)]), 1_000)["AuthID"], "work-b@x.com.json");
        let both = [("work-a@x.com.json", 20), ("work-b@x.com.json", 10)];
        assert_eq!(pick(&request(DESKTOP, Some("s1"), &both), 1_000 + 9 * 60)["AuthID"], "work-b@x.com.json", "still within 10 minutes");
        assert_eq!(pick(&request(DESKTOP, Some("s1"), &both), 1_000 + 9 * 60 + 11 * 60)["AuthID"], "work-a@x.com.json", "idle past it");
    }

    #[test]
    fn a_remembered_account_taken_off_the_list_is_not_used() {
        let _serial = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        configure_yaml(RULES);
        let both = [("work-a@x.com.json", 20), ("work-b@x.com.json", 10)];
        assert_eq!(pick(&request(DESKTOP, Some("s1"), &both), 100)["AuthID"], "work-a@x.com.json");
        let request_bytes = json!({"config_yaml": B64.encode("rules:\n  claude-desktop:\n    accounts: [work-b@x.com.json]\n")}).to_string();
        handle("plugin.reconfigure", request_bytes.as_bytes());
        assert_eq!(pick(&request(DESKTOP, Some("s1"), &both), 200)["AuthID"], "work-b@x.com.json");
    }

    #[test]
    fn memory_stays_bounded() {
        let _serial = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        configure_yaml(RULES);
        for i in 0..(MAX_SESSIONS + 5) {
            pick(&request(DESKTOP, Some(&format!("s{i}")), &[("work-a@x.com.json", 20)]), 100 + i as u64);
        }
        assert!(state().lock().unwrap().sessions.len() <= MAX_SESSIONS);
    }

    #[test]
    fn bad_input_is_left_to_the_proxy() {
        let _serial = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        configure_yaml(RULES);
        let reply: Value = serde_json::from_str(&handle("scheduler.pick", b"not json")).unwrap();
        assert_eq!(reply["result"], json!({"Handled": false}));
        let reply: Value = serde_json::from_str(&handle("scheduler.pick", br#"{"Options": {"Headers": {"User-Agent": ["claude-cli/1 (claude-desktop-3p)"]}}}"#)).unwrap();
        assert_eq!(reply["result"], json!({"Handled": false}), "no candidates");
        let invalid: Value = serde_json::from_str(&handle("plugin.reconfigure", json!({"config_yaml": B64.encode("rules: [1, 2")}).to_string().as_bytes())).unwrap();
        assert_eq!(invalid["ok"], false);
    }
}
