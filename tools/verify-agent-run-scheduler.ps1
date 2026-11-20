$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Mcp-TestHarness.ps1')

$projectRoot = Split-Path -Parent $PSScriptRoot
$tempRoot = Join-Path (Join-Path $projectRoot '.build-temp') ("skillgraph-run-scheduler-" + [guid]::NewGuid().ToString('N'))
$registryPath = Join-Path $tempRoot 'registry.json'
$workspace = Join-Path $tempRoot 'project'
$process = $null

try {
    New-Item -ItemType Directory -Path $workspace -Force | Out-Null
    New-TestRegistry $workspace | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $registryPath -Encoding utf8
    $process = Start-SkillGraphTestServer $projectRoot $registryPath 'codex'

    $created = Invoke-SkillGraphTool $process 'create_agent_run' @{
        projectId = 'project-test'; taskManagerAgentId = 'task-agent'; title = 'Build feature'; request = 'Build one feature safely.'
    } 1
    Assert-True (-not $created.IsError) 'create_agent_run must succeed for Codex Task Manager'
    $runId = [string]$created.Data.run.id
    Assert-True ($created.Data.run.status -eq 'planning') 'new run must be planning'

    $plan = @(
        @{ id = 'build'; title = 'Build'; instructions = 'Implement'; agentId = 'cursor-agent'; dependsOn = @(); workspaceMode = 'project-write'; capabilities = @('read','write') },
        @{ id = 'review'; title = 'Review'; instructions = 'Review changes'; agentId = 'review-agent'; dependsOn = @('build'); workspaceMode = 'review'; capabilities = @('read') },
        @{ id = 'codex-note'; title = 'Planning note'; instructions = 'Record note'; agentId = 'task-agent'; dependsOn = @(); workspaceMode = 'read'; capabilities = @('read'); priority = 95 }
    )
    $submitted = Invoke-SkillGraphTool $process 'submit_agent_run_plan' @{ runId = $runId; planRevision = 1; tasks = $plan } 2
    Assert-True (-not $submitted.IsError) 'valid DAG must be accepted'
    Assert-True (($submitted.Data.tasks | Where-Object key -eq 'planning').status -eq 'completed') 'built-in planning task must be completed when plan is accepted'
    Assert-True (($submitted.Data.tasks | Where-Object key -eq 'build').status -eq 'queued') 'root task must be queued'
    Assert-True (($submitted.Data.tasks | Where-Object key -eq 'review').status -eq 'blocked') 'dependent task must be blocked'
    Assert-True (($submitted.Data.tasks | Where-Object key -eq '__final-summary').status -eq 'blocked') 'Task Manager final summary must be required'

    $runtime = Invoke-SkillGraphTool $process 'register_agent_runtime' @{ clientName = 'Scheduler Codex'; capabilities = @('read'); maxParallelTasks = 1 } 3
    $noteClaim = Invoke-SkillGraphTool $process 'claim_agent_run_task' @{ sessionId = $runtime.Data.session.id } 4
    Assert-True ($noteClaim.Data.task.key -eq 'codex-note') 'Codex worker must claim its provider task'
    Invoke-SkillGraphTool $process 'start_agent_run_task' @{ taskId = $noteClaim.Data.task.id; leaseToken = $noteClaim.Data.leaseToken } 5 | Out-Null
    Invoke-SkillGraphTool $process 'complete_agent_run_task' @{ taskId = $noteClaim.Data.task.id; leaseToken = $noteClaim.Data.leaseToken; result = 'preserve me'; artifacts = @() } 6 | Out-Null

    $replanned = Invoke-SkillGraphTool $process 'submit_agent_run_plan' @{ runId = $runId; planRevision = 2; tasks = $plan } 7
    $oldNote = $replanned.Data.tasks | Where-Object { $_.id -eq $noteClaim.Data.task.id }
    Assert-True ($oldNote.status -eq 'completed') 'replanning must preserve completed task state'
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$oldNote.supersededAt)) 'completed history must be marked superseded, not deleted'
    Assert-True (($replanned.Data.tasks | Where-Object { $_.key -eq 'codex-note' -and -not $_.supersededAt }).Count -eq 1) 'replanning must append one replacement node'

    $badRun = Invoke-SkillGraphTool $process 'create_agent_run' @{ projectId = 'project-test'; taskManagerAgentId = 'task-agent'; title = 'Bad'; request = 'Bad cycle' } 8
    $cycle = @(
        @{ id = 'a'; title = 'A'; instructions = 'A'; agentId = 'task-agent'; dependsOn = @('b'); workspaceMode = 'read' },
        @{ id = 'b'; title = 'B'; instructions = 'B'; agentId = 'cursor-agent'; dependsOn = @('a'); workspaceMode = 'read' }
    )
    $rejected = Invoke-SkillGraphTool $process 'submit_agent_run_plan' @{ runId = $badRun.Data.run.id; planRevision = 1; tasks = $cycle } 9
    Assert-True $rejected.IsError 'cyclic plan must be rejected'
    $savedAfterReject = Get-Content -Raw -LiteralPath $registryPath | ConvertFrom-Json -Depth 50
    Assert-True (($savedAfterReject.runTasks | Where-Object { $_.runId -eq $badRun.Data.run.id -and $_.key -ne 'planning' }).Count -eq 0) 'rejected plan must not create partial submitted tasks'

    $paused = Invoke-SkillGraphTool $process 'pause_agent_run' @{ runId = $runId } 5
    Assert-True ($paused.Data.run.status -eq 'paused') 'pause must set paused'
    $resumed = Invoke-SkillGraphTool $process 'resume_agent_run' @{ runId = $runId } 6
    Assert-True ($resumed.Data.run.status -in @('running','waiting')) 'resume must restore active status'
    $cancelled = Invoke-SkillGraphTool $process 'cancel_agent_run' @{ runId = $runId } 7
    Assert-True ($cancelled.Data.run.status -eq 'cancelled') 'cancel must set cancelled'
    Assert-True (($cancelled.Data.tasks | Where-Object status -notin @('completed','cancelled')).Count -eq 0) 'cancel must cancel every non-terminal task'

    $listed = Invoke-SkillGraphTool $process 'list_agent_runs' @{ projectId = 'project-test' } 8
    Assert-True ($listed.Data.runs.Count -ge 2) 'list_agent_runs must return project runs'
    $deleteActive = Invoke-SkillGraphTool $process 'delete_agent_run' @{ runId = $badRun.Data.run.id } 9
    Assert-True $deleteActive.IsError 'non-terminal run must not be deleted'
    $deleted = Invoke-SkillGraphTool $process 'delete_agent_run' @{ runId = $runId } 10
    Assert-True (-not $deleted.IsError -and $deleted.Data.deleted) 'terminal run must be deletable'
    $savedAfterDelete = Get-Content -Raw -LiteralPath $registryPath | ConvertFrom-Json -Depth 50
    Assert-True (($savedAfterDelete.agentRuns | Where-Object id -eq $runId).Count -eq 0) 'deleted run must leave the run list'
    Assert-True (($savedAfterDelete.runTasks | Where-Object runId -eq $runId).Count -eq 0) 'deleted run tasks must be removed'
    Assert-True (($savedAfterDelete.runArtifacts | Where-Object runId -eq $runId).Count -eq 0) 'deleted run artifacts must be removed'
    Write-Host 'PASS scheduler plan validation, lifecycle, and terminal deletion'
}
finally {
    Stop-SkillGraphTestServer $process
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
