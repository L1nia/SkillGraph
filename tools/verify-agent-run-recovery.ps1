$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Mcp-TestHarness.ps1')

$projectRoot = Split-Path -Parent $PSScriptRoot
$tempRoot = Join-Path (Join-Path $projectRoot '.build-temp') ("skillgraph-run-recovery-" + [guid]::NewGuid().ToString('N'))
$registryPath = Join-Path $tempRoot 'registry.json'
$workspace = Join-Path $tempRoot 'project'
$codex = $null; $cursor = $null

try {
    New-Item -ItemType Directory -Path $workspace -Force | Out-Null
    New-TestRegistry $workspace | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $registryPath -Encoding utf8
    $codex = Start-SkillGraphTestServer $projectRoot $registryPath 'codex'
    $created = Invoke-SkillGraphTool $codex 'create_agent_run' @{ projectId = 'project-test'; taskManagerAgentId = 'task-agent'; title = 'Restart'; request = 'Persist this run' } 1
    $runId = $created.Data.run.id
    Invoke-SkillGraphTool $codex 'submit_agent_run_plan' @{ runId = $runId; planRevision = 1; tasks = @(
        @{ id = 'build'; title = 'Build after restart'; instructions = 'Write'; agentId = 'cursor-agent'; dependsOn = @(); workspaceMode = 'project-write'; capabilities = @('write') }
    ) } 2 | Out-Null
    Stop-SkillGraphTestServer $codex; $codex = $null

    $codex = Start-SkillGraphTestServer $projectRoot $registryPath 'codex'
    $reloaded = Invoke-SkillGraphTool $codex 'get_agent_run' @{ runId = $runId } 1
    Assert-True ($reloaded.Data.tasks.Count -ge 1) 'queued run must survive MCP restart'
    Assert-True (($reloaded.Data.tasks | Where-Object key -eq 'build').status -eq 'queued') 'queued task must survive MCP restart'
    Stop-SkillGraphTestServer $codex; $codex = $null

    $cursor = Start-SkillGraphTestServer $projectRoot $registryPath 'cursor'
    $session = Invoke-SkillGraphTool $cursor 'register_agent_runtime' @{ clientName = 'Recovery worker'; capabilities = @('read','write'); maxParallelTasks = 1 } 1
    $claim = Invoke-SkillGraphTool $cursor 'claim_agent_run_task' @{ sessionId = $session.Data.session.id } 2
    $taskId = $claim.Data.task.id
    Stop-SkillGraphTestServer $cursor; $cursor = $null

    $registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json -Depth 50
    $stale = $registry.runTasks | Where-Object id -eq $taskId
    $stale.leaseExpiresAt = [DateTimeOffset]::UtcNow.AddMinutes(-5).ToString('O')
    $registry | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $registryPath -Encoding utf8

    $cursor = Start-SkillGraphTestServer $projectRoot $registryPath 'cursor'
    $session2 = Invoke-SkillGraphTool $cursor 'register_agent_runtime' @{ clientName = 'Recovered worker'; capabilities = @('read','write'); maxParallelTasks = 1 } 1
    $reclaimed = Invoke-SkillGraphTool $cursor 'claim_agent_run_task' @{ sessionId = $session2.Data.session.id } 2
    Assert-True ($reclaimed.Data.task.id -eq $taskId) 'expired lease must return the same task to the queue'
    Invoke-SkillGraphTool $cursor 'start_agent_run_task' @{ taskId = $taskId; leaseToken = $reclaimed.Data.leaseToken } 3 | Out-Null
    Invoke-SkillGraphTool $cursor 'complete_agent_run_task' @{ taskId = $taskId; leaseToken = $reclaimed.Data.leaseToken; result = 'done'; artifacts = @() } 4 | Out-Null
    Invoke-SkillGraphTool $cursor 'complete_agent_run_task' @{ taskId = $taskId; leaseToken = $reclaimed.Data.leaseToken; result = 'overwrite'; artifacts = @() } 5 | Out-Null
    Stop-SkillGraphTestServer $cursor; $cursor = $null
    $codex = Start-SkillGraphTestServer $projectRoot $registryPath 'codex'
    $terminal = Invoke-SkillGraphTool $codex 'get_agent_run' @{ runId = $runId } 2
    $terminalTask = $terminal.Data.tasks | Where-Object id -eq $taskId
    Assert-True ($terminalTask.status -eq 'completed') 'completed task status must remain terminal'
    Assert-True ($terminalTask.result -eq 'done') 'late completion must not overwrite a completed result'

    $app = Get-Content -LiteralPath (Join-Path $projectRoot 'app.js') -Raw
    Assert-True ($app -match 'Сначала завершите или отмените активную агентную цепочку') 'desktop must guard project deletion during active run'
    Assert-True ($app -match 'getRuntimeState') 'desktop must poll runtime state'
    Write-Host 'PASS restart recovery, stale lease reconciliation, terminal immutability and deletion guard'
}
finally {
    Stop-SkillGraphTestServer $cursor; Stop-SkillGraphTestServer $codex
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
