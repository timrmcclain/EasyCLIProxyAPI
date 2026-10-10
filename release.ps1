[CmdletBinding()]
param(
    # Skip the browser tests (unit tests and typecheck still run).
    [switch]$SkipUiTests,
    # Build and install, but don't commit or push the version bump.
    [switch]$NoPush,
    # Git remote that holds the personal build. Pushing anywhere else is refused.
    [string]$Remote = 'timrmcclain'
)

# One command for a personal release: check, bump personal-desk.N, build, install, commit, push.
#
#   powershell -ExecutionPolicy Bypass -File release.ps1
#
# Stops at the first failure, so nothing is installed or pushed from a failing tree. The proxy
# (cli-proxy-api) keeps running throughout; update-installed-app.ps1 only swaps the GUI.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$env:PATH = "$HOME\.cargo\bin;$HOME\.bun\bin;$env:PATH"

function Step([string]$Name, [scriptblock]$Action) {
    Write-Host "==> $Name" -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "$Name failed (exit $LASTEXITCODE)" }
}

# Refuse to release from a dirty tree or to the upstream project.
$dirty = git status --porcelain
if ($dirty) { throw "Uncommitted changes; commit or stash them first:`n$dirty" }
$remoteUrl = git remote get-url $Remote 2>$null
if (-not $remoteUrl) { throw "Git remote '$Remote' not found." }
if ($remoteUrl -match 'router-for-me/') { throw "Remote '$Remote' points at the upstream project ($remoteUrl); refusing to push there." }
$branch = git rev-parse --abbrev-ref HEAD
if ($branch -ne 'main') { throw "On branch '$branch'; releases are cut from main." }

Step 'Typecheck' { bun run check }
Step 'Unit tests' { bun test }
if (-not $SkipUiTests) { Step 'Browser tests' { node scripts/run-ui-tests.mjs } }

# Bump 0.3.12+personal-desk.N -> N+1 in Cargo.toml and Cargo.lock.
$toml = Get-Content -Raw src-tauri/Cargo.toml
if ($toml -notmatch 'personal-desk\.(\d+)') { throw 'No personal-desk.N version found in src-tauri/Cargo.toml.' }
$old = [int]$Matches[1]
$new = $old + 1
foreach ($file in 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock') {
    $text = [IO.File]::ReadAllText((Resolve-Path $file))
    [IO.File]::WriteAllText((Resolve-Path $file), $text.Replace("personal-desk.$old", "personal-desk.$new"))
}
Write-Host "==> Version personal-desk.$old -> personal-desk.$new" -ForegroundColor Cyan

try {
    Step 'Build' { bun tauri build --no-bundle }
} catch {
    git checkout -- src-tauri/Cargo.toml src-tauri/Cargo.lock
    throw
}
Step 'Install' { powershell -NoProfile -ExecutionPolicy Bypass -File update-installed-app.ps1 }

$version = (Select-String -Path src-tauri/Cargo.toml -Pattern '^version = "(.+)"').Matches[0].Groups[1].Value
Step 'Commit version' {
    git add src-tauri/Cargo.toml src-tauri/Cargo.lock
    git commit -q -m "Version $version"
}
if (-not $NoPush) {
    Step "Push to $Remote" { git push -q $Remote main }
    git fetch -q $Remote
    if ((git rev-parse HEAD) -ne (git rev-parse "$Remote/main")) { throw "$Remote/main doesn't match HEAD after pushing." }
}
Write-Host "Released $version." -ForegroundColor Green
