#Requires -Version 5.1
<#
.SYNOPSIS
  Run the isolated DSH end-to-end harness for dsh-plugin-discord.

.DESCRIPTION
  Delegates to test/e2e/plugin-e2e.mjs with DSH_PLUGIN_E2E=1. The Node script
  creates a throwaway DSH_HOME under %TEMP%, boots the isolated "plugin-e2e"
  profile (dsh-base + dsh-web-app + dsh-plugin-discord), waits for the plugin
  debug endpoint /health, runs one real model turn through POST /selftest, then
  stops the process tree and removes the throwaway home.

  It never boots the real desktop profile and never writes to the real DSH home
  (only .credentials.yaml / .anonymous-user-id are copied out of it).

.PARAMETER NodePath
  Node executable used for pnpm and the harness. Default: DSH_NODE or the
  bundled runtime node next to the real DSH home.

.PARAMETER PnpmPath
  Bundled pnpm.mjs. Default: DSH_PNPM or <runtime>/dependencies/pnpm/bin/pnpm.mjs.

.PARAMETER DshCli
  dsh.cmd launcher. Default: DSH_CLI or a known DeepSeek Harness install path.

.PARAMETER KeepTemp
  Keep the throwaway DSH home after the run for inspection (also keeps it on failure).

.PARAMETER PrecheckOnly
  Only run the fast dsh --dump-config bundle-composition precheck (no boot, no model turn).

.PARAMETER HealthOnly
  Boot the isolated profile and wait for /health, but skip the model selftest.

.EXAMPLE
  pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/e2e.ps1

.EXAMPLE
  pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/e2e.ps1 -PrecheckOnly
#>
[CmdletBinding()]
param(
  [string]$NodePath,
  [string]$PnpmPath,
  [string]$DshCli,
  [switch]$KeepTemp,
  [switch]$PrecheckOnly,
  [switch]$HealthOnly
)

$ErrorActionPreference = 'Stop'

$pluginDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$realHome = if ($env:DSH_REAL_HOME) { $env:DSH_REAL_HOME } elseif ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
if (-not (Test-Path $realHome)) { throw "real DSH home not found: $realHome" }

if (-not $NodePath) {
  $NodePath = if ($env:DSH_NODE) { $env:DSH_NODE } else { Join-Path $realHome 'dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' }
}
if (-not (Test-Path $NodePath)) {
  throw "bundled node not found: $NodePath. Set DSH_NODE or pass -NodePath."
}
if (-not $PnpmPath) {
  $PnpmPath = if ($env:DSH_PNPM) { $env:DSH_PNPM } else { Join-Path $realHome 'dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs' }
}
if (-not (Test-Path $PnpmPath)) {
  throw "bundled pnpm not found: $PnpmPath. Set DSH_PNPM or pass -PnpmPath."
}

if (-not $DshCli) {
  $DshCli = $env:DSH_CLI
  if (-not $DshCli) {
    $candidates = @(
      'E:\deepseekharness\resources\runtime\cli\bin\dsh.cmd',
      'C:\deepseekharness\resources\runtime\cli\bin\dsh.cmd',
      (Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
    )
    foreach ($candidate in $candidates) {
      if ($candidate -and (Test-Path $candidate)) { $DshCli = $candidate; break }
    }
  }
}
if (-not $DshCli -or -not (Test-Path $DshCli)) {
  throw "dsh launcher not found. Set DSH_CLI or pass -DshCli (for example <install>\resources\runtime\cli\bin\dsh.cmd)."
}

$env:DSH_PLUGIN_E2E = '1'
$env:DSH_REAL_HOME = $realHome
$env:DSH_NODE = $NodePath
$env:DSH_PNPM = $PnpmPath
$env:DSH_CLI = $DshCli
if ($KeepTemp) { $env:DSH_PLUGIN_E2E_KEEP = '1' }
if ($HealthOnly) { $env:DSH_PLUGIN_E2E_HEALTH_ONLY = '1' }

$testArgs = @('--test', '--test-reporter=spec')
if ($PrecheckOnly) {
  $testArgs += @('--test-name-pattern', 'precheck')
}
$testArgs += (Join-Path $pluginDir 'test\e2e\plugin-e2e.mjs')

Write-Host '=== dsh-plugin-discord isolated e2e ===' -ForegroundColor Cyan
Write-Host "plugin dir : $pluginDir"
Write-Host "real home  : $realHome (only credentials are copied out; never modified)"
Write-Host "node       : $NodePath"
Write-Host "pnpm       : $PnpmPath"
Write-Host "dsh        : $DshCli"
if ($PrecheckOnly) { Write-Host 'mode       : precheck only (dsh --dump-config, no boot)' }
elseif ($HealthOnly) { Write-Host 'mode       : boot + /health only (no model turn)' }
else { Write-Host 'mode       : full isolated e2e (boot + /health + one real model turn)' }
Write-Host ''

Push-Location $pluginDir
try {
  & $NodePath @testArgs
  $exitCode = $LASTEXITCODE
} finally {
  Pop-Location
}
exit $exitCode
