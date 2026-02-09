# PowerShell script to run the bot with BOT_CONFIG
param(
    [Parameter(Mandatory=$false)]
    [string]$Config
)

if (-not $Config) {
    Write-Host "Usage: .\run.ps1 -Config '{...json...}'" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Example:" -ForegroundColor Cyan
    Write-Host '$config = ''{"platform":"google_meet","meetingUrl":null,"botName":"Test Bot","meeting_id":123,"automaticLeave":{"waitingRoomTimeout":300000,"noOneJoinedTimeout":600000,"everyoneLeftTimeout":300000}}'''
    Write-Host '.\run.ps1 -Config $config'
    exit 1
}

$env:BOT_CONFIG = $Config
Write-Host "BOT_CONFIG set successfully" -ForegroundColor Green
Write-Host "Running bot..." -ForegroundColor Cyan
npm run start

