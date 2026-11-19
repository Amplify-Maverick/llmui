# LLMUI Start Script for Windows
# Run with: .\scripts\start.ps1

$ErrorActionPreference = "Stop"

# Navigate to project root
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $scriptDir
Set-Location $projectDir

# Check if dependencies are installed
if (-not (Test-Path "node_modules")) {
    Write-Host "[ERROR] Dependencies not installed. Run .\scripts\install.ps1 first." -ForegroundColor Red
    exit 1
}

# Check if ports are available
$port3000 = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
$port3001 = Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue

if ($port3000) {
    Write-Host "[WARN] Port 3000 is already in use" -ForegroundColor Yellow
    Write-Host "   Another application may be using this port" -ForegroundColor Yellow
}
if ($port3001) {
    Write-Host "[WARN] Port 3001 is already in use" -ForegroundColor Yellow
    Write-Host "   The storage server may already be running, or another app is using this port" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Starting LLMUI..." -ForegroundColor Cyan
Write-Host "   Frontend: http://localhost:3000" -ForegroundColor White
Write-Host "   Storage:  http://localhost:3001" -ForegroundColor White
Write-Host ""
Write-Host "Press Ctrl+C to stop" -ForegroundColor Gray
Write-Host ""

# Start the app
npm run dev
