$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$env:GODOY_CRM_HOME = $root
$env:NODE_NO_WARNINGS = '1'
$config = Get-Content -LiteralPath (Join-Path $root 'config.json') -Raw | ConvertFrom-Json
$credential = Import-Clixml -LiteralPath (Join-Path $root 'credentials.xml')
$env:IMOBIBRASIL_USERNAME = $credential.UserName
$env:IMOBIBRASIL_PASSWORD = $credential.GetNetworkCredential().Password
try {
    $log = Join-Path $root 'activity.log'
    # Only counters/fixed status codes are logged by the worker; no conversations or credentials.
    if ((Test-Path $log) -and (Get-Item $log).Length -gt 2MB) { Move-Item $log ($log + '.previous') -Force }
    & $config.nodePath (Join-Path $root 'sync\worker.mjs') >> $log 2>&1
    exit $LASTEXITCODE
} finally {
    Remove-Item Env:IMOBIBRASIL_USERNAME -ErrorAction SilentlyContinue
    Remove-Item Env:IMOBIBRASIL_PASSWORD -ErrorAction SilentlyContinue
}
