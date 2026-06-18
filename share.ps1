# ============================================================
#  Quantra AI — one-click local share
#  Double-click is unreliable; run it from PowerShell:
#     cd C:\Users\eshan\quantra-terminal
#     .\share.ps1
#  It frees the port, starts the server, and opens your public link.
#  KEEP THIS WINDOW OPEN — closing it takes the link down.
# ============================================================
Set-Location $PSScriptRoot
$port = 5280
$sub  = 'quantra-ai'

Write-Host "`n[1/3] Freeing port $port (clears any old server)..." -ForegroundColor Cyan
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

Write-Host "[2/3] Starting Quantra server..." -ForegroundColor Cyan
$server = Start-Process node -ArgumentList 'server.js' -PassThru -WindowStyle Minimized
Start-Sleep -Seconds 3

Write-Host "[3/3] Opening your public link..." -ForegroundColor Green
Write-Host "`n   SHARE THIS LINK:  https://$sub.loca.lt`n" -ForegroundColor Yellow
Write-Host "   (Keep this window open. Press Ctrl+C to stop sharing.)`n" -ForegroundColor DarkGray

try {
  npx -y localtunnel --port $port --subdomain $sub
} finally {
  # When the tunnel stops, shut the server down too so the port is clean next time.
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  Write-Host "`nStopped. Run .\share.ps1 again to share next time." -ForegroundColor Cyan
}
