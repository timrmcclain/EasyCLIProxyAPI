use super::*;

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "connectors-test-{label}-{}-{}",
            std::process::id(),
            chrono::Local::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&path).unwrap();
        TempDir(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const CODE_CONFIG: &str = r#"{
  "numStartups": 12,
  "mcpServers": {
    "firecrawl": {
      "type": "http",
      "url": "https://mcp.firecrawl.dev/v2/mcp"
    },
    "google-workspace": {
      "type": "stdio",
      "command": "uvx",
      "args": [
        "workspace-mcp",
        "--single-user",
        "--tools",
        "gmail",
        "calendar"
      ],
      "env": {
        "GOOGLE_OAUTH_CLIENT_ID": "client-id-value",
        "GOOGLE_OAUTH_CLIENT_SECRET": "client-secret-value",
        "OAUTHLIB_INSECURE_TRANSPORT": "1"
      }
    }
  },
  "projects": {
    "C:/work": {
      "allowedTools": []
    }
  }
}
"#;

const DESKTOP_PROFILE: &str = r#"{
  "inferenceGatewayBaseUrl": "http://127.0.0.1:8317",
  "managedMcpServers": [
    {
      "name": "Playwright",
      "transport": "stdio",
      "command": "node.exe",
      "args": [
        "cli.js",
        "--extension"
      ]
    }
  ],
  "coworkTabEnabled": true
}
"#;

fn runtimes(root: &Path) -> Runtimes {
    Runtimes {
        uvx: Some(root.join("uvx.exe")),
        playwright: Some((root.join("node.exe"), root.join("cli.js"))),
        windows_python: Some(root.join("python.exe")),
    }
}

fn locations(root: &Path) -> Locations {
    let home = root.join("home");
    let local = root.join("local");
    fs::create_dir_all(home.join(".claude")).unwrap();
    fs::create_dir_all(&local).unwrap();
    fs::write(home.join(".claude.json"), CODE_CONFIG).unwrap();
    fs::write(home.join(".claude/settings.json"), "{\n  \"enabledPlugins\": {\n    \"github@claude-plugins-official\": true\n  }\n}\n").unwrap();
    let profile = local.join("profile.json");
    fs::write(&profile, DESKTOP_PROFILE).unwrap();
    Locations { home, local_app_data: local, desktop_profile: Some((profile, "EasyCLIProxyAPI".to_string())) }
}

fn request(id: &str, code: bool, desktop: bool, access: Option<&str>, secrets: &[(&str, &str)]) -> ConnectorChangeRequest {
    ConnectorChangeRequest {
        id: id.to_string(),
        claude_code: code,
        claude_desktop: desktop,
        access: access.map(str::to_string),
        secrets: secrets.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
    }
}

#[test]
fn writing_an_entry_keeps_every_other_member_byte_for_byte() {
    let entry = json!({ "type": "http", "url": "https://example.test/mcp" });
    let text = write_entry(CODE_CONFIG, Container::CodeServers, "example", Some(&entry)).unwrap();
    assert!(text.starts_with("{\n  \"numStartups\": 12,\n  \"mcpServers\": {\n    \"firecrawl\": {\n      \"type\": \"http\",\n      \"url\": \"https://mcp.firecrawl.dev/v2/mcp\"\n    },"));
    assert!(text.contains("  \"projects\": {\n    \"C:/work\": {\n      \"allowedTools\": []\n    }\n  }\n}\n"));
    assert!(text.contains("    \"example\": {\n      \"type\": \"http\",\n      \"url\": \"https://example.test/mcp\"\n    }\n  },"));

    let removed = write_entry(&text, Container::CodeServers, "example", None).unwrap();
    assert_eq!(removed, CODE_CONFIG);
}

#[test]
fn desktop_entries_are_matched_by_name_and_round_trip() {
    let entry = json!({ "name": "Firecrawl", "transport": "http", "url": "https://mcp.firecrawl.dev/v2/mcp" });
    let added = write_entry(DESKTOP_PROFILE, Container::DesktopServers, "Firecrawl", Some(&entry)).unwrap();
    assert_eq!(read_entry(&added, Container::DesktopServers, "firecrawl").unwrap(), Some(entry));
    assert!(added.contains("  \"coworkTabEnabled\": true\n}\n"));
    let removed = write_entry(&added, Container::DesktopServers, "FIRECRAWL", None).unwrap();
    assert_eq!(removed, DESKTOP_PROFILE);
}

#[test]
fn desktop_list_stored_as_a_string_is_read() {
    let text = r#"{"managedMcpServers":"[{\"name\":\"GitHub\",\"transport\":\"http\",\"url\":\"https://api.githubcopilot.com/mcp/readonly\"}]"}"#;
    let entry = read_entry(text, Container::DesktopServers, "GitHub").unwrap().unwrap();
    assert_eq!(access_from_entry(ConnectorId::GitHub, &entry).as_deref(), Some("readonly"));
}

#[test]
fn files_that_are_not_json_objects_are_refused() {
    assert!(write_entry("[1,2]", Container::CodeServers, "x", Some(&json!({}))).is_err());
    assert!(write_entry("{ broken", Container::CodeServers, "x", Some(&json!({}))).is_err());
    assert_eq!(write_entry("", Container::CodeServers, "x", Some(&json!({ "type": "http" }))).unwrap(), "{\n  \"mcpServers\": {\n    \"x\": {\n      \"type\": \"http\"\n    }\n  }\n}\n");
}

#[test]
fn google_access_levels_map_to_workspace_mcp_options() {
    let readonly = google_access_args("readonly");
    assert!(readonly.contains(&"--read-only".to_string()) && readonly.contains(&"--tools".to_string()));
    let drafts = google_access_args("drafts");
    assert!(drafts.contains(&"gmail:drafts".to_string()) && drafts.contains(&"sheets:readonly".to_string()));
    // --permissions cannot be combined with --tools or --read-only.
    assert!(!drafts.contains(&"--tools".to_string()) && !drafts.contains(&"--read-only".to_string()));
    let full = google_access_args("full");
    assert!(!full.contains(&"--read-only".to_string()) && !full.contains(&"--permissions".to_string()));
    for access in ["readonly", "drafts", "full"] {
        assert_eq!(google_access_from_args(&google_access_args(access)), access);
    }
}

#[test]
fn turning_google_on_for_desktop_reuses_the_existing_sign_in_settings() {
    let temp = TempDir::new("google");
    let locations = locations(&temp.0);
    apply_change(&locations, &runtimes(&temp.0), request("google", true, true, Some("readonly"), &[])).unwrap();

    let desktop = current_entry(&locations, ConnectorId::Google, Target::Desktop).unwrap().unwrap();
    assert_eq!(desktop["name"], "Google-Workspace");
    assert_eq!(desktop["env"]["GOOGLE_OAUTH_CLIENT_SECRET"], "client-secret-value");
    assert_eq!(access_from_entry(ConnectorId::Google, &desktop).as_deref(), Some("readonly"));
    // The hand-made Claude Code entry is adopted, not duplicated.
    let code_text = fs::read_to_string(locations.code_config()).unwrap();
    assert_eq!(code_text.matches("google-workspace").count(), 1);
    assert!(code_text.contains("\"numStartups\": 12"));
}

#[test]
fn google_without_sign_in_settings_changes_nothing() {
    let temp = TempDir::new("google-missing");
    let locations = locations(&temp.0);
    fs::write(locations.code_config(), "{}\n").unwrap();
    let error = apply_change(&locations, &runtimes(&temp.0), request("google", true, true, None, &[])).unwrap_err();
    assert_eq!(error, "missing_secret:GOOGLE_OAUTH_CLIENT_ID");
    assert_eq!(fs::read_to_string(locations.code_config()).unwrap(), "{}\n");
    assert_eq!(fs::read_to_string(locations.desktop_profile.as_ref().unwrap().0.clone()).unwrap(), DESKTOP_PROFILE);
}

#[test]
fn github_uses_the_token_for_both_apps_and_turns_off_the_broken_plugin() {
    let temp = TempDir::new("github");
    let locations = locations(&temp.0);
    apply_change(&locations, &runtimes(&temp.0), request("github", true, true, None, &[("GITHUB_TOKEN", " ghp_test ")])).unwrap();

    for target in [Target::Code, Target::Desktop] {
        let entry = current_entry(&locations, ConnectorId::GitHub, target).unwrap().unwrap();
        assert_eq!(entry["url"], GITHUB_READONLY_URL);
        assert_eq!(entry["headers"]["Authorization"], "Bearer ghp_test");
    }
    let settings = fs::read_to_string(locations.code_settings()).unwrap();
    assert!(settings.contains("\"github@claude-plugins-official\": false"));

    undo_last(&locations).unwrap();
    assert!(current_entry(&locations, ConnectorId::GitHub, Target::Code).unwrap().is_none());
    assert!(current_entry(&locations, ConnectorId::GitHub, Target::Desktop).unwrap().is_none());
    assert!(fs::read_to_string(locations.code_settings()).unwrap().contains("\"github@claude-plugins-official\": true"));
    assert_eq!(fs::read_to_string(locations.code_config()).unwrap(), CODE_CONFIG);
}

#[test]
fn changing_access_keeps_the_stored_token() {
    let temp = TempDir::new("github-access");
    let locations = locations(&temp.0);
    let runtimes = runtimes(&temp.0);
    apply_change(&locations, &runtimes, request("github", true, false, None, &[("GITHUB_TOKEN", "ghp_test")])).unwrap();
    apply_change(&locations, &runtimes, request("github", true, false, Some("full"), &[])).unwrap();
    let entry = current_entry(&locations, ConnectorId::GitHub, Target::Code).unwrap().unwrap();
    assert_eq!(entry["url"], GITHUB_URL);
    assert_eq!(entry["headers"]["Authorization"], "Bearer ghp_test");
}

#[test]
fn microsoft_365_uses_the_built_in_desktop_connector() {
    const TENANT: &str = "11111111-2222-3333-4444-555555555555";
    const CLIENT: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    let temp = TempDir::new("m365");
    let locations = locations(&temp.0);
    let ids = [("MICROSOFT_TENANT_ID", TENANT), ("MICROSOFT_CLIENT_ID", CLIENT)];
    apply_change(&locations, &runtimes(&temp.0), request("microsoft365", true, true, None, &ids)).unwrap();
    let desktop = current_entry(&locations, ConnectorId::Microsoft365, Target::Desktop).unwrap().unwrap();
    assert_eq!(desktop, json!({ "name": "Microsoft-365", "server": "microsoft365", "tenantId": TENANT, "clientId": CLIENT }));
    let code = current_entry(&locations, ConnectorId::Microsoft365, Target::Code).unwrap().unwrap();
    assert_eq!(code, json!({ "type": "http", "url": MICROSOFT_365_URL }));

    // Rebuilding the entry later keeps the stored IDs.
    apply_change(&locations, &runtimes(&temp.0), request("microsoft365", false, true, None, &[])).unwrap();
    let desktop = current_entry(&locations, ConnectorId::Microsoft365, Target::Desktop).unwrap().unwrap();
    assert_eq!(desktop["clientId"], CLIENT);
}

#[test]
fn microsoft_365_needs_its_ids_only_for_claude_desktop() {
    let temp = TempDir::new("m365-ids");
    let locations = locations(&temp.0);
    apply_change(&locations, &runtimes(&temp.0), request("microsoft365", true, false, None, &[])).unwrap();
    assert!(current_entry(&locations, ConnectorId::Microsoft365, Target::Code).unwrap().is_some());

    let error = apply_change(&locations, &runtimes(&temp.0), request("microsoft365", true, true, None, &[])).unwrap_err();
    assert_eq!(error, "missing_secret:MICROSOFT_TENANT_ID");
    assert!(current_entry(&locations, ConnectorId::Microsoft365, Target::Desktop).unwrap().is_none());

    let bad = [("MICROSOFT_TENANT_ID", "onecompany.com"), ("MICROSOFT_CLIENT_ID", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")];
    let error = apply_change(&locations, &runtimes(&temp.0), request("microsoft365", true, true, None, &bad)).unwrap_err();
    assert_eq!(error, "invalid_secret:MICROSOFT_TENANT_ID");
    let bad = [("MICROSOFT_TENANT_ID", "organizations"), ("MICROSOFT_CLIENT_ID", "not-a-guid")];
    let error = apply_change(&locations, &runtimes(&temp.0), request("microsoft365", true, true, None, &bad)).unwrap_err();
    assert_eq!(error, "invalid_secret:MICROSOFT_CLIENT_ID");
    assert!(current_entry(&locations, ConnectorId::Microsoft365, Target::Desktop).unwrap().is_none());

    let item = overview(&locations, &runtimes(&temp.0)).unwrap().connectors.into_iter().find(|item| item.id == "microsoft365").unwrap();
    assert!(item.secrets_desktop_only);
    assert!(!item.secrets_configured);
}

#[test]
fn turning_a_connector_off_removes_only_that_entry_and_undo_restores_it() {
    let temp = TempDir::new("off");
    let locations = locations(&temp.0);
    apply_change(&locations, &runtimes(&temp.0), request("playwright", false, false, None, &[])).unwrap();
    assert!(current_entry(&locations, ConnectorId::Playwright, Target::Desktop).unwrap().is_none());
    let profile = locations.desktop_profile.as_ref().unwrap().0.clone();
    assert!(fs::read_to_string(&profile).unwrap().contains("\"coworkTabEnabled\": true"));

    assert_eq!(undo_last(&locations).unwrap().as_deref(), Some("playwright"));
    let restored = current_entry(&locations, ConnectorId::Playwright, Target::Desktop).unwrap().unwrap();
    assert_eq!(restored["args"], json!(["cli.js", "--extension"]));
    assert_eq!(undo_last(&locations).unwrap(), None);
}

#[test]
fn every_change_leaves_a_backup_copy() {
    let temp = TempDir::new("backup");
    let locations = locations(&temp.0);
    apply_change(&locations, &runtimes(&temp.0), request("firecrawl", true, true, None, &[])).unwrap();
    let backups: Vec<_> = fs::read_dir(locations.local_app_data.join("TimAIHub/backups")).unwrap().collect();
    assert_eq!(backups.len(), 1);
}

#[test]
fn the_overview_never_contains_secret_values() {
    let temp = TempDir::new("overview");
    let locations = locations(&temp.0);
    apply_change(&locations, &runtimes(&temp.0), request("github", true, true, None, &[("GITHUB_TOKEN", "ghp_secret_value")])).unwrap();
    let text = serde_json::to_string(&overview(&locations, &runtimes(&temp.0)).unwrap()).unwrap();
    for secret in ["ghp_secret_value", "client-secret-value", "client-id-value"] {
        assert!(!text.contains(secret), "overview leaked {secret}");
    }
    let value: Value = serde_json::from_str(&text).unwrap();
    let google = value["connectors"].as_array().unwrap().iter().find(|c| c["id"] == "google").unwrap();
    assert_eq!(google["secretsConfigured"], true);
    assert_eq!(google["claudeCode"]["enabled"], true);
    assert_eq!(google["claudeDesktop"]["enabled"], false);
    assert_eq!(value["desktopProfile"], "EasyCLIProxyAPI");
    assert_eq!(value["lastChange"], "github");
}

#[test]
fn missing_programs_are_reported_instead_of_written() {
    let temp = TempDir::new("missing");
    let locations = locations(&temp.0);
    let error = apply_change(&locations, &Runtimes::default(), request("playwright", true, true, None, &[])).unwrap_err();
    assert!(error.contains("Playwright"));
    assert_eq!(Runtimes::default().unavailable_reason(ConnectorId::Google), Some("uvx"));
}

#[test]
fn unknown_connectors_and_access_levels_are_rejected() {
    let temp = TempDir::new("unknown");
    let locations = locations(&temp.0);
    assert!(apply_change(&locations, &runtimes(&temp.0), request("dropbox", true, true, None, &[])).is_err());
    assert!(apply_change(&locations, &runtimes(&temp.0), request("google", true, false, Some("admin"), &[])).is_err());
}

#[test]
fn event_stream_responses_are_read() {
    let body = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{},{},{}]}}\n\n";
    assert_eq!(http_message(body).as_ref().and_then(tool_count), Some(3));
}

#[test]
fn test_messages_hide_secret_values() {
    let entry = json!({
        "command": "uvx",
        "env": { "GOOGLE_OAUTH_CLIENT_SECRET": "abc-secret-123456", "MODE": "1" },
        "headers": { "Authorization": "Bearer ghp_exampletoken99" },
    });
    let hidden = hidden_values(&entry);
    let result = redact_result(
        ConnectorTestResult {
            status: "failed",
            tool_count: None,
            message: Some("bad client abc-secret-123456 and token ghp_exampletoken99, mode 1".to_string()),
        },
        &hidden,
    );
    let message = result.message.unwrap();
    assert!(!message.contains("abc-secret-123456"));
    assert!(!message.contains("ghp_exampletoken99"));
    assert!(message.contains("mode 1"));
}

#[test]
fn ai_test_allows_only_named_read_only_tools_and_no_built_in_tools() {
    let (tools, prompt) = ai_test_plan(ConnectorId::Google, "google-workspace", Some("me@example.com"), "2026-10-07").unwrap();
    assert_eq!(tools, vec!["mcp__google-workspace__list_calendars", "mcp__google-workspace__get_events"]);
    assert!(prompt.contains("user_google_email=me@example.com"));
    assert!(prompt.contains("2026-10-07"));
    assert!(prompt.contains("RESULT: PASS"));
    let args = ai_test_args(&tools, &prompt);
    let after = |flag: &str| args[args.iter().position(|arg| arg == flag).unwrap() + 1].clone();
    assert_eq!(after("--permission-mode"), "dontAsk");
    assert_eq!(after("--tools"), "");
    assert_eq!(after("--allowedTools"), "mcp__google-workspace__list_calendars,mcp__google-workspace__get_events");
    let (github, _) = ai_test_plan(ConnectorId::GitHub, "github", None, "2026-10-07").unwrap();
    assert_eq!(github, vec!["mcp__github__get_me"]);
    for id in [ConnectorId::Playwright, ConnectorId::Windows, ConnectorId::Firecrawl] {
        assert!(ai_test_plan(id, "x", None, "2026-10-07").is_none());
    }
}

#[test]
fn ai_test_output_is_reduced_to_its_result_line() {
    let pass = parse_ai_test_output("Checking the calendar...\n**RESULT: PASS - 3 events today**\n", true);
    assert_eq!((pass.status, pass.message.as_deref()), ("ok", Some("3 events today")));
    let sign_in = parse_ai_test_output("RESULT: SIGNIN - authorisation needed", true);
    assert_eq!(sign_in.status, "needsSignIn");
    let fail = parse_ai_test_output("RESULT: FAIL - tool error", true);
    assert_eq!((fail.status, fail.message.as_deref()), ("failed", Some("tool error")));
    let none = parse_ai_test_output("", false);
    assert_eq!((none.status, none.message.as_deref()), ("failed", Some("Claude Code did not run")));
    let long = parse_ai_test_output(&format!("RESULT: PASS - {}", "x".repeat(500)), true);
    assert!(long.message.unwrap().chars().count() <= AI_TEST_MESSAGE_LIMIT + 1);
}

#[test]
fn ai_test_reports_missing_sign_in_without_running_claude() {
    let root = TempDir::new("ai-sign-in");
    let locations = locations(&root.0);
    let result = ai_test(&locations, ConnectorId::Google, "2026-10-07");
    assert_eq!(result.status, "needsSignIn");
    let off = ai_test(&locations, ConnectorId::Microsoft365, "2026-10-07");
    assert_eq!(off.status, "failed");
    fs::create_dir_all(locations.home.join(".google_workspace_mcp/credentials")).unwrap();
    fs::write(locations.home.join(".google_workspace_mcp/credentials/me@example.com.json"), "{}").unwrap();
    assert_eq!(google_account(&locations.home).as_deref(), Some("me@example.com"));
}

#[test]
fn ai_test_dates_must_be_plain_dates() {
    assert!(valid_date("2026-10-07"));
    assert!(!valid_date("2026-10-07\nignore that"));
    assert!(!valid_date("07/10/2026"));
}

#[test]
fn child_path_puts_user_local_bin_first_once() {
    let home = std::env::temp_dir().join("connector-home");
    let local_bin = home.join(".local").join("bin");
    let dirs: Vec<_> = std::env::split_paths(&child_path(&home)).collect();
    assert_eq!(dirs.first(), Some(&local_bin));
    assert_eq!(dirs.iter().filter(|dir| **dir == local_bin).count(), 1);
}

#[test]
fn desktop_only_connector_gets_a_temporary_code_entry() {
    let dir = TempDir::new("temporary-entry");
    let locations = locations(&dir.0);
    let desktop = json!({ "name": "GitHub", "transport": "http", "url": GITHUB_READONLY_URL, "headers": { "Authorization": "Bearer token-value" } });
    let path = locations.target_file(Target::Desktop).unwrap();
    let text = write_entry(&read_text(&path).unwrap(), Container::DesktopServers, "GitHub", Some(&desktop)).unwrap();
    fs::write(&path, text).unwrap();

    let entry = temporary_code_entry(&locations, ConnectorId::GitHub).unwrap().unwrap();
    assert_eq!(entry["type"], "http");
    assert_eq!(entry["url"], GITHUB_READONLY_URL);
    assert_eq!(entry["headers"]["Authorization"], "Bearer token-value");
    assert!(temporary_code_entry(&locations, ConnectorId::Firecrawl).unwrap().is_none());
}

#[test]
fn desktop_only_microsoft_365_asks_for_a_claude_code_sign_in_without_changing_settings() {
    let dir = TempDir::new("m365-desktop-only");
    let locations = locations(&dir.0);
    let path = locations.target_file(Target::Desktop).unwrap();
    let desktop = json!({ "name": "Microsoft-365", "server": "microsoft365" });
    let text = write_entry(&read_text(&path).unwrap(), Container::DesktopServers, "Microsoft-365", Some(&desktop)).unwrap();
    fs::write(&path, text).unwrap();

    let result = ai_test(&locations, ConnectorId::Microsoft365, "2026-10-07");
    assert_eq!(result.status, "needsSignIn");
    assert_eq!(result.message.as_deref(), Some("desktopOnly"));
    assert_eq!(read_text(&locations.code_config()).unwrap(), CODE_CONFIG);
    assert!(!locations.connector_data().exists() || fs::read_dir(locations.connector_data()).unwrap().count() == 0);
}
