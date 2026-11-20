param(
    [Parameter(Mandatory = $true)]
    [string]$PackageDirectory
)

$resolvedPackage = (Resolve-Path -LiteralPath $PackageDirectory).Path
$desktopDeps = Join-Path $resolvedPackage 'SkillGraph.deps.json'
$desktopRuntime = Join-Path $resolvedPackage 'SkillGraph.runtimeconfig.json'
$mcpDeps = Join-Path $resolvedPackage 'SkillGraph.Mcp.deps.json'
$mcpRuntime = Join-Path $resolvedPackage 'SkillGraph.Mcp.runtimeconfig.json'

if (-not (Test-Path -LiteralPath $desktopDeps)) {
    throw "SkillGraph.deps.json was not found in $resolvedPackage"
}
if (-not (Test-Path -LiteralPath $desktopRuntime)) {
    throw "SkillGraph.runtimeconfig.json was not found in $resolvedPackage"
}

$deps = [System.IO.File]::ReadAllText($desktopDeps)
$deps = $deps.Replace('SkillGraph/0.9.0', 'SkillGraph.Mcp/1.0.0')
$deps = $deps.Replace('SkillGraph/1.0.0', 'SkillGraph.Mcp/1.0.0')
$deps = $deps.Replace('SkillGraph.dll', 'SkillGraph.Mcp.dll')
[System.IO.File]::WriteAllText($mcpDeps, $deps, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::Copy($desktopRuntime, $mcpRuntime, $true)

Write-Output "Portable MCP runtime metadata prepared in $resolvedPackage"
