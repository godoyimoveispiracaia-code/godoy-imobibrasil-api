$ErrorActionPreference = 'Stop'
Write-Host 'GODOY IMOVEIS - DIAGNOSTICO LOCAL CRM IMOBIBRASIL'
Write-Host 'Nao imprime credenciais, telefones, nomes ou mensagens.'
$root = Join-Path $env:LOCALAPPDATA 'GodoyCRM'
$taskName = 'Godoy CRM Leads'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -eq $task) { Write-Host 'Tarefa Windows: NAO ENCONTRADA' }
else {
  Write-Host ('Tarefa Windows: ' + $task.State)
  $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
  if ($info) {
    Write-Host ('Ultima execucao: ' + $info.LastRunTime.ToString('s'))
    Write-Host ('Codigo de resultado: ' + $info.LastTaskResult)
  }
}
Write-Host ('Pasta de trabalho: ' + $(if (Test-Path -LiteralPath $root) { 'EXISTE' } else { 'NAO ENCONTRADA' }))
Write-Host ('Estado local: ' + $(if (Test-Path -LiteralPath (Join-Path $root 'state.sqlite')) { 'EXISTE - PRESERVAR' } else { 'NAO ENCONTRADO' }))
$configPath = Join-Path $root 'config.json'
if (Test-Path -LiteralPath $configPath) {
  try {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    Write-Host ('Config privada: EXISTE')
    Write-Host ('Bloqueios privados: ' + $(if (@($config.suppressedPhones | Where-Object { $_ }).Count -gt 0) { 'CONFIGURADOS' } else { 'AUSENTES OU VERSAO ANTIGA' }))
  } catch { Write-Host 'Config privada: INVALIDA' }
} else { Write-Host 'Config privada: NAO ENCONTRADA' }
$logPath = Join-Path $root 'activity.log'
if (Test-Path -LiteralPath $logPath) {
  $last = $null
  Get-Content -LiteralPath $logPath -Tail 50 | ForEach-Object {
    try {
      $v = $_ | ConvertFrom-Json
      if ($v.event -in @('sync_cycle','baseline_created','paused','cycle_deferred','startup_failed')) { $last = $v }
    } catch { }
  }
  if ($last) {
    Write-Host ('Ultimo evento seguro: ' + $last.event)
    Write-Host ('Hora registrada: ' + $last.at)
    Write-Host ('Sync ativa neste evento: ' + $last.automaticSync)
  } else { Write-Host 'Log: EXISTE, sem evento reconhecido nas ultimas 50 linhas' }
} else { Write-Host 'Log: NAO ENCONTRADO' }
Write-Host 'AVISO: ausencia desta tarefa nao descarta outros webhooks ou executores externos.'
