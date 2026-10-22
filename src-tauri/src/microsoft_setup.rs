//! One-click Microsoft 365 setup for Claude Desktop: registers the Entra app the
//! manual steps describe, using Microsoft's own Graph PowerShell modules. The
//! sign-in happens in the user's browser on Microsoft's page; the hub never sees
//! a password or keeps a token (the Graph session lives only in that process).

use serde::{Deserialize, Serialize};
use std::process::Command;
use std::time::Duration;

/// Read-only Microsoft Graph permissions Claude Desktop's Microsoft 365 connector uses.
pub(crate) const GRAPH_SCOPES: [&str; 6] = ["User.Read", "Mail.Read", "Calendars.Read", "Files.Read.All", "Sites.Read.All", "Chat.Read"];
/// Write permissions the hub can add: drafts (and other mailbox edits), then calendar events. Never Mail.Send.
pub(crate) const WRITE_SCOPES: [&str; 2] = ["Mail.ReadWrite", "Calendars.ReadWrite"];
/// The connector's access levels, from the least to the most Claude can change.
pub(crate) const ACCESS_LEVELS: [&str; 3] = ["readonly", "drafts", "calendar"];

/// The write permissions one access level adds to the read set.
pub(crate) fn write_scopes_for(access: &str) -> Option<&'static [&'static str]> {
    match access {
        "readonly" => Some(&[]),
        "drafts" => Some(&WRITE_SCOPES[..1]),
        "calendar" => Some(&WRITE_SCOPES[..]),
        _ => None,
    }
}
/// Marks the registration this hub made, so running setup again reuses it.
const APP_TAG: &str = "TimsAIHub-ClaudeDesktop-M365";
const APP_NAME: &str = "Claude Desktop (Microsoft 365)";
/// Sign-in waits on the user in a browser; give up after this.
const SETUP_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MicrosoftSetupResult {
    /// ok | missingModule | signInFailed | needsAdminToSetUp | failed
    pub status: String,
    #[serde(default)]
    pub tenant_id: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub created: bool,
    /// granted | needsAdmin
    #[serde(default)]
    pub consent: Option<String>,
    #[serde(default)]
    pub consent_url: Option<String>,
    /// granted | needsAdmin | none (nothing to grant) | notRemoved (a write permission couldn't be taken back)
    #[serde(default)]
    pub write_consent: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}

impl MicrosoftSetupResult {
    fn failed(message: impl Into<String>) -> Self {
        Self { status: "failed".into(), tenant_id: None, client_id: None, created: false, consent: None, consent_url: None, write_consent: None, message: Some(message.into()) }
    }
}

fn quoted(scopes: &[&str]) -> String {
    scopes.iter().map(|scope| format!("'{scope}'")).collect::<Vec<_>>().join(",")
}

/// Registers (or reuses) the app with the read set for everyone in the tenant, and grants `writes` to the person
/// signing in only. Write permissions the hub manages but `writes` leaves out are taken back from that person.
fn script(writes: &[&str]) -> String {
    format!(
        r#"$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Emit($value) {{ [Console]::Out.WriteLine('@@RESULT@@' + ($value | ConvertTo-Json -Compress -Depth 6)) }}
function Retry([scriptblock]$work) {{
  # A new registration takes a few seconds to appear everywhere in Entra.
  for ($i = 0; $i -lt 8; $i++) {{ try {{ return & $work }} catch {{ if ($i -eq 7) {{ throw }}; Start-Sleep -Seconds 3 }} }}
}}
function Graph($method, $path, $body) {{
  $uri = 'https://graph.microsoft.com/v1.0/' + $path
  if ($null -ne $body) {{ Invoke-MgGraphRequest -Method $method -Uri $uri -Body ($body | ConvertTo-Json -Compress) -ContentType 'application/json' -OutputType Hashtable }}
  else {{ Invoke-MgGraphRequest -Method $method -Uri $uri -OutputType Hashtable }}
}}
try {{
  Import-Module Microsoft.Graph.Authentication -MinimumVersion 2.0.0
  Import-Module Microsoft.Graph.Applications -MinimumVersion 2.0.0
}} catch {{ Emit @{{ status = 'missingModule'; message = $_.Exception.Message }}; exit 0 }}
# Use the normal browser sign-in rather than the Windows account broker, which needs a visible window.
try {{ Set-MgGraphOption -DisableLoginByWAM $true }} catch {{}}
try {{
  Connect-MgGraph -Scopes 'Application.ReadWrite.All','DelegatedPermissionGrant.ReadWrite.All','User.Read' -ContextScope Process -NoWelcome
}} catch {{
  $text = $_.Exception.Message
  if ($text -match 'AADSTS65001|AADSTS90094|admin approval|consent') {{ Emit @{{ status = 'needsAdminToSetUp'; message = $text }} }}
  else {{ Emit @{{ status = 'signInFailed'; message = $text }} }}
  exit 0
}}
try {{
  $tenant = (Get-MgContext).TenantId
  $graphAppId = '00000003-0000-0000-c000-000000000000'
  $graph = Get-MgServicePrincipal -Filter "appId eq '$graphAppId'"
  $wanted = @({reads})
  $writes = @({writes})
  $managed = @({managed})
  $access = @(foreach ($name in ($wanted + $writes)) {{
    $scope = $graph.Oauth2PermissionScopes | Where-Object {{ $_.Value -eq $name }} | Select-Object -First 1
    if (-not $scope) {{ throw "Microsoft Graph permission $name was not found." }}
    @{{ id = $scope.Id; type = 'Scope' }}
  }})
  $created = $false
  $app = Get-MgApplication -Filter "tags/any(t:t eq '{tag}')" -Top 1
  if (-not $app) {{
    $app = New-MgApplication -BodyParameter @{{ displayName = '{name}'; signInAudience = 'AzureADMyOrg'; tags = @('{tag}'); isFallbackPublicClient = $true }}
    $created = $true
  }}
  $redirects = @("ms-appx-web://Microsoft.AAD.BrokerPlugin/$($app.AppId)", 'http://localhost')
  Retry {{ Update-MgApplication -ApplicationId $app.Id -BodyParameter @{{ publicClient = @{{ redirectUris = $redirects }}; isFallbackPublicClient = $true; requiredResourceAccess = @(@{{ resourceAppId = $graphAppId; resourceAccess = $access }}) }} }} | Out-Null
  $sp = Get-MgServicePrincipal -Filter "appId eq '$($app.AppId)'"
  if (-not $sp) {{ $sp = Retry {{ New-MgServicePrincipal -BodyParameter @{{ appId = $app.AppId }} }} }}
  # Everyone in the tenant: exactly the read set, so a write permission never stays approved tenant-wide.
  $consent = 'granted'
  try {{
    $scopeText = $wanted -join ' '
    $grant = @((Graph GET "oauth2PermissionGrants?`$filter=clientId eq '$($sp.Id)' and consentType eq 'AllPrincipals'").value | Where-Object {{ $_.resourceId -eq $graph.Id }}) | Select-Object -First 1
    if ($grant) {{ Graph PATCH "oauth2PermissionGrants/$($grant.id)" @{{ scope = $scopeText }} | Out-Null }}
    else {{ Graph POST 'oauth2PermissionGrants' @{{ clientId = $sp.Id; consentType = 'AllPrincipals'; resourceId = $graph.Id; scope = $scopeText }} | Out-Null }}
  }} catch {{ $consent = 'needsAdmin' }}
  # The person signing in only: the write permissions they chose. Other scopes on their own grant are kept.
  $writeConsent = 'none'
  try {{
    $me = (Graph GET 'me?$select=id').id
    $mine = @((Graph GET "oauth2PermissionGrants?`$filter=clientId eq '$($sp.Id)' and principalId eq '$me'").value | Where-Object {{ $_.resourceId -eq $graph.Id }}) | Select-Object -First 1
    $keep = @()
    if ($mine) {{ $keep = @(($mine.scope -split ' ') | Where-Object {{ $_ -and $managed -notcontains $_ }}) }}
    $next = @(($keep + $writes) | Select-Object -Unique)
    if ($next.Count -eq 0) {{ if ($mine) {{ Graph DELETE "oauth2PermissionGrants/$($mine.id)" | Out-Null }} }}
    elseif ($mine) {{ Graph PATCH "oauth2PermissionGrants/$($mine.id)" @{{ scope = ($next -join ' ') }} | Out-Null }}
    else {{ Graph POST 'oauth2PermissionGrants' @{{ clientId = $sp.Id; consentType = 'Principal'; principalId = $me; resourceId = $graph.Id; scope = ($next -join ' ') }} | Out-Null }}
    if ($writes.Count) {{ $writeConsent = 'granted' }}
  }} catch {{ $writeConsent = if ($writes.Count) {{ 'needsAdmin' }} else {{ 'notRemoved' }} }}
  Emit @{{ status = 'ok'; tenantId = $tenant; clientId = $app.AppId; created = $created; consent = $consent; writeConsent = $writeConsent;
    consentUrl = "https://login.microsoftonline.com/$tenant/adminconsent?client_id=$($app.AppId)" }}
}} catch {{
  Emit @{{ status = 'failed'; message = $_.Exception.Message }}
}} finally {{
  try {{ Disconnect-MgGraph | Out-Null }} catch {{}}
}}
"#,
        reads = quoted(&GRAPH_SCOPES),
        writes = quoted(writes),
        managed = quoted(&WRITE_SCOPES),
        tag = APP_TAG,
        name = APP_NAME,
    )
}

/// The result line the script prints; anything else it writes is ignored.
pub(crate) fn parse_output(stdout: &str) -> MicrosoftSetupResult {
    let Some(line) = stdout.lines().rev().find_map(|line| line.trim().strip_prefix("@@RESULT@@")) else {
        return MicrosoftSetupResult::failed("Setup ended without a result.");
    };
    let mut result: MicrosoftSetupResult = match serde_json::from_str(line) {
        Ok(result) => result,
        Err(_) => return MicrosoftSetupResult::failed("Setup returned a result the hub couldn't read."),
    };
    if result.status == "ok" {
        let ids_valid = result.tenant_id.as_deref().is_some_and(is_guid) && result.client_id.as_deref().is_some_and(is_guid);
        if !ids_valid {
            return MicrosoftSetupResult::failed("Microsoft returned IDs in an unexpected format.");
        }
        if result.consent.as_deref() != Some("granted") {
            result.consent = Some("needsAdmin".into());
        }
        result.write_consent = Some(match result.write_consent.as_deref() {
            Some(known @ ("granted" | "none" | "notRemoved")) => known.to_string(),
            None => "none".to_string(),
            Some(_) => "needsAdmin".to_string(),
        });
    } else {
        // Only the IDs and the consent link are kept from anything but a success.
        result.tenant_id = None;
        result.client_id = None;
        result.consent_url = None;
        result.write_consent = None;
    }
    if let Some(message) = result.message.as_mut() {
        message.truncate(400);
    }
    result
}

fn is_guid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn run_powershell(script: &str, timeout: Duration) -> MicrosoftSetupResult {
    match run_powershell_output(script, timeout) {
        Ok(stdout) => parse_output(&stdout),
        Err(result) => result,
    }
}

fn run_powershell_output(script: &str, timeout: Duration) -> Result<String, MicrosoftSetupResult> {
    // The whole script goes in as one encoded command: fed through stdin, PowerShell runs it line by line
    // and multi-line blocks never finish, so no result was ever printed.
    use base64::Engine;
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &encoded]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    // Only the result line on stdout matters; stderr is dropped so its pipe can never fill and stall the script.
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return Err(MicrosoftSetupResult::failed(format!("Couldn't start PowerShell: {error}"))),
    };
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                return Err(MicrosoftSetupResult { status: "signInFailed".into(), message: Some("Timed out waiting for the Microsoft sign-in.".into()), ..MicrosoftSetupResult::failed("") });
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(250)),
            Err(error) => return Err(MicrosoftSetupResult::failed(error.to_string())),
        }
    }
    child
        .wait_with_output()
        .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
        .map_err(|error| MicrosoftSetupResult::failed(error.to_string()))
}

/// `access` is the connector level the user chose (readonly when left out); it decides which write permissions
/// the person signing in is granted.
#[tauri::command]
pub(crate) async fn microsoft_auto_setup(access: Option<String>) -> Result<MicrosoftSetupResult, String> {
    let access = access.unwrap_or_else(|| "readonly".to_string());
    let writes = write_scopes_for(&access).ok_or_else(|| format!("Unknown access level: {access}"))?;
    let script = script(writes);
    tauri::async_runtime::spawn_blocking(move || run_powershell(&script, SETUP_TIMEOUT)).await.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TENANT: &str = "11111111-2222-3333-4444-555555555555";
    const CLIENT: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    #[test]
    fn reads_a_successful_result_and_ignores_other_output() {
        let stdout = format!("WARNING: noise\n@@RESULT@@{{\"status\":\"ok\",\"tenantId\":\"{TENANT}\",\"clientId\":\"{CLIENT}\",\"created\":true,\"consent\":\"granted\",\"consentUrl\":\"https://login.microsoftonline.com/x\"}}\n");
        let result = parse_output(&stdout);
        assert_eq!(result.status, "ok");
        assert_eq!(result.tenant_id.as_deref(), Some(TENANT));
        assert_eq!(result.client_id.as_deref(), Some(CLIENT));
        assert!(result.created);
        assert_eq!(result.consent.as_deref(), Some("granted"));
    }

    #[test]
    fn rejects_ids_that_are_not_guids() {
        let stdout = format!("@@RESULT@@{{\"status\":\"ok\",\"tenantId\":\"evil; rm\",\"clientId\":\"{CLIENT}\",\"consent\":\"granted\"}}");
        assert_eq!(parse_output(&stdout).status, "failed");
    }

    #[test]
    fn treats_anything_but_granted_as_needing_an_admin() {
        let stdout = format!("@@RESULT@@{{\"status\":\"ok\",\"tenantId\":\"{TENANT}\",\"clientId\":\"{CLIENT}\",\"consent\":\"maybe\"}}");
        assert_eq!(parse_output(&stdout).consent.as_deref(), Some("needsAdmin"));
    }

    #[test]
    fn keeps_no_ids_from_a_failure_and_reports_missing_output() {
        let stdout = format!("@@RESULT@@{{\"status\":\"signInFailed\",\"tenantId\":\"{TENANT}\",\"message\":\"cancelled\"}}");
        let result = parse_output(&stdout);
        assert_eq!(result.status, "signInFailed");
        assert_eq!(result.tenant_id, None);
        assert_eq!(parse_output("nothing here").status, "failed");
    }

    /// Every Microsoft command replaced by a fake; Graph requests are recorded and printed after the result.
    #[cfg(windows)]
    fn fakes(existing_grants: &str) -> String {
        format!(r#"
function Import-Module {{ }}
function Set-MgGraphOption {{ }}
function Connect-MgGraph {{ }}
function Disconnect-MgGraph {{ }}
function Get-MgContext {{ [pscustomobject]@{{ TenantId = '{TENANT}' }} }}
function Get-MgServicePrincipal {{ param($Filter)
  if ($Filter -match '00000003') {{ [pscustomobject]@{{ Id = 'graph-sp'; Oauth2PermissionScopes = @('User.Read','Mail.Read','Calendars.Read','Files.Read.All','Sites.Read.All','Chat.Read','Mail.ReadWrite','Calendars.ReadWrite' | ForEach-Object {{ [pscustomobject]@{{ Value = $_; Id = [guid]::NewGuid() }} }}) }} }}
}}
function Get-MgApplication {{ }}
function New-MgApplication {{ param($BodyParameter) [pscustomobject]@{{ Id = 'obj-1'; AppId = '{CLIENT}' }} }}
function Update-MgApplication {{ }}
function New-MgServicePrincipal {{ [pscustomobject]@{{ Id = 'app-sp' }} }}
$global:calls = @()
$global:grants = @({existing_grants})
$global:failWrites = $false
function Invoke-MgGraphRequest {{ param($Method, $Uri, $Body, $ContentType, $OutputType)
  $path = $Uri -replace '^https://graph.microsoft.com/v1.0/', ''
  if ($Method -ne 'GET') {{ $global:calls += "$Method $path $Body" }}
  if ($global:failWrites -and $Method -ne 'GET' -and $Body -notmatch 'AllPrincipals') {{ throw 'Insufficient privileges to complete the operation.' }}
  if ($path -like 'me?*') {{ return @{{ id = 'me-1' }} }}
  if ($Method -eq 'GET') {{
    $kind = if ($path -match 'AllPrincipals') {{ 'AllPrincipals' }} else {{ 'Principal' }}
    return @{{ value = @($global:grants | Where-Object {{ $_.consentType -eq $kind }}) }}
  }}
  @{{}}
}}
"#)
    }

    /// Runs the script with fakes; returns the parsed result and the Graph changes it made.
    #[cfg(windows)]
    fn run_fake(setup: &str, writes: &[&str]) -> (MicrosoftSetupResult, Vec<String>) {
        let full = format!("{setup}\n{}\n[Console]::Out.WriteLine('@@CALLS@@' + ($global:calls -join '||'))", script(writes));
        let stdout = run_powershell_output(&full, Duration::from_secs(60)).expect("powershell runs");
        let calls = stdout
            .lines()
            .find_map(|line| line.trim().strip_prefix("@@CALLS@@"))
            .map(|line| line.split("||").filter(|call| !call.is_empty()).map(str::to_string).collect())
            .unwrap_or_default();
        (parse_output(&stdout), calls)
    }

    /// Runs the script the way the hub does, with every Microsoft command replaced by a fake.
    #[cfg(windows)]
    #[test]
    fn script_runs_end_to_end_against_fake_graph() {
        let (result, calls) = run_fake(&fakes(""), &[]);
        assert_eq!(result.status, "ok", "{:?}", result.message);
        assert_eq!(result.tenant_id.as_deref(), Some(TENANT));
        assert_eq!(result.client_id.as_deref(), Some(CLIENT));
        assert!(result.created);
        assert_eq!(result.consent.as_deref(), Some("granted"));
        assert_eq!(result.write_consent.as_deref(), Some("none"));
        // Read only: one tenant-wide grant with the read set, and nothing for the person signing in.
        assert_eq!(calls.len(), 1, "{calls:?}");
        assert!(calls[0].starts_with("POST oauth2PermissionGrants") && calls[0].contains("AllPrincipals"), "{calls:?}");
        assert!(calls[0].contains("User.Read Mail.Read Calendars.Read Files.Read.All Sites.Read.All Chat.Read"), "{calls:?}");

        // Running again finds the tagged app instead of creating another; an account that can't grant consent gets the admin link.
        let again = format!(r#"{}
function Get-MgApplication {{ [pscustomobject]@{{ Id = 'obj-1'; AppId = '{CLIENT}' }} }}
function New-MgApplication {{ throw 'should not create a second app' }}
function Invoke-MgGraphRequest {{ param($Method, $Uri) if ($Method -ne 'GET') {{ throw 'Insufficient privileges to complete the operation.' }}; if ($Uri -like '*me?*') {{ @{{ id = 'me-1' }} }} else {{ @{{ value = @() }} }} }}
"#, fakes(""));
        let (result, _) = run_fake(&again, &[]);
        assert_eq!(result.status, "ok", "{:?}", result.message);
        assert!(!result.created);
        assert_eq!(result.consent.as_deref(), Some("needsAdmin"));
        assert_eq!(result.consent_url.as_deref(), Some(format!("https://login.microsoftonline.com/{TENANT}/adminconsent?client_id={CLIENT}").as_str()));

        // A cancelled sign-in is reported as such, with no IDs.
        let cancelled = format!("{}\nfunction Connect-MgGraph {{ throw 'User canceled authentication.' }}\n", fakes(""));
        let (result, _) = run_fake(&cancelled, &[]);
        assert_eq!(result.status, "signInFailed");
        assert_eq!(result.tenant_id, None);
    }

    /// Drafts go to the person signing in only; the tenant-wide grant never carries a write permission.
    #[cfg(windows)]
    #[test]
    fn write_access_is_granted_to_the_signed_in_person_only() {
        let (result, calls) = run_fake(&fakes(""), write_scopes_for("drafts").unwrap());
        assert_eq!(result.write_consent.as_deref(), Some("granted"));
        assert_eq!(calls.len(), 2, "{calls:?}");
        assert!(calls[0].contains("AllPrincipals") && !calls[0].contains("ReadWrite"), "{calls:?}");
        assert!(calls[1].starts_with("POST oauth2PermissionGrants"), "{calls:?}");
        assert!(calls[1].contains(r#""consentType":"Principal""#) && calls[1].contains(r#""principalId":"me-1""#), "{calls:?}");
        assert!(calls[1].contains(r#""scope":"Mail.ReadWrite""#), "{calls:?}");
        assert!(calls.iter().all(|call| !call.contains("Mail.Send")));

        // A tenant-wide grant that had picked up a write permission is put back to the read set.
        let (_, calls) = run_fake(&fakes("@{ id = 'all-1'; consentType = 'AllPrincipals'; resourceId = 'graph-sp'; scope = 'Mail.Read Mail.ReadWrite' }"), &[]);
        assert!(calls[0].starts_with("PATCH oauth2PermissionGrants/all-1") && !calls[0].contains("ReadWrite"), "{calls:?}");

        // Calendar adds Calendars.ReadWrite to an existing personal grant and keeps what else it held.
        let mine = "@{ id = 'mine-1'; consentType = 'Principal'; resourceId = 'graph-sp'; scope = 'Mail.Read.Shared Mail.ReadWrite' }";
        let (_, calls) = run_fake(&fakes(mine), write_scopes_for("calendar").unwrap());
        assert!(calls[1].starts_with("PATCH oauth2PermissionGrants/mine-1"), "{calls:?}");
        assert!(calls[1].contains(r#""scope":"Mail.Read.Shared Mail.ReadWrite Calendars.ReadWrite""#), "{calls:?}");

        // Back to read only: the write permissions are taken back, the rest stays; a grant left empty is deleted.
        let (result, calls) = run_fake(&fakes(mine), &[]);
        assert_eq!(result.write_consent.as_deref(), Some("none"));
        assert!(calls[1].contains(r#""scope":"Mail.Read.Shared""#), "{calls:?}");
        let only_writes = "@{ id = 'mine-2'; consentType = 'Principal'; resourceId = 'graph-sp'; scope = 'Mail.ReadWrite Calendars.ReadWrite' }";
        let (_, calls) = run_fake(&fakes(only_writes), &[]);
        assert_eq!(calls.last().map(String::as_str), Some("DELETE oauth2PermissionGrants/mine-2"), "{calls:?}");

        // Without the right to grant, the result says so instead of claiming write access.
        let refused = format!("{}\n$global:failWrites = $true\n", fakes(""));
        let (result, _) = run_fake(&refused, write_scopes_for("drafts").unwrap());
        assert_eq!(result.status, "ok");
        assert_eq!(result.write_consent.as_deref(), Some("needsAdmin"));
        let (result, _) = run_fake(&format!("{}\n$global:failWrites = $true\n", fakes(only_writes)), &[]);
        assert_eq!(result.write_consent.as_deref(), Some("notRemoved"));
    }

    /// Parses the script with PowerShell's own parser, without running it.
    #[cfg(windows)]
    #[test]
    fn script_is_valid_powershell() {
        use std::io::Write;
        let mut child = Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", "$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$errors); $errors | ForEach-Object { $_.Message + ' @ line ' + $_.Extent.StartLineNumber }; 'ERRORS=' + @($errors).Count"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("powershell");
        child.stdin.take().unwrap().write_all(script(&WRITE_SCOPES).as_bytes()).unwrap();
        let output = String::from_utf8_lossy(&child.wait_with_output().unwrap().stdout).to_string();
        assert!(output.trim_end().ends_with("ERRORS=0"), "{output}");
    }

    #[test]
    fn script_asks_for_exactly_the_six_read_only_permissions() {
        let script = script(&[]);
        for scope in GRAPH_SCOPES {
            assert!(script.contains(&format!("'{scope}'")), "{scope}");
        }
        assert!(script.contains("AzureADMyOrg"));
        assert!(script.contains("ms-appx-web://Microsoft.AAD.BrokerPlugin/"));
        assert!(script.contains("-ContextScope Process"));
        assert!(!script.contains("ReadWrite.All' -Scope"), "only reads are granted to the app");
        assert!(script.contains("$writes = @()"));
        assert!(!script.contains("Mail.Send"));
    }

    #[test]
    fn access_levels_map_to_write_permissions_and_never_include_send() {
        assert_eq!(write_scopes_for("readonly"), Some(&[][..]));
        assert_eq!(write_scopes_for("drafts"), Some(&["Mail.ReadWrite"][..]));
        assert_eq!(write_scopes_for("calendar"), Some(&["Mail.ReadWrite", "Calendars.ReadWrite"][..]));
        assert_eq!(write_scopes_for("full"), None);
        assert!(ACCESS_LEVELS.iter().all(|level| write_scopes_for(level).is_some()));
        assert!(script(&WRITE_SCOPES).contains("$writes = @('Mail.ReadWrite','Calendars.ReadWrite')"));
    }
}
