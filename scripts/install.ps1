# LLMUI Install Script for Windows
# Run with: .\scripts\install.ps1

$ErrorActionPreference = "Stop"

Write-Host "=== LLMUI Install Script ===" -ForegroundColor Cyan
Write-Host ""

# Check for Node.js
try {
    $nodeVersion = node --version 2>$null
    if ($LASTEXITCODE -ne 0) { throw }
    Write-Host "[OK] Node.js $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Node.js is not installed." -ForegroundColor Red
    Write-Host "   Download from: https://nodejs.org/" -ForegroundColor Yellow
    Write-Host "   Or run: winget install OpenJS.NodeJS" -ForegroundColor Yellow
    exit 1
}

# Check Node.js version (need v18+)
$versionNum = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')
if ($versionNum -lt 18) {
    Write-Host "[ERROR] Node.js v18 or higher required. You have $nodeVersion" -ForegroundColor Red
    exit 1
}

# Check for npm
try {
    $npmVersion = npm --version 2>$null
    if ($LASTEXITCODE -ne 0) { throw }
    Write-Host "[OK] npm $npmVersion" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] npm is not installed." -ForegroundColor Red
    exit 1
}

# Check for Ollama
$ollamaInstalled = $false
try {
    $ollamaVersion = ollama --version 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[OK] Ollama installed" -ForegroundColor Green
        $ollamaInstalled = $true
    }
} catch {}

if (-not $ollamaInstalled) {
    Write-Host "[WARN] Ollama not found in PATH." -ForegroundColor Yellow
    Write-Host "   Download from: https://ollama.com/download" -ForegroundColor Yellow
    Write-Host "   (You can continue without it, but you'll need it to use the app)" -ForegroundColor Yellow
    Write-Host ""
}

# Navigate to project root
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $scriptDir
Set-Location $projectDir

# Check if node_modules exists and is up to date
$needsInstall = $true
if (Test-Path "node_modules\.package-lock.json") {
    Write-Host "[OK] npm dependencies appear to be installed" -ForegroundColor Green
    $response = Read-Host "   Reinstall anyway? (y/N)"
    if ($response -ne "y" -and $response -ne "Y") {
        $needsInstall = $false
    }
}

if ($needsInstall) {
    Write-Host ""
    Write-Host "Installing npm dependencies..." -ForegroundColor Cyan
    Write-Host "(This may take a minute, especially for better-sqlite3)" -ForegroundColor Gray
    Write-Host ""

    try {
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
        Write-Host ""
        Write-Host "[OK] npm dependencies installed" -ForegroundColor Green
    } catch {
        Write-Host ""
        Write-Host "[ERROR] npm install failed" -ForegroundColor Red
        Write-Host ""
        Write-Host "Common fixes:" -ForegroundColor Yellow
        Write-Host "  1. If better-sqlite3 failed, you may need Visual C++ Build Tools:" -ForegroundColor Yellow
        Write-Host "     npm install -g windows-build-tools" -ForegroundColor Gray
        Write-Host "     (Run PowerShell as Administrator)" -ForegroundColor Gray
        Write-Host ""
        Write-Host "  2. Try clearing npm cache:" -ForegroundColor Yellow
        Write-Host "     npm cache clean --force" -ForegroundColor Gray
        Write-Host "     Remove-Item -Recurse -Force node_modules" -ForegroundColor Gray
        Write-Host "     npm install" -ForegroundColor Gray
        Write-Host ""
        Write-Host "  3. If you have Python issues:" -ForegroundColor Yellow
        Write-Host "     npm config set python C:\path\to\python.exe" -ForegroundColor Gray
        Write-Host ""
        exit 1
    }
}

Write-Host ""
Write-Host "=== Installation complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "To start the app:" -ForegroundColor White
Write-Host "  npm run dev" -ForegroundColor Green
Write-Host ""
Write-Host "Make sure Ollama is running (check system tray or start from Start Menu)" -ForegroundColor Gray
Write-Host "Then open http://localhost:3000 in your browser" -ForegroundColor Gray
Write-Host ""
