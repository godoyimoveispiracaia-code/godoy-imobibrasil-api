$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Este instalador requer o Windows do robo.' }
& node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(':memory:'); db.close();"
if ($LASTEXITCODE -ne 0) { throw 'Instale Node.js 22.13 ou mais recente antes de continuar.' }
$source = Read-Host 'Caminho completo do acompanhamento.json [G:\Meu Drive\Godoy Captacoes WhatsApp\acompanhamento.json]'
if ([string]::IsNullOrWhiteSpace($source)) { $source = 'G:\Meu Drive\Godoy Capta' + [char]0xE7 + [char]0xF5 + 'es WhatsApp\acompanhamento.json' }
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'Arquivo de acompanhamento nao encontrado. Mantenha o robo e o Google Drive abertos.' }
$excludedInput = Read-Host 'Numeros seus, dos administradores e internos que NAO devem virar leads (com DDD, separados por virgula)'
$excluded = @($excludedInput.Split(',') | ForEach-Object { $_ -replace '\D', '' } | Where-Object { $_ })
if ($excluded.Count -lt 1) { throw 'Informe ao menos seu proprio numero para impedir cadastros internos.' }
$credential = Get-Credential -Message 'Administrador do ImobiBrasil. A senha fica protegida pelo Windows deste usuario.'
if ($null -eq $credential) { throw 'Credencial nao informada.' }
$root = Join-Path $env:LOCALAPPDATA 'GodoyCRM'
$taskName = 'Godoy CRM Leads'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    throw 'A tarefa Godoy CRM Leads ja existe. Use PAUSAR.bat antes de atualizar e preserve state.sqlite; nao reinstale por cima de uma tarefa ativa.'
}
New-Item -ItemType Directory -Path $root -Force | Out-Null
# Protect local credentials, source-derived phone index and activity metadata.
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls $root /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel proteger a pasta local.' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'probe.js') -Destination $root -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Destination $root -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Run.ps1') -Destination $root -Force
New-Item -ItemType Directory -Path (Join-Path $root 'sync') -Force | Out-Null
foreach ($name in @('core.mjs','worker.mjs')) {
    Copy-Item -LiteralPath (Join-Path (Join-Path $PSScriptRoot 'sync') $name) -Destination (Join-Path $root 'sync') -Force
}
$credential | Export-Clixml -LiteralPath (Join-Path $root 'credentials.xml')
@{ enabled = $true; source = $source; excludedPhones = $excluded; nodePath = (Get-Command node).Source } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'config.json') -Encoding UTF8
$env:GODOY_CRM_ONCE = 'true'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'Run.ps1')
Remove-Item Env:GODOY_CRM_ONCE
if ($LASTEXITCODE -ne 0) { throw "Validacao inicial falhou. A sincronizacao NAO foi ativada. Consulte $root\activity.log." }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $root 'Run.ps1') + '"') -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Novos leads WhatsApp do robo para o CRM ImobiBrasil; estado duravel local; sem alterar imoveis.' | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host 'Validacao inicial concluida e tarefa iniciada. Confira activity.log para confirmar os ciclos. O computador, o robo e o Drive precisam permanecer ligados.'
