param([switch]$SkipSchedule)
$ErrorActionPreference='Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if (!(Test-Path .env)) {
  $bytes=New-Object byte[] 24; $rng=[Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($bytes); $rng.Dispose(); $password= -join ($bytes | ForEach-Object { $_.ToString("x2") })
  (Get-Content -Raw .env.example).Replace('CHANGE_ME',$password) | Set-Content -Encoding utf8 .env
}
if (!(Test-Path '.local/career-ops/.git')) { git clone https://github.com/career-ops-hq/career-ops.git .local/career-ops; if($LASTEXITCODE){throw 'Career Ops clone failed'} }
git -C .local/career-ops checkout 8db98e3da9ba4accf89ee3984500d68564e58db5
if($LASTEXITCODE){throw 'Pinned Career Ops checkout failed'}
if (!(Test-Path '.venv/Scripts/python.exe')) { python -m venv .venv; if($LASTEXITCODE){throw 'Python virtual environment failed'} }
& .venv/Scripts/python.exe -m pip install -r requirements.txt
if($LASTEXITCODE){throw 'JobSpy dependency installation failed'}
npm.cmd ci
if($LASTEXITCODE){throw 'Node dependency installation failed'}
docker compose up -d --wait
if($LASTEXITCODE){throw 'PostgreSQL startup failed. Start Docker Desktop; postgres:17-alpine must already exist locally.'}
npm.cmd run build
if($LASTEXITCODE){throw 'Build failed'}
if(!$SkipSchedule) { & "$PSScriptRoot/register-schedule.ps1" }
Write-Host 'Setup complete. Run npm start; open http://127.0.0.1:4100'
