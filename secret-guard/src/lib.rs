//! Secret Guard: a CLIProxyAPI request interceptor that looks for credentials
//! in outgoing prompts before the proxy sends them to any provider.
//!
//! For each request it either reports what it found (the default), replaces
//! each secret with a stable placeholder, or refuses the request. Findings are
//! appended to a JSON Lines file that the hub reads. The secret itself is never
//! written anywhere: only its kind and a salted fingerprint.

pub mod detect;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::CStr;
use std::io::Write;
use std::os::raw::c_char;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const ABI_VERSION: u32 = 1;
const SCHEMA_VERSION: u32 = 6;
const VERSION: &str = env!("CARGO_PKG_VERSION");
/// The same secret is logged again at most this often while a client keeps resending it.
const RELOG_AFTER: Duration = Duration::from_secs(15 * 60);
/// Bodies larger than this are passed through unscanned (and reported as such).
const MAX_SCAN_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Off,
    Report,
    Redact,
    Block,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct Config {
    pub default_mode: Mode,
    /// Mode per provider (`anthropic`, `openai`, `google`, `xai`, `meta`, `other`).
    pub modes: BTreeMap<String, Mode>,
    /// Fingerprints the user marked as safe (test keys and the like).
    pub allow: Vec<String>,
    pub findings_file: String,
    pub salt: String,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            default_mode: Mode::Report,
            modes: BTreeMap::new(),
            allow: Vec::new(),
            findings_file: String::new(),
            salt: String::new(),
        }
    }
}

struct State {
    config: Config,
    allow: HashSet<String>,
    last_logged: HashMap<String, SystemTime>,
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State { config: Config::default(), allow: HashSet::new(), last_logged: HashMap::new() }))
}

/// Maps the model the client asked for to the provider that will see the prompt.
pub fn provider_for(model: &str) -> &'static str {
    let m = model.to_ascii_lowercase();
    let m = m.rsplit('/').next().unwrap_or(&m);
    let starts = |prefixes: &[&str]| prefixes.iter().any(|p| m.starts_with(p));
    if starts(&["claude", "sonnet", "opus", "haiku", "fable"]) {
        "anthropic"
    } else if starts(&["gpt", "o1", "o3", "o4", "codex", "chatgpt"]) {
        "openai"
    } else if starts(&["gemini", "gemma"]) {
        "google"
    } else if starts(&["grok"]) {
        "xai"
    } else if starts(&["muse", "llama", "meta"]) {
        "meta"
    } else {
        "other"
    }
}

pub fn fingerprint(salt: &str, secret: &str) -> String {
    let digest = Sha256::new().chain_update(salt.as_bytes()).chain_update([0u8]).chain_update(secret.as_bytes()).finalize();
    digest[..4].iter().map(|b| format!("{b:02x}")).collect()
}

/// Replaces every finding with `[REDACTED:<kind>:<fingerprint>]`. The text is
/// the same for the same secret on every request, so prompt caching survives.
pub fn redact(text: &str, findings: &[(detect::Finding, String)]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    for (finding, fp) in findings {
        out.push_str(&text[cursor..finding.start]);
        out.push_str(&format!("[REDACTED:{}:{}]", finding.kind, fp));
        cursor = finding.end;
    }
    out.push_str(&text[cursor..]);
    out
}

pub fn block_message(kinds: &[&str]) -> String {
    let mut names: Vec<&str> = kinds.iter().map(|k| kind_label(k)).collect();
    names.sort_unstable();
    names.dedup();
    format!(
        "Secret Guard blocked this request because it contains {}. Remove it from the conversation and rotate it, or change Secret Guard's policy in Tim's AI Hub.",
        names.join(", ")
    )
}

pub fn kind_label(kind: &str) -> &'static str {
    match kind {
        "github_token" => "a GitHub token",
        "anthropic_key" => "an Anthropic API key",
        "openai_key" => "an OpenAI API key",
        "google_api_key" => "a Google API key",
        "aws_access_key" => "an AWS access key",
        "slack_token" => "a Slack token",
        "stripe_key" => "a Stripe live key",
        "azure_storage_key" => "an Azure storage key",
        "azure_client_secret" => "an Azure client secret",
        "private_key" => "a private key",
        "jwt" => "a JWT",
        "connection_string_password" => "a database password",
        "password_assignment" => "a password or secret",
        _ => "a credential",
    }
}

/// The User-Agent, capped. Kept whole because Claude Desktop identifies itself
/// as `claude-cli/… (claude-desktop-3p)`: the app name isn't always first.
fn client_name(headers: &Value) -> String {
    let ua = headers
        .as_object()
        .and_then(|h| h.iter().find(|(k, _)| k.eq_ignore_ascii_case("user-agent")))
        .and_then(|(_, v)| v.as_array().and_then(|a| a.first()).and_then(|v| v.as_str()).or(v.as_str()))
        .unwrap_or("");
    ua.chars().take(120).collect()
}

fn unix_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn append_findings(path: &str, lines: &[Value]) {
    if path.is_empty() || lines.is_empty() {
        return;
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let mut buf = String::new();
        for line in lines {
            buf.push_str(&line.to_string());
            buf.push('\n');
        }
        let _ = file.write_all(buf.as_bytes());
    }
}

/// Decides what to do with one request body. Returns the replacement body
/// (for redact), a refusal message (for block), or neither.
pub enum Verdict {
    Pass,
    Replace(String),
    Refuse(String),
}

pub fn inspect(request: &Value) -> Verdict {
    let body_b64 = request.get("Body").and_then(Value::as_str).unwrap_or("");
    if body_b64.is_empty() {
        return Verdict::Pass;
    }
    let Ok(body) = B64.decode(body_b64) else { return Verdict::Pass };
    let model = request.get("RequestedModel").and_then(Value::as_str).filter(|m| !m.is_empty())
        .or_else(|| request.get("Model").and_then(Value::as_str)).unwrap_or("");
    let provider = provider_for(model);

    let (mode, salt, findings_file) = {
        let st = state().lock().unwrap_or_else(|p| p.into_inner());
        let mode = st.config.modes.get(provider).copied().unwrap_or(st.config.default_mode);
        (mode, st.config.salt.clone(), st.config.findings_file.clone())
    };
    if mode == Mode::Off {
        return Verdict::Pass;
    }
    if body.len() > MAX_SCAN_BYTES {
        return Verdict::Pass;
    }
    let text = String::from_utf8_lossy(&body);
    let raw = detect::scan(&text);
    if raw.is_empty() {
        return Verdict::Pass;
    }

    let mut kept: Vec<(detect::Finding, String)> = Vec::new();
    let mut log = Vec::new();
    {
        let mut st = state().lock().unwrap_or_else(|p| p.into_inner());
        let now = SystemTime::now();
        for finding in raw {
            let fp = fingerprint(&salt, &text[finding.start..finding.end]);
            if st.allow.contains(&fp) {
                continue;
            }
            let action = match mode { Mode::Redact => "redacted", Mode::Block => "blocked", _ => "reported" };
            // Throttle per secret, provider and action: the same token going to a
            // second provider, or now being redacted, is news.
            let key = format!("{fp}|{provider}|{action}");
            let due = st.last_logged.get(&key).map_or(true, |t| now.duration_since(*t).unwrap_or_default() >= RELOG_AFTER);
            if due || mode == Mode::Block {
                if st.last_logged.len() > 10_000 {
                    st.last_logged.clear();
                }
                st.last_logged.insert(key, now);
                log.push(json!({
                    "ts": unix_ms() as u64,
                    "request_id": request.get("RequestID").and_then(Value::as_str).unwrap_or(""),
                    "model": model,
                    "provider": provider,
                    "source_format": request.get("SourceFormat").and_then(Value::as_str).unwrap_or(""),
                    "client": client_name(request.get("Headers").unwrap_or(&Value::Null)),
                    "kind": finding.kind,
                    "fingerprint": fp,
                    "action": action,
                }));
            }
            kept.push((finding, fp));
        }
    }
    // One entry per secret per request, even when the history repeats it.
    let mut seen = HashSet::new();
    log.retain(|line| seen.insert(line["fingerprint"].as_str().unwrap_or("").to_string()));
    append_findings(&findings_file, &log);

    if kept.is_empty() {
        return Verdict::Pass;
    }
    match mode {
        Mode::Redact => Verdict::Replace(redact(&text, &kept)),
        Mode::Block => Verdict::Refuse(block_message(&kept.iter().map(|(f, _)| f.kind).collect::<Vec<_>>())),
        _ => Verdict::Pass,
    }
}

fn configure(request: &[u8]) -> Result<(), String> {
    let value: Value = serde_json::from_slice(request).map_err(|e| e.to_string())?;
    let yaml = match value.get("config_yaml").and_then(Value::as_str) {
        Some(b64) if !b64.is_empty() => B64.decode(b64).map_err(|e| e.to_string())?,
        _ => Vec::new(),
    };
    let config: Config = if yaml.is_empty() { Config::default() } else { serde_yaml::from_slice(&yaml).map_err(|e| format!("secret-guard config: {e}"))? };
    let mut st = state().lock().unwrap_or_else(|p| p.into_inner());
    st.allow = config.allow.iter().map(|s| s.trim().to_ascii_lowercase()).collect();
    st.config = config;
    Ok(())
}

fn registration() -> Value {
    json!({
        "schema_version": SCHEMA_VERSION,
        "metadata": {
            "Name": "Secret Guard",
            "Version": VERSION,
            "Author": "Tim's AI Hub",
            // The proxy refuses plugins without a repository link.
            "GitHubRepository": "https://github.com/timrmcclain/EasyCLIProxyAPI",
            "ConfigFields": [
                {"Name": "default_mode", "Type": "enum", "EnumValues": ["off", "report", "redact", "block"], "Description": "What to do when a prompt contains a credential, unless a provider has its own mode."},
                {"Name": "findings_file", "Type": "string", "Description": "JSON Lines file the hub reads findings from."}
            ]
        },
        "capabilities": {"request_interceptor": true}
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
        "request.intercept_before" => {
            let Ok(value) = serde_json::from_slice::<Value>(request) else { return ok(json!({})) };
            match inspect(&value) {
                Verdict::Pass => ok(json!({})),
                Verdict::Replace(body) => ok(json!({"Body": B64.encode(body.as_bytes())})),
                Verdict::Refuse(message) => {
                    let body = json!({"type": "error", "error": {"type": "invalid_request_error", "code": "secret_guard_blocked", "message": message}});
                    ok(json!({
                        "Terminate": true,
                        "StatusCode": 400,
                        "ResponseHeaders": {"Content-Type": ["application/json"]},
                        "ResponseBody": B64.encode(body.to_string().as_bytes()),
                    }))
                }
            }
        }
        "request.intercept_after" => ok(json!({})),
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
    // A panic must never cross into the proxy: on any failure, let the request through.
    let text = std::panic::catch_unwind(|| handle(method, request)).unwrap_or_else(|_| {
        if method == "request.intercept_before" { ok(json!({})) } else { err("plugin_panic", "secret-guard failed") }
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

    fn token() -> String {
        format!("{}{}", "gh", "p_") + "aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xYz9Ab"
    }

    fn set_config(yaml: &str) {
        let request = json!({"schema_version": 6, "config_yaml": B64.encode(yaml)});
        let reply: Value = serde_json::from_str(&handle("plugin.register", request.to_string().as_bytes())).unwrap();
        assert_eq!(reply["ok"], true, "{reply}");
        assert_eq!(reply["result"]["capabilities"]["request_interceptor"], true);
    }

    fn intercept(model: &str, body: &str) -> Value {
        let request = json!({"RequestID": "r1", "SourceFormat": "claude", "RequestedModel": model, "Body": B64.encode(body)});
        serde_json::from_str(&handle("request.intercept_before", request.to_string().as_bytes())).unwrap()
    }

    #[test]
    fn modes_per_provider() {
        let _guard = TEST_LOCK.lock().unwrap();
        set_config("default_mode: report\nmodes:\n  xai: block\n  openai: redact\nsalt: s\n");
        let body = format!(r#"{{"messages":[{{"content":"use {} please"}}]}}"#, token());

        let reported = intercept("claude-sonnet-5-5", &body);
        assert_eq!(reported["result"], json!({}), "report mode never changes the request");

        let redacted = intercept("gpt-6-astra", &body);
        let new_body = String::from_utf8(B64.decode(redacted["result"]["Body"].as_str().unwrap()).unwrap()).unwrap();
        assert!(!new_body.contains(&token()));
        assert!(new_body.contains("[REDACTED:github_token:"));
        serde_json::from_str::<Value>(&new_body).expect("redacted body is still valid JSON");
        let again = intercept("gpt-6-astra", &body);
        assert_eq!(again["result"]["Body"], redacted["result"]["Body"], "placeholders are stable across requests");

        let blocked = intercept("grok-5", &body);
        assert_eq!(blocked["result"]["Terminate"], true);
        assert_eq!(blocked["result"]["StatusCode"], 400);
        let message = String::from_utf8(B64.decode(blocked["result"]["ResponseBody"].as_str().unwrap()).unwrap()).unwrap();
        assert!(message.contains("a GitHub token"));
        assert!(!message.contains(&token()));
    }

    #[test]
    fn allowlisted_fingerprints_pass_and_findings_never_contain_the_secret() {
        let _guard = TEST_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("sg-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("findings.jsonl");
        let _ = std::fs::remove_file(&file);
        let path = file.to_string_lossy().replace('\\', "/");
        set_config(&format!("default_mode: block\nsalt: s\nfindings_file: \"{path}\"\n"));
        let body = format!(r#"{{"content":"{}"}}"#, token());
        assert_eq!(intercept("claude-opus-5-5", &body)["result"]["Terminate"], true);

        let log = std::fs::read_to_string(&file).unwrap();
        assert!(!log.contains(&token()), "the secret is never written");
        let line: Value = serde_json::from_str(log.lines().next().unwrap()).unwrap();
        assert_eq!(line["kind"], "github_token");
        assert_eq!(line["action"], "blocked");
        assert_eq!(line["provider"], "anthropic");
        let fp = line["fingerprint"].as_str().unwrap().to_string();

        set_config(&format!("default_mode: block\nsalt: s\nfindings_file: \"{path}\"\nallow: [\"{fp}\"]\n"));
        assert_eq!(intercept("claude-opus-5-5", &body)["result"], json!({}));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_same_secret_is_logged_again_for_a_new_provider_or_action() {
        let _guard = TEST_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("sg-throttle-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("findings.jsonl");
        let _ = std::fs::remove_file(&file);
        let path = file.to_string_lossy().replace('\\', "/");
        // A distinct salt keeps this test's fingerprints apart from the others'.
        set_config(&format!("default_mode: report\nmodes:\n  openai: redact\nsalt: throttle\nfindings_file: \"{path}\"\n"));
        let body = format!(r#"{{"content":"{}"}}"#, token());
        intercept("claude-opus-5-5", &body);
        intercept("claude-opus-5-5", &body); // same provider and action: throttled
        intercept("gpt-6-astra", &body); // new provider and action: logged
        let actions: Vec<String> = std::fs::read_to_string(&file)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .map(|v| format!("{}:{}", v["provider"].as_str().unwrap(), v["action"].as_str().unwrap()))
            .collect();
        assert_eq!(actions, vec!["anthropic:reported", "openai:redacted"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn registration_has_everything_the_proxy_requires() {
        let meta = &registration()["metadata"];
        for field in ["Name", "Version", "Author", "GitHubRepository"] {
            assert!(!meta[field].as_str().unwrap_or("").trim().is_empty(), "{field} must not be empty");
        }
    }

    #[test]
    fn bad_input_passes_through() {
        assert_eq!(serde_json::from_str::<Value>(&handle("request.intercept_before", b"not json")).unwrap()["result"], json!({}));
        assert_eq!(serde_json::from_str::<Value>(&handle("request.intercept_before", br#"{"Body":"%%%"}"#)).unwrap()["result"], json!({}));
    }

    #[test]
    fn providers() {
        assert_eq!(provider_for("sonnet"), "anthropic");
        assert_eq!(provider_for("claude-haiku-5-5"), "anthropic");
        assert_eq!(provider_for("gpt-6-astra"), "openai");
        assert_eq!(provider_for("gemini-4-argon-high"), "google");
        assert_eq!(provider_for("grok-5"), "xai");
        assert_eq!(provider_for("models/gemini-3-pro"), "google");
        assert_eq!(provider_for("devin-2"), "other");
    }

    static TEST_LOCK: Mutex<()> = Mutex::new(());
}
