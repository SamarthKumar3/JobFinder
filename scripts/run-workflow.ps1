$ErrorActionPreference='Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
New-Item -ItemType Directory -Force data/logs | Out-Null
$ErrorActionPreference='Continue'
docker compose up -d --wait >> data/logs/scheduler.log 2>&1
$dockerExit=$LASTEXITCODE
$ErrorActionPreference='Stop'
if($dockerExit){throw 'PostgreSQL startup failed'}
& node node_modules/tsx/dist/cli.mjs server/workflow-cli.ts schedule >> data/logs/scheduler.log 2>&1
exit $LASTEXITCODE
