$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Mcp-TestHarness.ps1')

$projectRoot = Split-Path -Parent $PSScriptRoot
$tempRoot = Join-Path (Join-Path $projectRoot '.build-temp') ("skillgraph-provider-neutral-" + [guid]::NewGuid().ToString('N'))
$processes = @()

try {
    foreach ($managerProvider in @('cursor', 'claude', 'deepseek', 'qwen', 'custom')) {
        $caseRoot = Join-Path $tempRoot $managerProvider
        $workspace = Join-Path $caseRoot 'project'
        $registryPath = Join-Path $caseRoot 'registry.json'
        New-Item -ItemType Directory -Path $workspace -Force | Out-Null
        $registry = New-TestRegistry $workspace
        $registry.agents[0].provider = $managerProvider
        $registry.agents += @{ id = 'copilot-agent'; name = 'Copilot Worker'; role = 'Implementation'; provider = 'copilot'; status = 'active'; rootSkills = @(); permissions = @{ read = $true; create = $true; edit = $true; relations = $true; delete = $false } }
        $registry.projects[0].agentIds += 'copilot-agent'
        $registry | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $registryPath -Encoding utf8

        $manager = Start-SkillGraphTestServer $projectRoot $registryPath $managerProvider; $processes += $manager
        $created = Invoke-SkillGraphTool $manager 'create_agent_run' @{ projectId = 'project-test'; taskManagerAgentId = 'task-agent'; title = "Manager $managerProvider"; request = 'Provider-neutral plan' } 1
        Assert-True (-not $created.IsError) "$managerProvider Task Manager must create a run"
        Assert-True ($created.Data.planningTask.provider -eq $managerProvider) 'planning task provider must come from the Task Manager profile'
        $plan = @(@{ id = 'work'; title = 'Provider work'; instructions = 'Execute'; agentId = 'copilot-agent'; dependsOn = @(); workspaceMode = 'project-write'; capabilities = @('read','write') })
        $submitted = Invoke-SkillGraphTool $manager 'submit_agent_run_plan' @{ runId = $created.Data.run.id; planRevision = 1; tasks = $plan } 2
        Assert-True (-not $submitted.IsError) "$managerProvider Task Manager must submit its plan"
        Assert-True (($submitted.Data.tasks | Where-Object key -eq 'work').provider -eq 'copilot') 'executor provider must come from the assigned agent profile'

        $wrong = Start-SkillGraphTestServer $projectRoot $registryPath 'codex'; $processes += $wrong
        $denied = Invoke-SkillGraphTool $wrong 'create_agent_run' @{ projectId = 'project-test'; taskManagerAgentId = 'task-agent'; title = 'Wrong'; request = 'Must fail' } 1
        Assert-True $denied.IsError 'a different provider must not impersonate the Task Manager'

        $worker = Start-SkillGraphTestServer $projectRoot $registryPath 'copilot'; $processes += $worker
        $session = Invoke-SkillGraphTool $worker 'register_agent_runtime' @{ clientName = 'Copilot worker'; capabilities = @('read','write'); maxParallelTasks = 1 } 1
        $claim = Invoke-SkillGraphTool $worker 'claim_agent_run_task' @{ sessionId = $session.Data.session.id } 2
        Assert-True ($claim.Data.task.agentId -eq 'copilot-agent') 'worker must claim the task assigned to its provider agent'

        Stop-SkillGraphTestServer $worker; Stop-SkillGraphTestServer $wrong; Stop-SkillGraphTestServer $manager
        $processes = @()
    }

    $app = Get-Content -LiteralPath (Join-Path $projectRoot 'app.js') -Raw
    $hostSource = Get-Content -LiteralPath (Join-Path $projectRoot 'desktop-native\MainForm.cs') -Raw
    Assert-True ($app -notmatch 'Task Manager должен использовать провайдер Codex') 'desktop UI must not require Codex Task Manager'
    Assert-True ($hostSource -match 'start.ArgumentList.Add\(provider\)') 'native scheduler bridge must pass the selected agent provider'
    Assert-True ($hostSource -match 'provider:connect') 'native host must expose generic provider connection profiles'
    Assert-True ($app -match "deepseek: 'DeepSeek'") 'DeepSeek must be available in the agent UI'
    Assert-True ($app -match "qwen: 'Qwen'") 'Qwen must be available in the agent UI'
    Write-Host 'PASS provider-neutral Task Manager and executor routing'
}
finally {
    foreach ($process in $processes) { Stop-SkillGraphTestServer $process }
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
