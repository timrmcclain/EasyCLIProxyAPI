//! One-click Microsoft 365 setup for Claude Desktop: registers the Entra app the
//! manual steps describe, using Microsoft's own Graph PowerShell modules. The
//! sign-in happens in the user's browser on Microsoft's page; the hub never sees
//! a password or keeps a token (the Graph session lives only in that process).

use serde::{Deserialize, Serialize};
use std::process::Command;
use std::time::Duration;

/// Read-only Microsoft Graph permissions Claude Desktop's Microsoft 365 connector uses.
pub(crate) const GRAPH_SCOPES: [&str; 6] = ["User.Read", "Mail.Read", "Calendars.Read", "Files.Read.All", "Sites.Read.All", "Chat.Read"];
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
    #[serde(default)]
    pub message: Option<String>,
}

impl MicrosoftSetupResult {
    fn failed(message: impl Into<String>) -> Self {
        Self { status: "failed".into(), tenant_id: None, client_id: None, created: false, consent: None, consent_url: None, message: Some(message.into()) }
    }
}

fn script() -> String {
    let scopes = GRAPH_SCOPES.iter().map(|scope| format!("'{scope}'")).collect::<Vec<_>>().join(",");
    format!(
        r#"$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Emit($value) {{ [Console]::Out.WriteLine('@@RESULT@@' + ($value | ConvertTo-Json -Compress -Depth 6)) }}
function Retry([scriptblock]$work) {{
  # A new registration takes a few seconds to appear everywhere in Entra.
  for ($i = 0; $i -lt 8; $i++) {{ try {{ return & $work }} catch {{ if ($i -eq 7) {{ throw }}; Start-Sleep -Seconds 3 }} }}
}}
try {{
  Import-Module Microsoft.Graph.Authentication -MinimumVersion 2.0.0
  Import-Module Microsoft.Graph.Applications -MinimumVersion 2.0.0
}} catch {{ Emit @{{ status = 'missingModule'; message = $_.Exception.Message }}; exit 0 }}
# Use the normal browser sign-in rather than the Windows account broker, which needs a visible window.
try {{ Set-MgGraphOption -DisableLoginByWAM $true }} catch {{}}
try {{
  Connect-MgGraph -Scopes 'Application.ReadWrite.All','DelegatedPermissionGrant.ReadWrite.All' -ContextScope Process -NoWelcome
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
  $wanted = @({scopes})
  $access = @(foreach ($name in $wanted) {{
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
  $consent = 'granted'
  try {{
    $scopeText = $wanted -join ' '
    $grant = Get-MgOauth2PermissionGrant -Filter "clientId eq '$($sp.Id)' and consentType eq 'AllPrincipals' and resourceId eq '$($graph.Id)'" | Select-Object -First 1
    if ($grant) {{ Update-MgOauth2PermissionGrant -OAuth2PermissionGrantId $grant.Id -BodyParameter @{{ scope = $scopeText }} | Out-Null }}
    else {{ New-MgOauth2PermissionGrant -BodyParameter @{{ clientId = $sp.Id; consentType = 'AllPrincipals'; resourceId = $graph.Id; scope = $scopeText }} | Out-Null }}
  }} catch {{ $consent = 'needsAdmin' }}
  Emit @{{ status = 'ok'; tenantId = $tenant; clientId = $app.AppId; created = $created; consent = $consent;
    consentUrl = "https://login.microsoftonline.com/$tenant/adminconsent?client_id=$($app.AppId)" }}
}} catch {{
  Emit @{{ status = 'failed'; message = $_.Exception.Message }}
}} finally {{
  try {{ Disconnect-MgGraph | Out-Null }} catch {{}}
}}
"#,
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
    } else {
        // Only the IDs and the consent link are kept from anything but a success.
        result.tenant_id = None;
        result.client_id = None;
        result.consent_url = None;
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

fn run_script() -> MicrosoftSetupResult {
    run_powershell(&script(), SETUP_TIMEOUT)
}

fn run_powershell(script: &str, timeout: Duration) -> MicrosoftSetupResult {
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
        Err(error) => return MicrosoftSetupResult::failed(format!("Couldn't start PowerShell: {error}")),
    };
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                return MicrosoftSetupResult { status: "signInFailed".into(), message: Some("Timed out waiting for the Microsoft sign-in.".into()), ..MicrosoftSetupResult::failed("") };
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(250)),
            Err(error) => return MicrosoftSetupResult::failed(error.to_string()),
        }
    }
    match child.wait_with_output() {
        Ok(output) => parse_output(&String::from_utf8_lossy(&output.stdout)),
        Err(error) => MicrosoftSetupResult::failed(error.to_string()),
    }
}

#[tauri::command]
pub(crate) async fn microsoft_auto_setup() -> Result<MicrosoftSetupResult, String> {
    tauri::async_runtime::spawn_blocking(run_script).await.map_err(|error| error.to_string())
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

    /// Runs the script the way the hub does, with every Microsoft command replaced by a fake.
    #[cfg(windows)]
    #[test]
    fn script_runs_end_to_end_against_fake_graph() {
        let fakes = format!(r#"
function Import-Module {{ }}
function Set-MgGraphOption {{ }}
function Connect-MgGraph {{ }}
function Disconnect-MgGraph {{ }}
function Get-MgContext {{ [pscustomobject]@{{ TenantId = '{TENANT}' }} }}
function Get-MgServicePrincipal {{ param($Filter)
  if ($Filter -match '00000003') {{ [pscustomobject]@{{ Id = 'graph-sp'; Oauth2PermissionScopes = @('User.Read','Mail.Read','Calendars.Read','Files.Read.All','Sites.Read.All','Chat.Read' | ForEach-Object {{ [pscustomobject]@{{ Value = $_; Id = [guid]::NewGuid() }} }}) }} }}
}}
function Get-MgApplication {{ }}
function New-MgApplication {{ param($BodyParameter) [pscustomobject]@{{ Id = 'obj-1'; AppId = '{CLIENT}' }} }}
function Update-MgApplication {{ }}
function New-MgServicePrincipal {{ [pscustomobject]@{{ Id = 'app-sp' }} }}
function Get-MgOauth2PermissionGrant {{ }}
function New-MgOauth2PermissionGrant {{ }}
"#);
        let result = run_powershell(&format!("{fakes}
{}", script()), Duration::from_secs(60));
        assert_eq!(result.status, "ok", "{:?}", result.message);
        assert_eq!(result.tenant_id.as_deref(), Some(TENANT));
        assert_eq!(result.client_id.as_deref(), Some(CLIENT));
        assert!(result.created);
        assert_eq!(result.consent.as_deref(), Some("granted"));

        // Running again finds the tagged app instead of creating another; an account that can't grant consent gets the admin link.
        let again = format!(r#"{fakes}
function Get-MgApplication {{ [pscustomobject]@{{ Id = 'obj-1'; AppId = '{CLIENT}' }} }}
function New-MgApplication {{ throw 'should not create a second app' }}
function New-MgOauth2PermissionGrant {{ throw 'Insufficient privileges to complete the operation.' }}
"#);
        let result = run_powershell(&format!("{again}
{}", script()), Duration::from_secs(60));
        assert_eq!(result.status, "ok", "{:?}", result.message);
        assert!(!result.created);
        assert_eq!(result.consent.as_deref(), Some("needsAdmin"));
        assert_eq!(result.consent_url.as_deref(), Some(format!("https://login.microsoftonline.com/{TENANT}/adminconsent?client_id={CLIENT}").as_str()));

        // A cancelled sign-in is reported as such, with no IDs.
        let cancelled = format!("{fakes}
function Connect-MgGraph {{ throw 'User canceled authentication.' }}
");
        let result = run_powershell(&format!("{cancelled}
{}", script()), Duration::from_secs(60));
        assert_eq!(result.status, "signInFailed");
        assert_eq!(result.tenant_id, None);
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
        child.stdin.take().unwrap().write_all(script().as_bytes()).unwrap();
        let output = String::from_utf8_lossy(&child.wait_with_output().unwrap().stdout).to_string();
        assert!(output.trim_end().ends_with("ERRORS=0"), "{output}");
    }

    #[test]
    fn script_asks_for_exactly_the_six_read_only_permissions() {
        let script = script();
        for scope in GRAPH_SCOPES {
            assert!(script.contains(&format!("'{scope}'")), "{scope}");
        }
        assert!(script.contains("AzureADMyOrg"));
        assert!(script.contains("ms-appx-web://Microsoft.AAD.BrokerPlugin/"));
        assert!(script.contains("-ContextScope Process"));
        assert!(!script.contains("ReadWrite.All' -Scope"), "only reads are granted to the app");
    }
}
