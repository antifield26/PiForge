# Pull PiForge backup from Pi into local D:\PiBackUp
# Run on Windows (Task Scheduler nightly). Requires SSH to Pi (antifield).
param(
  [string]$PiHost = "antifield@169.254.77.10",
  [string]$RemotePath = "/home/antifield/backups/piforge",
  [string]$LocalTarget = "D:\PiBackUp"
)

$ErrorActionPreference = "Stop"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dest = Join-Path $LocalTarget "backup-$stamp"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

Write-Host "[pull] ${PiHost}:${RemotePath} -> $dest"

# Trigger a fresh backup on the Pi first (best-effort)
ssh $PiHost "export DB_PATH=/home/antifield/piforge/data/wb.db CONFIG_DIR=/home/antifield/piforge/config OPENCODE_DIR=/home/antifield/.opencode; bash /home/antifield/piforge/scripts/backup.sh /home/antifield/backups/piforge" 2>&1 | Write-Host

# Copy the newest backup directory
ssh $PiHost "ls -1dt $RemotePath/backup-* 2>/dev/null | head -1" | ForEach-Object {
  $latest = $_.Trim()
  if ($latest) {
    scp -r "${PiHost}:$latest/." $dest
    Write-Host "[pull] copied $latest"
  }
}

# Verify checksum file exists
$sums = Join-Path $dest "SHA256SUMS"
if (Test-Path $sums) {
  Write-Host "[pull] SHA256SUMS present"
} else {
  Write-Warning "[pull] SHA256SUMS missing"
}

# Retain last 14 days
Get-ChildItem $LocalTarget -Directory -Filter "backup-*" |
  Sort-Object Name -Descending |
  Select-Object -Skip 14 |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "[pull] OK $dest"
