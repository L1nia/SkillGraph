. "$PSScriptRoot\Mcp-TestHarness.ps1"

$projectRoot = Split-Path $PSScriptRoot -Parent
$testRoot = Join-Path $projectRoot ('.build-temp\skillgraph-assets-' + [guid]::NewGuid().ToString('N'))
$registryPath = Join-Path $testRoot 'registry.json'
$assetRoot = Join-Path $testRoot 'assets'
$server = $null

try {
    New-Item -ItemType Directory -Path $assetRoot -Force | Out-Null
    $pngBytes = [Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=')
    [IO.File]::WriteAllBytes((Join-Path $assetRoot 'reference.png'), $pngBytes)

    $registry = New-TestRegistry $testRoot
    $registry.projects[0].roots = @('visual-skill')
    $registry.skills = @(@{
        id = 'visual-skill'
        name = 'visual-skill'
        namespace = 'local'
        title = 'Visual skill'
        version = '1.0.0'
        content = '# Visual contract'
        tags = @('visual')
        deps = @()
        images = @(@{
            id = 'overview'
            name = 'reference.png'
            caption = 'Required overview'
            relativePath = 'reference.png'
            relation = 'extends'
        })
    })
    $registry | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $registryPath -Encoding utf8

    $server = Start-SkillGraphTestServer $projectRoot $registryPath 'codex'

    $skill = Invoke-SkillGraphTool $server 'read_skill' @{ reference = 'skill://local.visual-skill@1.0.0' } 1
    Assert-True (-not $skill.IsError) 'read_skill must succeed.'
    Assert-True ($skill.Data.attachments.Count -eq 1) 'read_skill must return the attachment manifest.'
    Assert-True ($skill.Text.Contains('read_skill_asset')) 'read_skill text must tell the agent how to open an attachment.'

    $context = Invoke-SkillGraphTool $server 'resolve_task_context' @{
        projectId = 'project-test'
        task = 'Implement the visual reference.'
        includeContent = $true
    } 2
    Assert-True (-not $context.IsError) 'resolve_task_context must succeed.'
    Assert-True ($context.Data.skills[0].attachments.Count -eq 1) 'Resolved context must include image attachments.'

    $asset = Invoke-SkillGraphTool $server 'read_skill_asset' @{
        reference = 'skill://local.visual-skill@1.0.0'
        assetId = 'overview'
    } 3
    Assert-True (-not $asset.IsError) 'read_skill_asset must succeed.'
    $image = $asset.Raw.result.content | Where-Object type -eq 'image' | Select-Object -First 1
    Assert-True ($null -ne $image) 'read_skill_asset must return MCP ImageContent.'
    Assert-True ($image.mimeType -eq 'image/png') 'ImageContent must preserve the image MIME type.'
    Assert-True (([Convert]::FromBase64String([string]$image.data)).Length -eq $pngBytes.Length) 'ImageContent must contain the source image bytes.'
    Assert-True ($null -eq $asset.Data._mcpContent) 'Base64 payload must not be duplicated in structuredContent.'

    Write-Host 'Skill image attachment verification passed.'
}
finally {
    Stop-SkillGraphTestServer $server
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
