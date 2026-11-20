$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Mcp-TestHarness.ps1')

$projectRoot = Split-Path -Parent $PSScriptRoot
$tempRoot = Join-Path (Join-Path $projectRoot '.build-temp') ("skillgraph-run-worker-" + [guid]::NewGuid().ToString('N'))
$registryPath = Join-Path $tempRoot 'registry.json'
$workspace = Join-Path $tempRoot 'project'
$codex = $null; $cursor = $null; $cursor2 = $null; $unknown = $null

try {
    New-Item -ItemType Directory -Path $workspace -Force | Out-Null
    New-TestRegistry $workspace | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $registryPath -Encoding utf8
    $codex = Start-SkillGraphTestServer $projectRoot $registryPath 'codex'
    $cursor = Start-SkillGraphTestServer $projectRoot $registryPath 'cursor'
    $cursor2 = Start-SkillGraphTestServer $projectRoot $registryPath 'cursor'

    $codex.StandardInput.WriteLine((@{ jsonrpc = '2.0'; id = 99; method = 'tools/list'; params = @{} } | ConvertTo-Json -Compress))
    $codex.StandardInput.Flush()
    $toolList = $codex.StandardOutput.ReadLine() | ConvertFrom-Json -Depth 50
    $planTool = $toolList.result.tools | Where-Object name -eq 'submit_agent_run_plan'
    $completeTool = $toolList.result.tools | Where-Object name -eq 'complete_agent_run_task'
    Assert-True ($planTool.inputSchema.properties.tasks.items.type -eq 'object') 'plan task array schema must accept objects'
    Assert-True ($completeTool.inputSchema.properties.artifacts.items.type -eq 'object') 'artifact array schema must accept objects'

    $codexSession = Invoke-SkillGraphTool $codex 'register_agent_runtime' @{ clientName = 'Codex test'; capabilities = @('read','write','handoff','audit'); maxParallelTasks = 1 } 1
    $cursorSession = Invoke-SkillGraphTool $cursor 'register_agent_runtime' @{ clientName = 'Cursor test 1'; capabilities = @('read','write','review'); maxParallelTasks = 2 } 1
    $cursorSession2 = Invoke-SkillGraphTool $cursor2 'register_agent_runtime' @{ clientName = 'Cursor test 2'; capabilities = @('read','write','review'); maxParallelTasks = 2 } 1
    Assert-True ($codexSession.Data.session.provider -eq 'codex') 'Codex session provider must come from MCP connection'
    Assert-True ($cursorSession.Data.session.provider -eq 'cursor') 'Cursor session provider must come from MCP connection'

    $created = Invoke-SkillGraphTool $codex 'create_agent_run' @{ projectId = 'project-test'; taskManagerAgentId = 'task-agent'; title = 'Worker test'; request = 'Build and review' } 2
    $runId = $created.Data.run.id
    $plan = @(
        @{ id = 'build-a'; title = 'Build A'; instructions = 'Write A'; agentId = 'cursor-agent'; dependsOn = @(); workspaceMode = 'project-write'; capabilities = @('read','write') },
        @{ id = 'build-b'; title = 'Build B'; instructions = 'Write B'; agentId = 'cursor-agent'; dependsOn = @(); workspaceMode = 'project-write'; capabilities = @('read','write') },
        @{ id = 'review'; title = 'Review'; instructions = 'Read only'; agentId = 'review-agent'; dependsOn = @(); workspaceMode = 'review'; capabilities = @('read') },
        @{ id = 'final'; title = 'Final review'; instructions = 'Check outputs'; agentId = 'review-agent'; dependsOn = @('build-a','build-b','review'); workspaceMode = 'review'; capabilities = @('read') }
    )
    Invoke-SkillGraphTool $codex 'submit_agent_run_plan' @{ runId = $runId; planRevision = 1; tasks = $plan } 3 | Out-Null

    $wrongProvider = Invoke-SkillGraphTool $codex 'claim_agent_run_task' @{ sessionId = $codexSession.Data.session.id } 4
    Assert-True ($null -eq $wrongProvider.Data.task) 'Codex must not claim Cursor tasks'

    $claim1 = Invoke-SkillGraphTool $cursor 'claim_agent_run_task' @{ sessionId = $cursorSession.Data.session.id } 2
    Assert-True ($claim1.Data.task.provider -eq 'cursor') 'Cursor must claim Cursor task'
    Assert-True (-not [string]::IsNullOrWhiteSpace($claim1.Data.leaseToken)) 'claim must return a lease token'
    Invoke-SkillGraphTool $cursor 'start_agent_run_task' @{ taskId = $claim1.Data.task.id; leaseToken = $claim1.Data.leaseToken } 3 | Out-Null

    $claim2 = Invoke-SkillGraphTool $cursor2 'claim_agent_run_task' @{ sessionId = $cursorSession2.Data.session.id } 2
    Assert-True ($claim2.Data.task.workspaceMode -ne 'project-write') 'second session must not claim another project writer'
    Invoke-SkillGraphTool $cursor2 'start_agent_run_task' @{ taskId = $claim2.Data.task.id; leaseToken = $claim2.Data.leaseToken } 3 | Out-Null
    Invoke-SkillGraphTool $cursor2 'complete_agent_run_task' @{ taskId = $claim2.Data.task.id; leaseToken = $claim2.Data.leaseToken; result = 'review complete'; artifacts = @() } 4 | Out-Null

    $progress = Invoke-SkillGraphTool $cursor 'record_agent_run_progress' @{ taskId = $claim1.Data.task.id; leaseToken = $claim1.Data.leaseToken; progress = 60; message = 'Implementing' } 4
    Assert-True ($progress.Data.task.progress -eq 60) 'progress must be persisted'
    $artifactPath = Join-Path $workspace 'result.txt'
    Set-Content -LiteralPath $artifactPath -Value 'result'
    $complete1 = Invoke-SkillGraphTool $cursor 'complete_agent_run_task' @{
        taskId = $claim1.Data.task.id; leaseToken = $claim1.Data.leaseToken; result = 'build complete'
        artifacts = @(@{ path = $artifactPath; kind = 'file'; operation = 'created'; hash = 'abc' })
    } 5
    Assert-True ($complete1.Data.task.status -eq 'completed') 'completed task must be terminal'

    $claim3 = Invoke-SkillGraphTool $cursor2 'claim_agent_run_task' @{ sessionId = $cursorSession2.Data.session.id } 5
    Assert-True ($claim3.Data.task.workspaceMode -eq 'project-write') 'second writer becomes claimable after first writer completes'
    Invoke-SkillGraphTool $cursor2 'start_agent_run_task' @{ taskId = $claim3.Data.task.id; leaseToken = $claim3.Data.leaseToken } 6 | Out-Null
    Invoke-SkillGraphTool $cursor2 'complete_agent_run_task' @{ taskId = $claim3.Data.task.id; leaseToken = $claim3.Data.leaseToken; result = 'second build'; artifacts = @() } 7 | Out-Null

    $finalClaim = Invoke-SkillGraphTool $cursor 'claim_agent_run_task' @{ sessionId = $cursorSession.Data.session.id } 6
    Assert-True ($finalClaim.Data.task.key -eq 'final') 'completed dependencies must unblock final task'

    $cancelRun = Invoke-SkillGraphTool $codex 'create_agent_run' @{ projectId = 'project-test'; taskManagerAgentId = 'task-agent'; title = 'Cancel test'; request = 'Cancel running task' } 5
    Invoke-SkillGraphTool $codex 'submit_agent_run_plan' @{ runId = $cancelRun.Data.run.id; planRevision = 1; tasks = @(@{ id = 'work'; title = 'Work'; instructions = 'Work'; agentId = 'cursor-agent'; dependsOn = @(); workspaceMode = 'project-write'; capabilities = @('write') }) } 6 | Out-Null
    $cancelClaim = Invoke-SkillGraphTool $cursor 'claim_agent_run_task' @{ sessionId = $cursorSession.Data.session.id } 7
    Invoke-SkillGraphTool $codex 'cancel_agent_run' @{ runId = $cancelRun.Data.run.id } 7 | Out-Null
    $late = Invoke-SkillGraphTool $cursor 'complete_agent_run_task' @{ taskId = $cancelClaim.Data.task.id; leaseToken = $cancelClaim.Data.leaseToken; result = 'late'; artifacts = @() } 8
    Assert-True $late.Data.orphaned 'late completion after cancel must be recorded as orphaned'

    $unknown = Start-SkillGraphTestServer $projectRoot $registryPath 'unknown'
    $unknownRegistration = Invoke-SkillGraphTool $unknown 'register_agent_runtime' @{ clientName = 'Unknown'; capabilities = @('read'); maxParallelTasks = 1 } 1
    Assert-True $unknownRegistration.IsError 'unknown provider must not register a worker'

    $heartbeat = Invoke-SkillGraphTool $cursor 'heartbeat_agent_runtime' @{ sessionId = $cursorSession.Data.session.id; activeTaskIds = @($finalClaim.Data.task.id) } 9
    Assert-True ($heartbeat.Data.session.status -eq 'online') 'heartbeat must keep session online'
    Write-Host 'PASS worker provider isolation, leases, writer lock, dependencies and orphan handling'
}
finally {
    Stop-SkillGraphTestServer $unknown; Stop-SkillGraphTestServer $cursor2; Stop-SkillGraphTestServer $cursor; Stop-SkillGraphTestServer $codex
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
