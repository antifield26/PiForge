# Local test for the release-check red-line gate (scripts/release-check.ps1).
#
#   pwsh -File scripts/tests/release-check-redlines.ps1
#
# No SSH: the gate is driven through Test-RedLineCheck with fake remote runners, and Step's
# pass/fail semantics are proven with real native commands. Exits non-zero when any
# expectation fails.
$ErrorActionPreference = "Stop"
if (Test-Path Variable:PSNativeCommandUseErrorActionPreference) {
  $PSNativeCommandUseErrorActionPreference = $false
}

. (Join-Path (Split-Path -Parent $PSScriptRoot) "release-check.ps1")

$checks = 0
$failed = 0
function Assert([string]$name, [bool]$condition) {
  $script:checks++
  if ($condition) {
    Write-Host "  ok   $name"
  } else {
    Write-Host "  FAIL $name" -ForegroundColor Red
    $script:failed++
  }
}
function Throws([scriptblock]$body) {
  try { & $body; return $false } catch { return $true }
}

# Fake Pi: only the shape of the remote command decides the answer, so the checks can be
# exercised without touching the real host.
$global:Seen = @()
$fakeOk = {
  param($command)
  $global:Seen += $command
  if ($command -like "*grep -qE*") { return @{ Code = 0; Output = @() } }
  return @{ Code = 0; Output = @("0") }
}
$fakeNoListener = {
  param($command)
  $global:Seen += $command
  if ($command -like "*grep -qE*") { return @{ Code = 1; Output = @() } }
  return @{ Code = 0; Output = @("0") }
}
$fakeSecondPortMissing = {
  param($command)
  $global:Seen += $command
  if ($command -like "*8787*") { return @{ Code = 1; Output = @() } }
  if ($command -like "*grep -qE*") { return @{ Code = 0; Output = @() } }
  return @{ Code = 0; Output = @("0") }
}
$fakeEnvLeak = {
  param($command)
  $global:Seen += $command
  if ($command -like "*grep -qE*") { return @{ Code = 0; Output = @() } }
  return @{ Code = 0; Output = @("2") }
}
$fakeProbeError = {
  param($command)
  $global:Seen += $command
  if ($command -like "*grep -qE*") { return @{ Code = 0; Output = @() } }
  return @{ Code = 255; Output = @("ssh: connect to host failed") }
}

Write-Host "[test] Step harness"
$fail = 0
Step "native command exits 3" { cmd /c exit 3 }
Assert 'failing native command sets $fail = 1' ($fail -eq 1)
$fail = 0
Step "native command exits 0" { cmd /c exit 0 }
Assert 'passing step leaves $fail = 0' ($fail -eq 0)
Step "scriptblock throws" { throw "boom" }
Assert 'a throwing step sets $fail = 1' ($fail -eq 1)

Write-Host "[test] red-line probe: passing Pi"
$fail = 0
$global:Seen = @()
Step "red lines (all good)" { Test-RedLineCheck $fakeOk }
Assert 'clean Pi leaves $fail = 0' ($fail -eq 0)
$seen = $global:Seen -join "`n"
Assert 'probe asserts 127.0.0.1:4096 is listening' $seen.Contains('127\.0\.0\.1:4096')
Assert 'probe asserts 127.0.0.1:8787 is listening' $seen.Contains('127\.0\.0\.1:8787')
Assert 'probe greps the unit Environment for secrets' ($seen -match 'grep -ciE')

Write-Host "[test] red-line probe: failing Pi"
$fail = 0
Step "red lines (no listener)" { Test-RedLineCheck $fakeNoListener }
Assert 'missing listener sets $fail = 1' ($fail -eq 1)
$fail = 0
Step "red lines (second port missing)" { Test-RedLineCheck $fakeSecondPortMissing }
Assert 'a missing 8787 alone sets $fail = 1' ($fail -eq 1)
$fail = 0
Step "red lines (env leak)" { Test-RedLineCheck $fakeEnvLeak }
Assert 'a secret in Environment sets $fail = 1' ($fail -eq 1)
$fail = 0
Step "red lines (probe error)" { Test-RedLineCheck $fakeProbeError }
Assert 'an ssh/systemctl probe error sets $fail = 1' ($fail -eq 1)

Assert 'Test-RedLineCheck throws directly on a clean Pi' (-not (Throws { Test-RedLineCheck $fakeOk }))
Assert 'Test-RedLineCheck throws directly on a leak' (Throws { Test-RedLineCheck $fakeEnvLeak })

if ($failed -ne 0) {
  Write-Host "[test] FAILED — $failed of $checks check(s)" -ForegroundColor Red
  exit 1
}
Write-Host "[test] PASSED — $checks check(s)" -ForegroundColor Green
