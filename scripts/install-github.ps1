# dsh-plugin-discord - install from GitHub into a DSH profile.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-github.ps1
#   ... -Profile desktop -Ref v0.1.2 -Proxy http://127.0.0.1:7890 -DryRun

param(
  [string]$Profile = "desktop",
  [string]$Ref = "v0.1.2",
  [string]$Proxy = "",
  [string]$DshCli = "",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Find-FirstExisting {
  param([string[]]$Paths)
  foreach ($path in $Paths) {
    if ($path -and (Test-Path -LiteralPath $path)) { return $path }
  }
  return $null
}

$gitCandidates = @(
  "C:\Program Files\Git\cmd",
  "C:\Program Files\Git\bin",
  (Join-Path $env:LOCALAPPDATA "Programs\Git\cmd"),
  (Join-Path $env:LOCALAPPDATA "Programs\Git\bin")
)
$gitDir = Find-FirstExisting -Paths $gitCandidates
if ($gitDir) { $env:PATH = $gitDir + ";" + $env:PATH }
$gitExe = $null
if ($gitDir) { $gitExe = Join-Path $gitDir "git.exe" }
if (-not $gitExe) { $gitExe = "C:\Program Files\Git\cmd\git.exe" }
if (-not (Test-Path -LiteralPath $gitExe)) {
  throw "Git for Windows not found. Install it from https://git-scm.com/download/win (pnpm needs git for github: specs)."
}

if ($Proxy) {
  $env:HTTP_PROXY = $Proxy
  $env:HTTPS_PROXY = $Proxy
  $env:GIT_TERMINAL_PROMPT = "0"
  Write-Host ("[+] proxy: " + $Proxy)
}

if (-not $DshCli) {
  $dshCandidates = @()
  if ($env:DSH_CLI) { $dshCandidates += $env:DSH_CLI }
  if ($env:DSH_HOME) { $dshCandidates += (Join-Path $env:DSH_HOME "..\bin\dsh.cmd") }
  $dshCandidates += "E:\deepseekharness\resources\runtime\cli\bin\dsh.cmd"
  $dshCandidates += "C:\deepseekharness\resources\runtime\cli\bin\dsh.cmd"
  $DshCli = Find-FirstExisting -Paths $dshCandidates
}
if (-not $DshCli) {
  $cmd = Get-Command dsh.cmd -ErrorAction SilentlyContinue
  if ($cmd) { $DshCli = $cmd.Source }
}
if (-not $DshCli) {
  throw "DSH launcher (dsh.cmd) not found. Pass -DshCli <path-to-dsh.cmd>."
}

$spec = "github:AckerM-github/dsh-plugin-discord#" + $Ref
Write-Host ("[+] git: " + $gitExe)
Write-Host ("[+] dsh: " + $DshCli)
Write-Host ("[+] installing " + $spec + " into profile " + $Profile)
if ($DryRun) {
  Write-Host "[dry-run] nothing executed."
  exit 0
}

& $DshCli plugin --profile $Profile add $spec
if ($LASTEXITCODE -ne 0) {
  throw ("plugin install failed with exit code " + $LASTEXITCODE)
}

Write-Host ""
Write-Host "[+] Installed."
Write-Host "Next: enable dsh-plugin-discord on the DSH Plugins page, configure it in ~/.dsh/profiles/<profile>/cordis.patch.yml, then restart DSH."
