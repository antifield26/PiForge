# Release check: local verify + deploy + e2e gate. Run on Windows before push.
#
#   powershell -File scripts/release-check.ps1
#   powershell -File scripts/release-check.ps1 -SkipDeploy   # local only
#
# Exit non-zero on any failure. "Do not push without this green" (AGENTS §5).

[CmdletBinding()]
param(
  [switch]$SkipDeploy,
  [string]$PiHost = $(if ($env:PIFORGE_HOST) { "antifield@$env:PIFORGE_HOST" } else { "antifield@169.254.77.10" })
)

$ErrorActionPreference = "Stop"
$fail = 0
function Step($name, [scriptblock]$body) {
  Write-Host "[release] $name" -ForegroundColor Cyan
  try {
    & $body
    if ($LASTEXITCODE -ne 0) { throw "exit code $LASTEXITCODE" }
    Write-Host "[release] OK  $name" -ForegroundColor Green
  } catch {
    Write-Host "[release] FAIL $name — $_" -ForegroundColor Red
    $script:fail = 1
  }
}

# Run one command on the Pi and hand back its own exit code plus its output. Every red-line
# check below decides pass/fail from that exit code, never from a shell `&&`/`||` chain:
# `ss ... && systemctl ... || echo 0` always exits 0 (the trailing `|| echo 0` succeeds even
# when both checks fail), which is exactly how a new inbound listener or a secret in
# `systemctl show -p Environment` used to be reported as OK.
function Invoke-Pi([string]$Command) {
  $output = ssh -o BatchMode=yes -o ConnectTimeout=10 $PiHost $Command 2>&1
  # Capture immediately: any later native command would overwrite $LASTEXITCODE.
  return @{ Code = $LASTEXITCODE; Output = @($output) }
}

function Test-RedLineCheck([scriptblock]$Remote) {
  foreach ($port in 4096, 8787) {
    $result = & $Remote "ss -lnt | grep -qE '127\.0\.0\.1:${port}\b'"
    if ($result.Code -ne 0) {
      throw "127.0.0.1:$port is not listening (red line 1: no inbound port; the services must stay on loopback)"
    }
  }
  # grep -ciE prints a count, so a match is data and not a failure exit code (`|| true` keeps
  # the remote exit 0; the count itself is the verdict).
  $result = & $Remote "systemctl show -p Environment wb-gateway opencode-serve | grep -ciE 'PASSWORD|SECRET|sk-' || true"
  if ($result.Code -ne 0) {
    throw "probe failed: systemctl/ssh exited $($result.Code) ($($result.Output -join ' '))"
  }
  $count = (@($result.Output) -join "").Trim()
  if ($count -notmatch '^\d+$') { throw "unexpected Environment probe output: '$count'" }
  if ([int]$count -gt 0) {
    throw "wb-gateway/opencode-serve Environment exposes $count secret-looking value(s) (red line 3: secrets only in /etc/piforge/*.env)"
  }
}

# scripts/tests/release-check-redlines.ps1 dot-sources this file (InvocationName '.') to drive
# Test-RedLineCheck against a fake Pi; stop here instead of running the real gate.
if ($MyInvocation.InvocationName -eq '.') { return }

Step "npm run verify (typecheck + tests)" { npm run verify }
Step "npm run build" { npm run build }

# Supply-chain and secret hygiene (FIX-4.8). Local-only: these do not need the Pi.
Step "dependency audit (npm audit)" {
  if ($env:ALLOW_NPM_AUDIT -eq '1') {
    Write-Host "[release] ALLOW_NPM_AUDIT=1 — skipping npm audit gate" -ForegroundColor Yellow
    return
  }
  npm audit --omit=dev
}
Step "repo secret-pattern scan" {
  $patterns = @(
    'sk-[A-Za-z0-9]{20,}',
    'BEGIN [A-Z ]*PRIVATE KEY',
    'ADMIN_PASSWORD\s*=\s*[A-Za-z0-9+/=_-]{6,}',
    'SESSION_SECRET\s*=\s*[A-Za-z0-9+/=_-]{8,}',
    'OPENCODE_PASSWORD\s*=\s*[A-Za-z0-9+/=_-]{6,}'
  )
  $hits = @()
  $files = Get-ChildItem -Recurse -File -Include *.ts,*.tsx,*.mjs,*.js,*.sh,*.ps1,*.json,*.md,*.service,*.timer |
    Where-Object { $_.FullName -notmatch 'node_modules|\\opencode\\|\\dist\\|package-lock' }
  foreach ($f in $files) {
    $text = Get-Content $f.FullName -Raw -Encoding UTF8
    foreach ($p in $patterns) {
      if ($text -match $p) {
        $hits += "$($f.FullName): $($Matches[0].Substring(0, [Math]::Min(40, $Matches[0].Length)))"
      }
    }
  }
  if ($hits.Count -gt 0) {
    $hits | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    throw "secret-looking pattern(s) found in tracked source ($($hits.Count) hit(s))"
  }
  Write-Host "[release] secret scan clean ($($files.Count) files)" -ForegroundColor Green
}

if (-not $SkipDeploy) {
  Step "ssh reachable" {
    ssh -o BatchMode=yes -o ConnectTimeout=8 $PiHost "echo ok" | Out-Null
  }
  Step "sync source (tar-over-ssh)" {
    $tgz = Join-Path $env:TEMP "piforge-release.tgz"
    if (Test-Path $tgz) { Remove-Item $tgz -Force }
    tar czf $tgz --exclude=node_modules --exclude=.git --exclude=opencode `
      --exclude=data --exclude='*.log' --exclude=.mimocode `
      packages apps scripts config deploy docs package.json package-lock.json AGENTS.md README.md CHANGELOG.md
    scp -o BatchMode=yes $tgz "${PiHost}:/tmp/piforge-release.tgz"
    ssh -o BatchMode=yes $PiHost "cd /home/antifield/piforge && tar xzf /tmp/piforge-release.tgz && rm -f /tmp/piforge-release.tgz"
    Remove-Item $tgz -Force -ErrorAction SilentlyContinue
  }
  Step "deploy-pi.sh" {
    ssh -o BatchMode=yes $PiHost "bash /home/antifield/piforge/scripts/deploy-pi.sh"
  }
  Step "verify-e2e.mjs" {
    ssh -o BatchMode=yes $PiHost "sudo node /opt/piforge/scripts/verify-e2e.mjs"
  }
  Step "verify-fixes.mjs (FIX-3 invariants)" {
    ssh -o BatchMode=yes $PiHost "sudo node /opt/piforge/scripts/verify-fixes.mjs"
  }
  Step "red lines (ports / env)" {
    Test-RedLineCheck { param($command) Invoke-Pi $command }
  }
}

if ($fail -ne 0) {
  Write-Host "[release] NOT READY — fix failures before push" -ForegroundColor Red
  exit 1
}
Write-Host "[release] READY — safe to push" -ForegroundColor Green
