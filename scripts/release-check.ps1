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

Step "npm run verify (typecheck + tests)" { npm run verify }
Step "npm run build" { npm run build }

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
  Step "red lines (ports / env)" {
    ssh -o BatchMode=yes $PiHost "ss -lntp | grep -E '127.0.0.1:(4096|8787)' && systemctl show -p Environment wb-gateway opencode-serve | grep -ciE 'PASSWORD|SECRET|sk-' || echo 0"
  }
}

if ($fail -ne 0) {
  Write-Host "[release] NOT READY — fix failures before push" -ForegroundColor Red
  exit 1
}
Write-Host "[release] READY — safe to push" -ForegroundColor Green
