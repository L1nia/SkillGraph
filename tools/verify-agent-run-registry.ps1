$ErrorActionPreference = 'Stop'

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERT: $Message" }
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$tempRoot = Join-Path (Join-Path $projectRoot '.build-temp') ("skillgraph-run-registry-" + [guid]::NewGuid().ToString('N'))
$registryPath = Join-Path $tempRoot 'registry.json'
$projectPath = Join-Path $tempRoot 'project'
New-Item -ItemType Directory -Path $projectPath -Force | Out-Null

try {
    $registry = [ordered]@{
        schema = 'skillgraph/registry-v2'
        updatedAt = [DateTimeOffset]::UtcNow.ToString('O')
        skills = @()
        projects = @(@{
            id = 'project-test'; name = 'Test'; location = $projectPath; description = ''
            roots = @(); agentIds = @('task-agent'); bindingMode = 'reference'; versionMode = 'follow-registry'
        })
        agents = @(@{
            id = 'task-agent'; name = 'Task Manager'; role = 'Planning'; provider = 'codex'; status = 'active'
            rootSkills = @(); permissions = @{ read = $true; create = $true; update = $true; link = $true; delete = $false }
        })
        handoffs = @(); auditLog = @(); evaluations = @(); sources = @(); groups = @(); settings = @{}
    }
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    $registry | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $registryPath -Encoding utf8

    dotnet build (Join-Path $projectRoot 'mcp-server\SkillGraph.Mcp.csproj') -c Release --nologo | Out-Null
    $server = Join-Path $projectRoot 'mcp-server\bin\Release\net8.0\SkillGraph.Mcp.exe'
    $psi = [Diagnostics.ProcessStartInfo]::new($server)
    $psi.ArgumentList.Add('--registry'); $psi.ArgumentList.Add($registryPath)
    $psi.ArgumentList.Add('--client-provider'); $psi.ArgumentList.Add('codex')
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $process = [Diagnostics.Process]::Start($psi)

    $request = @{
        jsonrpc = '2.0'; id = 1; method = 'tools/call'
        params = @{ name = 'resolve_task_context'; arguments = @{ projectId = 'project-test'; task = 'registry migration'; includeContent = $false } }
    } | ConvertTo-Json -Depth 20 -Compress
    $process.StandardInput.WriteLine($request)
    $process.StandardInput.Flush()
    $response = $process.StandardOutput.ReadLine() | ConvertFrom-Json -Depth 30
    $process.StandardInput.Close()
    $process.WaitForExit(5000) | Out-Null

    if ($response.error) { Write-Host ($response | ConvertTo-Json -Depth 10) }
    Assert-True ($null -eq $response.error) 'resolve_task_context must succeed'
    $saved = Get-Content -Raw -LiteralPath $registryPath | ConvertFrom-Json -Depth 30
    Assert-True ($null -ne $saved.agentRuns) 'agentRuns must be normalized'
    Assert-True ($null -ne $saved.runTasks) 'runTasks must be normalized'
    Assert-True ($null -ne $saved.runArtifacts) 'runArtifacts must be normalized'
    Assert-True ($saved.registryRevision -ge 1) 'registryRevision must be a positive integer after save'
    Assert-True ((Select-String -LiteralPath (Join-Path $projectRoot 'mcp-server\Program.cs') -Pattern 'ServerVersion = "1.0.0"' -Quiet)) 'server version must remain 1.0.0'
    Write-Host 'PASS registry migration and unchanged version'
}
finally {
    if ($process -and -not $process.HasExited) { $process.Kill($true) }
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
