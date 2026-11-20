. "$PSScriptRoot\Mcp-TestHarness.ps1"

$projectRoot = Split-Path $PSScriptRoot -Parent
$testRoot = Join-Path $projectRoot ('.build-temp\skillgraph-explicit-skill-' + [guid]::NewGuid().ToString('N'))
$registryPath = Join-Path $testRoot 'registry.json'
$server = $null

try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    $registry = New-TestRegistry $testRoot
    $registry.skills = @(@{
        id = 'project-template-builder'
        name = 'project-template-builder'
        namespace = 'local'
        title = 'Project template builder'
        version = '1.0.0'
        content = 'MANDATORY_ANTD_VISUAL_CONTRACT'
        tags = @('project-template')
        deps = @()
    })
    $registry | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $registryPath -Encoding utf8

    $server = Start-SkillGraphTestServer $projectRoot $registryPath 'codex'

    $byUri = Invoke-SkillGraphTool $server 'resolve_task_context' @{
        projectId = 'project-test'
        task = 'Use skill://local.project-template-builder@1.0.0 as the mandatory contract.'
        includeContent = $true
    } 1
    Assert-True (-not $byUri.IsError) 'URI context resolution must succeed.'
    Assert-True ($byUri.Text.Contains('MANDATORY_ANTD_VISUAL_CONTRACT')) 'Explicit skill URI must add skill content to task context.'

    $byName = Invoke-SkillGraphTool $server 'resolve_task_context' @{
        projectId = 'project-test'
        task = 'Create a project using the project-template-builder skill.'
        includeContent = $true
    } 2
    Assert-True (-not $byName.IsError) 'Named context resolution must succeed.'
    Assert-True ($byName.Text.Contains('MANDATORY_ANTD_VISUAL_CONTRACT')) 'Exact skill name must add skill content to task context.'

    Write-Host 'Explicit skill context verification passed.'
}
finally {
    Stop-SkillGraphTestServer $server
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
