function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERT: $Message" }
}

function Start-SkillGraphTestServer([string]$ProjectRoot, [string]$RegistryPath, [string]$Provider) {
    dotnet build (Join-Path $ProjectRoot 'mcp-server\SkillGraph.Mcp.csproj') -c Release --nologo | Out-Null
    $server = Join-Path $ProjectRoot 'mcp-server\bin\Release\net8.0\SkillGraph.Mcp.exe'
    $psi = [Diagnostics.ProcessStartInfo]::new($server)
    $psi.ArgumentList.Add('--registry'); $psi.ArgumentList.Add($RegistryPath)
    $psi.ArgumentList.Add('--client-provider'); $psi.ArgumentList.Add($Provider)
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    $psi.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $psi.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    return [Diagnostics.Process]::Start($psi)
}

function Invoke-SkillGraphTool($Process, [string]$Name, [hashtable]$Arguments, [int]$Id = 1) {
    $request = @{
        jsonrpc = '2.0'; id = $Id; method = 'tools/call'
        params = @{ name = $Name; arguments = $Arguments }
    } | ConvertTo-Json -Depth 40 -Compress
    $Process.StandardInput.WriteLine($request)
    $Process.StandardInput.Flush()
    $line = $Process.StandardOutput.ReadLine()
    if ([string]::IsNullOrWhiteSpace($line)) { throw "MCP returned no response for $Name. STDERR: $($Process.StandardError.ReadToEnd())" }
    $response = $line | ConvertFrom-Json -Depth 50
    if ($response.error) { throw "JSON-RPC $Name failed: $($response.error.message)" }
    $content = $response.result.content | Where-Object type -eq 'text' | Select-Object -First 1
    $structured = $response.result.structuredContent
    return [pscustomobject]@{
        IsError = [bool]$response.result.isError
        Text = [string]$content.text
        Data = $structured
        Raw = $response
    }
}

function Stop-SkillGraphTestServer($Process) {
    if (-not $Process) { return }
    try { $Process.StandardInput.Close() } catch {}
    if (-not $Process.WaitForExit(3000)) { $Process.Kill($true) }
    $Process.Dispose()
}

function New-TestRegistry([string]$ProjectPath) {
    return [ordered]@{
        schema = 'skillgraph/registry-v2'; updatedAt = [DateTimeOffset]::UtcNow.ToString('O'); registryRevision = 0
        skills = @()
        projects = @(@{
            id = 'project-test'; name = 'Test'; location = $ProjectPath; description = ''; roots = @()
            agentIds = @('task-agent', 'cursor-agent', 'review-agent'); bindingMode = 'reference'; versionMode = 'follow-registry'
        })
        agents = @(
            @{ id = 'task-agent'; name = 'Task Manager'; role = 'Planning'; provider = 'codex'; status = 'active'; rootSkills = @(); permissions = @{ read = $true; create = $true; edit = $true; relations = $true; delete = $false } },
            @{ id = 'cursor-agent'; name = 'Cursor Builder'; role = 'Implementation'; provider = 'cursor'; status = 'active'; rootSkills = @(); permissions = @{ read = $true; create = $true; edit = $true; relations = $true; delete = $false } },
            @{ id = 'review-agent'; name = 'Cursor Reviewer'; role = 'Review'; provider = 'cursor'; status = 'active'; rootSkills = @(); permissions = @{ read = $true; create = $false; edit = $false; relations = $false; delete = $false } }
        )
        handoffs = @(); agentRuns = @(); runTasks = @(); runArtifacts = @(); auditLog = @(); evaluations = @(); sources = @(); groups = @(); settings = @{}
    }
}
