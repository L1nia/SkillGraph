using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Security.Cryptography;

namespace SkillGraph.Mcp;

internal static class Program
{
    private const string ServerVersion = "1.0.0";
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = false };

    private static async Task Main(string[] args)
    {
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = new UTF8Encoding(false);

        var registryPath = ResolveRegistryPath(args);
        var clientProvider = ResolveClientProvider(args);
        var server = new SkillGraphServer(registryPath, ServerVersion, clientProvider);

        string? line;
        while ((line = await Console.In.ReadLineAsync()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            JsonObject? response = null;
            try
            {
                var request = JsonNode.Parse(line) as JsonObject
                    ?? throw new McpException(-32600, "Invalid JSON-RPC request.");
                response = server.Handle(request);
            }
            catch (JsonException error)
            {
                response = Error(null, -32700, $"Parse error: {error.Message}");
            }
            catch (McpException error)
            {
                response = Error(null, error.Code, error.Message);
            }
            catch (Exception error)
            {
                response = Error(null, -32603, $"Internal error: {error.Message}");
            }

            if (response is null) continue;
            await Console.Out.WriteLineAsync(response.ToJsonString(JsonOptions));
            await Console.Out.FlushAsync();
        }
    }

    private static string ResolveRegistryPath(string[] args)
    {
        for (var index = 0; index < args.Length - 1; index++)
            if (args[index].Equals("--registry", StringComparison.OrdinalIgnoreCase))
                return Path.GetFullPath(Environment.ExpandEnvironmentVariables(args[index + 1]));

        var fromEnvironment = Environment.GetEnvironmentVariable("SKILLGRAPH_REGISTRY");
        if (!string.IsNullOrWhiteSpace(fromEnvironment))
            return Path.GetFullPath(Environment.ExpandEnvironmentVariables(fromEnvironment));

        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "SkillGraph",
            "registry.json");
    }

    private static string ResolveClientProvider(string[] args)
    {
        for (var index = 0; index < args.Length - 1; index++)
            if (args[index].Equals("--client-provider", StringComparison.OrdinalIgnoreCase))
                return NormalizeProvider(args[index + 1]);

        return NormalizeProvider(Environment.GetEnvironmentVariable("SKILLGRAPH_CLIENT_PROVIDER"));
    }

    private static string NormalizeProvider(string? value)
    {
        var provider = value?.Trim().ToLowerInvariant();
        return provider is "codex" or "cursor" or "claude" or "copilot" or "deepseek" or "qwen" or "local" or "custom"
            ? provider
            : "unknown";
    }

    internal static JsonObject Error(JsonNode? id, int code, string message) => new()
    {
        ["jsonrpc"] = "2.0",
        ["id"] = id?.DeepClone(),
        ["error"] = new JsonObject { ["code"] = code, ["message"] = message }
    };
}

internal sealed class SkillGraphServer
{
    private readonly string _registryPath;
    private readonly string _version;
    private readonly string _clientProvider;

    public SkillGraphServer(string registryPath, string version, string clientProvider = "unknown")
    {
        _registryPath = registryPath;
        _version = version;
        _clientProvider = clientProvider;
    }

    public JsonObject? Handle(JsonObject request)
    {
        if (request["jsonrpc"]?.GetValue<string>() != "2.0")
            throw new McpException(-32600, "jsonrpc must be 2.0.");

        var method = request["method"]?.GetValue<string>()
            ?? throw new McpException(-32600, "Request method is missing.");
        var id = request["id"]?.DeepClone();
        var parameters = request["params"] as JsonObject ?? new JsonObject();

        if (id is null && method.StartsWith("notifications/", StringComparison.Ordinal)) return null;

        JsonNode result = method switch
        {
            "initialize" => Initialize(parameters),
            "server/discover" => Discover(),
            "ping" => new JsonObject(),
            "tools/list" => ListTools(),
            "tools/call" => CallTool(parameters),
            "resources/list" => ListResources(),
            "resources/templates/list" => ListResourceTemplates(),
            "resources/read" => ReadResource(parameters),
            "prompts/list" => ListPrompts(),
            "prompts/get" => GetPrompt(parameters),
            "logging/setLevel" => new JsonObject(),
            _ => throw new McpException(-32601, $"Method not found: {method}")
        };

        return new JsonObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = id,
            ["result"] = result
        };
    }

    private JsonObject Initialize(JsonObject parameters)
    {
        var requested = parameters["protocolVersion"]?.GetValue<string>();
        var protocol = string.IsNullOrWhiteSpace(requested) ? "2025-11-25" : requested;
        return new JsonObject
        {
            ["protocolVersion"] = protocol,
            ["capabilities"] = Capabilities(),
            ["serverInfo"] = new JsonObject { ["name"] = "skillgraph", ["version"] = _version, ["clientProvider"] = _clientProvider },
            ["instructions"] = $"This connection identifies the calling runtime as '{_clientProvider}'. Before planning or changing code, call resolve_task_context with the current workspace path and the user's task. Read skills in requiredOrder. A Task Manager may create and plan a run only through the provider assigned to that agent profile. Activated workers register with register_agent_runtime and claim only tasks whose agent profile uses the same provider. Provider identity always comes from --client-provider and cannot be overridden by a plan. Resolve skill:// references through this server; never download them from the web. Call record_agent_outcome after execution; routing, context resolution, handoff acceptance and completion are audited automatically."
        };
    }

    private JsonObject Discover() => new()
    {
        ["serverInfo"] = new JsonObject { ["name"] = "skillgraph", ["version"] = _version, ["clientProvider"] = _clientProvider },
        ["capabilities"] = Capabilities(),
        ["instructions"] = "Call resolve_task_context before work and use read_skill for skill:// references."
    };

    private static JsonObject Capabilities() => new()
    {
        ["tools"] = new JsonObject { ["listChanged"] = false },
        ["resources"] = new JsonObject { ["subscribe"] = false, ["listChanged"] = false },
        ["prompts"] = new JsonObject { ["listChanged"] = false },
        ["logging"] = new JsonObject()
    };

    private JsonObject ListTools() => new()
    {
        ["tools"] = new JsonArray
        {
            Tool("resolve_task_context", "MANDATORY before planning or editing: resolve the SkillGraph chain for the current project and task. Returns full Markdown by default; do not fetch skill:// URIs from the web.", ObjectSchema(
                ("workspacePath", "string", "Absolute path of the current workspace root."),
                ("projectId", "string", "Optional SkillGraph project id."),
                ("task", "string", "The user's current task."),
                ("activeFiles", "array", "Optional active or relevant project files."),
                ("includeContent", "boolean", "Include complete skill Markdown. Defaults to true.")), new[] { "task" }),
            Tool("resolve_agent_context", "Resolve a project-aware, permission-checked skill chain for one SkillGraph agent.", ObjectSchema(
                ("agentId", "string", "SkillGraph agent id."),
                ("workspacePath", "string", "Absolute path of the current workspace root."),
                ("projectId", "string", "Optional SkillGraph project id."),
                ("task", "string", "The current task."),
                ("runId", "string", "Optional agent run id."),
                ("taskId", "string", "Optional explicit run task id."),
                ("handoffId", "string", "Optional explicit handoff id."),
                ("activeFiles", "array", "Optional active or relevant project files."),
                ("includeContent", "boolean", "Include complete skill Markdown. Defaults to true.")), new[] { "agentId", "task" }),
            Tool("route_agent_task", "Recommend a project agent for a task using roles, routing keywords, priorities, and skill relevance. Does not start an agent.", ObjectSchema(
                ("workspacePath", "string", "Absolute path of the current workspace root."),
                ("projectId", "string", "Optional SkillGraph project id."),
                ("task", "string", "Task to route.")), new[] { "task" }),
            Tool("read_skill", "Read one skill directly from the local SkillGraph registry. Accepts a skill:// URI or an id. Never use web download for skill:// references.", ObjectSchema(
                ("reference", "string", "skill://namespace.id@version or a local skill id.")), new[] { "reference" }),
            Tool("read_skill_asset", "Read an image attached to a SkillGraph skill. Returns real MCP ImageContent so the agent can inspect the reference instead of guessing from a text link.", ObjectSchema(
                ("reference", "string", "skill://namespace.id@version or a local skill id."),
                ("assetId", "string", "Attachment id from read_skill or resolved context.")), new[] { "reference", "assetId" }),
            Tool("list_project_skills", "List roots, resolved dependency order, and conflicts for a connected project.", ObjectSchema(
                ("workspacePath", "string", "Absolute path of the workspace."),
                ("projectId", "string", "Optional SkillGraph project id."))),
            Tool("search_skills", "Search the local registry by title, id, namespace, description, tags, or task text.", ObjectSchema(
                ("query", "string", "Search query."),
                ("limit", "integer", "Maximum number of results; defaults to 10.")), new[] { "query" }),
            Tool("validate_project_graph", "Validate a project's graph for missing skills and dependency cycles.", ObjectSchema(
                ("workspacePath", "string", "Absolute path of the workspace."),
                ("projectId", "string", "Optional SkillGraph project id."))),
            Tool("create_skill", "Create a new reusable skill in the local SkillGraph registry when the user asks Codex to preserve guidance or add a skill. Fails if the id already exists.", ObjectSchema(
                ("id", "string", "Stable lowercase skill id; letters, digits, and hyphens."),
                ("name", "string", "Human-readable skill name."),
                ("namespace", "string", "Optional namespace; defaults to codex."),
                ("version", "string", "Optional SemVer; defaults to 0.1.0."),
                ("description", "string", "Purpose of the skill."),
                ("tags", "array", "Optional tags."),
                ("content", "string", "Optional complete Markdown. A template is generated when omitted.")), new[] { "id", "name" }, readOnly: false),
            Tool("set_skill_relation", "Create or update one typed relation between two existing SkillGraph skills. Use after create_skill when the new skill extends, requires, or recommends another skill.", ObjectSchema(
                ("sourceId", "string", "Skill that owns the relation."),
                ("targetId", "string", "Connected target skill."),
                ("type", "string", "Relation type: requires, extends, or recommends."),
                ("range", "string", "Optional version range; defaults to *.")), new[] { "sourceId", "targetId", "type" }, readOnly: false),
            Tool("create_agent_handoff", "Create a bounded handoff from one project agent to another with the resolved skill ids.", ObjectSchema(
                ("projectId", "string", "SkillGraph project id."), ("fromAgentId", "string", "Source agent id."), ("toAgentId", "string", "Target agent id."),
                ("task", "string", "Task being handed off."), ("result", "string", "Current result."), ("questions", "string", "Open questions."),
                ("runId", "string", "Optional run link."), ("taskId", "string", "Optional run task link.")), new[] { "projectId", "fromAgentId", "toAgentId", "task" }, readOnly: false),
            Tool("list_agent_handoffs", "List handoffs visible to the calling provider. Each provider sees work for agents assigned to that provider and handoffs created by it.", ObjectSchema(
                ("projectId", "string", "Optional project filter."), ("agentId", "string", "Optional source or target agent filter."),
                ("status", "string", "Optional pending, accepted, or done filter."), ("limit", "integer", "Maximum records; defaults to 50."))),
            Tool("list_agent_audit", "List local agent routing, context, and handoff audit events.", ObjectSchema(
                ("projectId", "string", "Optional project filter."), ("agentId", "string", "Optional agent filter."), ("limit", "integer", "Maximum events; defaults to 50."))),
            Tool("record_agent_outcome", "Record task outcome metrics without storing full prompts by default.", ObjectSchema(
                ("agentId", "string", "Agent id."), ("projectId", "string", "Project id."), ("success", "boolean", "Whether the task succeeded."),
                ("durationMs", "integer", "Task duration."), ("contextChars", "integer", "Resolved context size."), ("detail", "string", "Short non-sensitive note."),
                ("runId", "string", "Optional run link."), ("taskId", "string", "Optional run task link."), ("handoffId", "string", "Optional explicit handoff link.")), new[] { "agentId", "projectId", "success" }, readOnly: false),
            Tool("list_agent_runtimes", "List provider-independent agent adapters and their declared MCP capabilities.", ObjectSchema(
                ("provider", "string", "Optional provider filter: codex, cursor, claude, copilot, deepseek, qwen, local, or custom."))),
            Tool("record_agent_evaluation", "Record a local baseline or SkillGraph-assisted result for reproducible quality comparison.", ObjectSchema(
                ("agentId", "string", "Agent id."), ("projectId", "string", "Project id."), ("task", "string", "Short non-sensitive task label."),
                ("mode", "string", "baseline or skillgraph."), ("success", "boolean", "Whether the task succeeded."),
                ("usefulness", "integer", "Manual usefulness score from 1 to 5."), ("durationMs", "integer", "Optional task duration."),
                ("note", "string", "Optional short note without the original prompt.")), new[] { "agentId", "projectId", "task", "mode", "success", "usefulness" }, readOnly: false),
            Tool("list_agent_evaluations", "List locally stored agent quality evaluations, optionally filtered by project or agent.", ObjectSchema(
                ("projectId", "string", "Optional project filter."), ("agentId", "string", "Optional agent filter."),
                ("limit", "integer", "Maximum records; defaults to 50."))),
            Tool("create_agent_run", "Create a persistent agent run whose plan will be produced by the assigned Task Manager.", ObjectSchema(
                ("projectId", "string", "SkillGraph project id."), ("taskManagerAgentId", "string", "Task Manager agent id; its configured provider becomes the planning provider."),
                ("title", "string", "Short run title."), ("request", "string", "User request; persisted as a bounded summary and hash.")), new[] { "projectId", "taskManagerAgentId", "title", "request" }, readOnly: false),
            Tool("list_agent_runs", "List persisted agent runs for a project.", ObjectSchema(
                ("projectId", "string", "Optional project filter."), ("status", "string", "Optional status filter."), ("limit", "integer", "Maximum rows; defaults to 50."))),
            Tool("get_agent_run", "Read one agent run with tasks and artifacts.", ObjectSchema(
                ("runId", "string", "Agent run id.")), new[] { "runId" }),
            Tool("submit_agent_run_plan", "Submit a validated DAG for a planning run. Only the assigned Task Manager provider may call this.", ObjectSchema(
                ("runId", "string", "Agent run id."), ("planRevision", "integer", "Monotonic plan revision."),
                ("tasks", "array", "Bounded task DAG.")), new[] { "runId", "planRevision", "tasks" }, readOnly: false),
            Tool("pause_agent_run", "Pause new claims for a run.", ObjectSchema(("runId", "string", "Agent run id.")), new[] { "runId" }, readOnly: false),
            Tool("resume_agent_run", "Resume a paused run and recompute ready tasks.", ObjectSchema(("runId", "string", "Agent run id.")), new[] { "runId" }, readOnly: false),
            Tool("cancel_agent_run", "Cooperatively cancel a run and all non-terminal tasks.", ObjectSchema(("runId", "string", "Agent run id.")), new[] { "runId" }, readOnly: false),
            Tool("delete_agent_run", "Permanently delete a terminal run and its stored tasks, artifacts, and handoffs.", ObjectSchema(("runId", "string", "Terminal agent run id.")), new[] { "runId" }, readOnly: false)
            ,Tool("register_agent_runtime", "Activate semi-autonomous worker mode for this explicitly identified provider connection.", ObjectSchema(
                ("clientName", "string", "Human-readable worker name."), ("capabilities", "array", "Worker capabilities."),
                ("maxParallelTasks", "integer", "Maximum parallel tasks.")), new[] { "clientName", "capabilities" }, readOnly: false)
            ,Tool("heartbeat_agent_runtime", "Refresh a worker session and report active tasks.", ObjectSchema(
                ("sessionId", "string", "Runtime session id."), ("activeTaskIds", "array", "Currently active task ids.")), new[] { "sessionId" }, readOnly: false)
            ,Tool("claim_agent_run_task", "Atomically claim the next ready task for this provider worker.", ObjectSchema(
                ("sessionId", "string", "Runtime session id.")), new[] { "sessionId" }, readOnly: false)
            ,Tool("start_agent_run_task", "Start a claimed task using its lease token.", ObjectSchema(
                ("taskId", "string", "Run task id."), ("leaseToken", "string", "Claim lease token.")), new[] { "taskId", "leaseToken" }, readOnly: false)
            ,Tool("record_agent_run_progress", "Record bounded progress for a running task.", ObjectSchema(
                ("taskId", "string", "Run task id."), ("leaseToken", "string", "Claim lease token."),
                ("progress", "integer", "Progress from 0 to 100."), ("message", "string", "Short progress message.")), new[] { "taskId", "leaseToken", "progress" }, readOnly: false)
            ,Tool("complete_agent_run_task", "Complete a leased task and atomically unblock dependants.", ObjectSchema(
                ("taskId", "string", "Run task id."), ("leaseToken", "string", "Claim lease token."),
                ("result", "string", "Bounded result summary."), ("artifacts", "array", "Artifact descriptors inside the project workspace.")), new[] { "taskId", "leaseToken", "result" }, readOnly: false)
            ,Tool("fail_agent_run_task", "Fail or retry a leased task.", ObjectSchema(
                ("taskId", "string", "Run task id."), ("leaseToken", "string", "Claim lease token."),
                ("error", "string", "Bounded failure summary."), ("retryable", "boolean", "Whether another attempt is allowed.")), new[] { "taskId", "leaseToken", "error" }, readOnly: false)
            ,Tool("retry_agent_run_task", "Return a failed unleased task to the provider queue.", ObjectSchema(
                ("taskId", "string", "Run task id.")), new[] { "taskId" }, readOnly: false)
            ,Tool("reassign_agent_run_task", "Reassign an unleased queued, blocked, or failed task to another project agent.", ObjectSchema(
                ("taskId", "string", "Run task id."), ("agentId", "string", "Replacement project agent id.")), new[] { "taskId", "agentId" }, readOnly: false)
        }
    };

    private JsonObject CallTool(JsonObject parameters)
    {
        var name = parameters["name"]?.GetValue<string>()
            ?? throw new McpException(-32602, "Tool name is required.");
        var arguments = parameters["arguments"] as JsonObject ?? new JsonObject();

        try
        {
            var data = name switch
            {
                "resolve_task_context" => ResolveTaskContext(arguments),
                "resolve_agent_context" => ResolveAgentContext(arguments),
                "route_agent_task" => RouteAgentTask(arguments),
                "read_skill" => ReadSkill(arguments),
                "read_skill_asset" => ReadSkillAsset(arguments),
                "list_project_skills" => ListProjectSkills(arguments),
                "search_skills" => SearchSkills(arguments),
                "validate_project_graph" => ValidateProjectGraph(arguments),
                "create_skill" => CreateSkill(arguments),
                "set_skill_relation" => SetSkillRelation(arguments),
                "create_agent_handoff" => CreateAgentHandoff(arguments),
                "list_agent_handoffs" => ListAgentHandoffs(arguments),
                "list_agent_audit" => ListAgentAudit(arguments),
                "record_agent_outcome" => RecordAgentOutcome(arguments),
                "list_agent_runtimes" => ListAgentRuntimes(arguments),
                "record_agent_evaluation" => RecordAgentEvaluation(arguments),
                "list_agent_evaluations" => ListAgentEvaluations(arguments),
                "create_agent_run" => CreateAgentRun(arguments),
                "list_agent_runs" => ListAgentRuns(arguments),
                "get_agent_run" => GetAgentRun(arguments),
                "submit_agent_run_plan" => SubmitAgentRunPlan(arguments),
                "pause_agent_run" => PauseAgentRun(arguments),
                "resume_agent_run" => ResumeAgentRun(arguments),
                "cancel_agent_run" => CancelAgentRun(arguments),
                "delete_agent_run" => DeleteAgentRun(arguments),
                "register_agent_runtime" => RegisterAgentRuntime(arguments),
                "heartbeat_agent_runtime" => HeartbeatAgentRuntime(arguments),
                "claim_agent_run_task" => ClaimAgentRunTask(arguments),
                "start_agent_run_task" => StartAgentRunTask(arguments),
                "record_agent_run_progress" => RecordAgentRunProgress(arguments),
                "complete_agent_run_task" => CompleteAgentRunTask(arguments),
                "fail_agent_run_task" => FailAgentRunTask(arguments),
                "retry_agent_run_task" => RetryAgentRunTask(arguments),
                "reassign_agent_run_task" => ReassignAgentRunTask(arguments),
                _ => throw new McpException(-32602, $"Unknown tool: {name}")
            };
            var text = data["markdown"]?.GetValue<string>() ?? data.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
            var customContent = data["_mcpContent"] as JsonArray;
            data.Remove("_mcpContent");
            return ToolResult(text, data, false, customContent);
        }
        catch (McpException error)
        {
            return ToolResult(error.Message, new JsonObject { ["error"] = error.Message }, true);
        }
    }

    private JsonObject ResolveTaskContext(JsonObject arguments)
    {
        var task = RequiredString(arguments, "task");
        var registry = LoadRegistry();
        var project = FindProject(registry, arguments);
        var resolution = ResolveRoots(registry, RootsWithExplicitSkillReferences(
            registry,
            project["roots"] as JsonArray ?? new JsonArray(),
            task));
        var includeContent = arguments["includeContent"]?.GetValue<bool?>() ?? true;
        var taskTokens = Tokenize(task);

        var orderedSkills = new JsonArray();
        var markdown = new StringBuilder();
        markdown.AppendLine($"# SkillGraph context: {project["name"]?.GetValue<string>() ?? "project"}");
        markdown.AppendLine().AppendLine($"Task: {task}");
        markdown.AppendLine().AppendLine("Read and apply the following skills in this dependency-first order. Resolve all skill:// references through SkillGraph, not the web.");

        var index = 0;
        foreach (var skill in resolution.Order)
        {
            index++;
            var uri = SkillUri(skill);
            var relevance = Relevance(skill, taskTokens);
            var reason = (project["roots"] as JsonArray)?.Any(item => item?.GetValue<string>() == SkillId(skill)) == true
                ? "project root"
                : "graph dependency";
            orderedSkills.Add(SkillSummary(skill, uri, relevance));
            markdown.AppendLine().AppendLine($"## {index}. {skill["title"]?.GetValue<string>() ?? SkillId(skill)}");
            markdown.AppendLine($"URI: `{uri}`  ");
            markdown.AppendLine($"Reason: {reason}; relevance {relevance}.");
            if (includeContent)
            {
                markdown.AppendLine().AppendLine(skill["content"]?.GetValue<string>() ?? "");
            }
            AppendAttachmentInstructions(markdown, skill);
        }

        if (resolution.Conflicts.Count > 0)
        {
            markdown.AppendLine().AppendLine("## Graph conflicts");
            foreach (var conflict in resolution.Conflicts) markdown.AppendLine($"- {conflict}");
        }

        var graph = GraphObject(resolution);
        var assignedAgentIds = (project["agentIds"] as JsonArray ?? new JsonArray()).Select(node => node?.GetValue<string>() ?? "").ToHashSet(StringComparer.OrdinalIgnoreCase);
        var assignedAgents = Agents(registry).Where(agent => assignedAgentIds.Contains(agent["id"]?.GetValue<string>() ?? "")).ToArray();
        var taskManager = assignedAgents.FirstOrDefault(agent => ProviderOf(agent) == _clientProvider &&
                $"{agent["name"]} {agent["role"]}".Contains("manager", StringComparison.OrdinalIgnoreCase))
            ?? assignedAgents.FirstOrDefault(agent => ProviderOf(agent) == _clientProvider);
        AppendAudit(registry, "task-context-resolved", taskManager?["id"]?.GetValue<string>() ?? "", project["id"]?.GetValue<string>() ?? "",
            resolution.Order.Select(SkillId), $"project context; client {_clientProvider}", contextChars: resolution.Order.Sum(skill => (skill["content"]?.GetValue<string>() ?? "").Length),
            success: resolution.Conflicts.Count == 0, task: task, requestedProvider: taskManager is null ? "" : ProviderOf(taskManager),
            clientProvider: _clientProvider, actualProvider: _clientProvider, phase: "context");
        SaveRegistry(registry);
        return new JsonObject
        {
            ["project"] = ProjectSummary(project),
            ["task"] = task,
            ["requiredOrder"] = new JsonArray(resolution.Order.Select(skill => (JsonNode?)SkillUri(skill)).ToArray()),
            ["skills"] = orderedSkills,
            ["graph"] = graph,
            ["conflicts"] = new JsonArray(resolution.Conflicts.Select(value => (JsonNode?)value).ToArray()),
            ["markdown"] = markdown.ToString()
        };
    }

    private JsonObject ResolveAgentContext(JsonObject arguments)
    {
        var task = RequiredString(arguments, "task");
        var registry = LoadRegistry();
        JsonObject? runTask = null; JsonObject? linkedRun = null;
        if (!string.IsNullOrWhiteSpace(arguments["taskId"]?.GetValue<string>()))
        {
            runTask = FindRunTask(registry, arguments["taskId"]!.GetValue<string>());
            linkedRun = FindRun(registry, runTask["runId"]?.GetValue<string>() ?? "");
            if (!string.IsNullOrWhiteSpace(arguments["runId"]?.GetValue<string>()) && linkedRun["id"]?.GetValue<string>() != arguments["runId"]?.GetValue<string>())
                throw new McpException(-32602, "taskId does not belong to runId.");
        }
        else if (!string.IsNullOrWhiteSpace(arguments["runId"]?.GetValue<string>())) linkedRun = FindRun(registry, arguments["runId"]!.GetValue<string>());
        var project = linkedRun is null ? FindProject(registry, arguments) : FindProject(registry, new JsonObject { ["projectId"] = linkedRun["projectId"]?.GetValue<string>() ?? "" });
        var agent = FindAgent(registry, RequiredString(arguments, "agentId"));
        EnsureAgentAccess(agent, project, "read");
        EnsureProviderAffinity(agent, "resolve and execute agent context");
        if (runTask is not null && runTask["agentId"]?.GetValue<string>() != agent["id"]?.GetValue<string>()) throw new McpException(-32003, "Run task is assigned to a different agent.");
        var roots = new JsonArray();
        foreach (var node in project["roots"] as JsonArray ?? new JsonArray()) if (node is not null) roots.Add(node.DeepClone());
        foreach (var node in agent["rootSkills"] as JsonArray ?? new JsonArray())
            if (node is not null && !roots.Any(existing => existing?.GetValue<string>() == node.GetValue<string>())) roots.Add(node.DeepClone());
        roots = RootsWithExplicitSkillReferences(registry, roots, task);
        var resolution = ResolveRoots(registry, roots);
        var includeContent = arguments["includeContent"]?.GetValue<bool?>() ?? true;
        var allowedSources = (agent["security"]?["allowedSourceIds"] as JsonArray ?? new JsonArray()).Select(node => node?.GetValue<string>() ?? "").ToHashSet(StringComparer.OrdinalIgnoreCase);
        var trustedOnly = agent["security"]?["trustedOnly"]?.GetValue<bool?>() ?? true;
        var permitted = new List<JsonObject>();
        foreach (var skill in resolution.Order)
        {
            var sourceId = skill["origin"]?["sourceId"]?.GetValue<string>() ?? "";
            if (trustedOnly && !string.IsNullOrWhiteSpace(sourceId) && !allowedSources.Contains(sourceId))
            {
                resolution.Conflicts.Add($"Remote skill {SkillId(skill)} is blocked by the agent trust policy.");
                continue;
            }
            permitted.Add(skill);
        }
        var taskTokens = Tokenize(task);
        var markdown = new StringBuilder($"# Agent context: {agent["name"]}\n\nProject: {project["name"]}\n\nTask: {task}\n");
        var skills = new JsonArray();
        foreach (var skill in permitted)
        {
            var relevance = Relevance(skill, taskTokens);
            skills.Add(SkillSummary(skill, SkillUri(skill), relevance));
            markdown.AppendLine().AppendLine($"## {skill["title"] ?? SkillId(skill)}").AppendLine($"URI: `{SkillUri(skill)}`").AppendLine($"Relevance: {relevance}");
            if (includeContent) markdown.AppendLine().AppendLine(skill["content"]?.GetValue<string>() ?? "");
            AppendAttachmentInstructions(markdown, skill);
        }
        var acceptedHandoff = runTask is null ? AcceptPendingHandoff(registry, project, agent, task) : AcceptLinkedHandoff(registry, project, agent, arguments["handoffId"]?.GetValue<string>(), runTask);
        AppendAudit(registry, "agent-context-resolved", agent["id"]?.GetValue<string>() ?? "", project["id"]?.GetValue<string>() ?? "",
            permitted.Select(SkillId), acceptedHandoff is null ? "direct context" : $"accepted {acceptedHandoff["id"]}",
            contextChars: permitted.Sum(skill => (skill["content"]?.GetValue<string>() ?? "").Length), success: resolution.Conflicts.Count == 0,
            task: task, requestedProvider: ProviderOf(agent), clientProvider: _clientProvider, actualProvider: _clientProvider, phase: "started",
            runId: linkedRun?["id"]?.GetValue<string>() ?? "", taskId: runTask?["id"]?.GetValue<string>() ?? "");
        SaveRegistry(registry);
        return new JsonObject
        {
            ["agent"] = AgentSummary(agent), ["project"] = ProjectSummary(project), ["task"] = task,
            ["requiredOrder"] = new JsonArray(permitted.Select(skill => (JsonNode?)SkillUri(skill)).ToArray()), ["skills"] = skills,
            ["graph"] = GraphObject(new Resolution(permitted, resolution.Edges, resolution.Conflicts)),
            ["conflicts"] = new JsonArray(resolution.Conflicts.Distinct(StringComparer.OrdinalIgnoreCase).Select(value => (JsonNode?)value).ToArray()),
            ["permissions"] = agent["permissions"]?.DeepClone() ?? new JsonObject(), ["run"] = linkedRun?.DeepClone(), ["runTask"] = runTask?.DeepClone(), ["markdown"] = markdown.ToString()
        };
    }

    private JsonObject RouteAgentTask(JsonObject arguments)
    {
        var task = RequiredString(arguments, "task");
        var registry = LoadRegistry();
        var project = FindProject(registry, arguments);
        var tokens = Tokenize(task);
        var assigned = (project["agentIds"] as JsonArray ?? new JsonArray()).Select(node => node?.GetValue<string>() ?? "").ToHashSet(StringComparer.OrdinalIgnoreCase);
        var ranked = Agents(registry).Where(agent => assigned.Contains(agent["id"]?.GetValue<string>() ?? "") && (agent["status"]?.GetValue<string>() ?? "active") == "active" && (agent["permissions"]?["read"]?.GetValue<bool?>() ?? true))
            .Select(agent =>
            {
                var roots = new JsonArray();
                foreach (var node in project["roots"] as JsonArray ?? new JsonArray()) if (node is not null) roots.Add(node.DeepClone());
                foreach (var node in agent["rootSkills"] as JsonArray ?? new JsonArray()) if (node is not null && !roots.Any(existing => existing?.GetValue<string>() == node.GetValue<string>())) roots.Add(node.DeepClone());
                var resolution = ResolveRoots(registry, roots);
                var routing = agent["routing"] as JsonObject ?? new JsonObject();
                var searchable = string.Join(' ', new[] { agent["name"]?.GetValue<string>() ?? "", agent["role"]?.GetValue<string>() ?? "", agent["description"]?.GetValue<string>() ?? "", string.Join(' ', routing["keywords"] as JsonArray ?? new JsonArray()), string.Join(' ', routing["tags"] as JsonArray ?? new JsonArray()) }).ToLowerInvariant();
                var direct = tokens.Count(token => searchable.Contains(token, StringComparison.OrdinalIgnoreCase)) * 3;
                var skillScore = resolution.Order.Sum(skill => Relevance(skill, tokens)) * 2;
                var priority = routing["priority"]?.GetValue<int?>() ?? 50;
                return new { Agent = agent, Resolution = resolution, Score = direct + skillScore + priority / 25.0, Direct = direct, SkillScore = skillScore, Fallback = routing["fallback"]?.GetValue<bool?>() ?? false };
            }).OrderByDescending(item => item.Score).ToList();
        if (ranked.Count > 0 && ranked[0].Score <= 2)
        {
            var fallback = ranked.FirstOrDefault(item => item.Fallback);
            if (fallback is not null) { ranked.Remove(fallback); ranked.Insert(0, fallback); }
        }
        var maximum = Math.Max(1, ranked.Select(item => item.Score).DefaultIfEmpty(1).Max());
        var results = new JsonArray(ranked.Select(item => (JsonNode?)new JsonObject
        {
            ["agent"] = AgentSummary(item.Agent), ["score"] = item.Score, ["confidence"] = (int)Math.Round(item.Score / maximum * 100),
            ["reasons"] = new JsonArray(new[] { item.Direct > 0 ? "role/keyword match" : null, item.SkillScore > 0 ? $"skill relevance {item.SkillScore}" : null, item.Fallback ? "fallback" : null }.Where(value => value is not null).Select(value => (JsonNode?)value).ToArray()),
            ["requiredOrder"] = new JsonArray(item.Resolution.Order.Select(skill => (JsonNode?)SkillUri(skill)).ToArray()), ["conflicts"] = new JsonArray(item.Resolution.Conflicts.Select(value => (JsonNode?)value).ToArray())
        }).ToArray());
        var best = ranked.FirstOrDefault();
        AppendAudit(registry, "task-routed", best?.Agent["id"]?.GetValue<string>() ?? "", project["id"]?.GetValue<string>() ?? "",
            best?.Resolution.Order.Select(SkillId) ?? Array.Empty<string>(), best is null ? "no candidate" : $"confidence {Math.Round(best.Score / maximum * 100)}%; recommendation only",
            success: best is not null, task: task, requestedProvider: best is null ? "" : ProviderOf(best.Agent), clientProvider: _clientProvider,
            actualProvider: "", phase: "planned");
        SaveRegistry(registry);
        return new JsonObject { ["project"] = ProjectSummary(project), ["task"] = task, ["recommendations"] = results, ["execution"] = "not-started", ["markdown"] = ranked.Count == 0 ? "No eligible project agents." : string.Join('\n', ranked.Select((item, index) => $"{index + 1}. {item.Agent["name"]} — {Math.Round(item.Score / maximum * 100)}%")) };
    }

    private JsonObject CreateAgentHandoff(JsonObject arguments)
    {
        var registry = LoadRegistry();
        var project = FindProject(registry, new JsonObject { ["projectId"] = RequiredString(arguments, "projectId") });
        var from = FindAgent(registry, RequiredString(arguments, "fromAgentId"));
        var to = FindAgent(registry, RequiredString(arguments, "toAgentId"));
        if (ReferenceEquals(from, to) || from["id"]?.GetValue<string>() == to["id"]?.GetValue<string>()) throw new McpException(-32602, "Handoff agents must be different.");
        EnsureAgentAccess(from, project, "read"); EnsureAgentAccess(to, project, "read");
        EnsureProviderAffinity(from, "create a handoff as the source agent");
        var roots = new JsonArray(); foreach (var node in from["rootSkills"] as JsonArray ?? new JsonArray()) if (node is not null) roots.Add(node.DeepClone());
        var resolution = ResolveRoots(registry, roots); var now = DateTimeOffset.UtcNow.ToString("O");
        var runId = arguments["runId"]?.GetValue<string>() ?? ""; var taskId = arguments["taskId"]?.GetValue<string>() ?? "";
        if (!string.IsNullOrWhiteSpace(taskId)) { var linkedTask = FindRunTask(registry, taskId); if (linkedTask["runId"]?.GetValue<string>() != runId) throw new McpException(-32602, "Handoff taskId does not belong to runId."); }
        var handoff = new JsonObject { ["id"] = $"handoff-{Guid.NewGuid():N}", ["projectId"] = project["id"]?.GetValue<string>(), ["fromAgentId"] = from["id"]?.GetValue<string>(), ["toAgentId"] = to["id"]?.GetValue<string>(), ["task"] = RequiredString(arguments, "task"), ["result"] = arguments["result"]?.GetValue<string>() ?? "", ["questions"] = arguments["questions"]?.GetValue<string>() ?? "", ["skillIds"] = new JsonArray(resolution.Order.Select(skill => (JsonNode?)SkillId(skill)).ToArray()), ["runId"] = runId, ["taskId"] = taskId, ["status"] = "pending", ["createdAt"] = now, ["updatedAt"] = now };
        var handoffs = registry["handoffs"] as JsonArray ?? new JsonArray(); registry["handoffs"] = handoffs; handoffs.Add(handoff);
        AppendAudit(registry, "handoff-created", from["id"]?.GetValue<string>() ?? "", project["id"]?.GetValue<string>() ?? "", resolution.Order.Select(SkillId), $"to {to["id"]}; {ProviderOf(from)} -> {ProviderOf(to)}",
            task: handoff["task"]?.GetValue<string>() ?? "", requestedProvider: ProviderOf(to), clientProvider: _clientProvider, actualProvider: "", phase: "queued");
        SaveRegistry(registry); return new JsonObject { ["created"] = true, ["handoff"] = handoff.DeepClone(), ["markdown"] = $"Handoff created: {from["name"]} -> {to["name"]}" };
    }

    private JsonObject ListAgentHandoffs(JsonObject arguments)
    {
        var registry = LoadRegistry();
        var projectId = arguments["projectId"]?.GetValue<string>();
        var agentId = arguments["agentId"]?.GetValue<string>();
        var status = arguments["status"]?.GetValue<string>();
        var limit = Math.Clamp(arguments["limit"]?.GetValue<int?>() ?? 50, 1, 500);
        var agents = Agents(registry).ToDictionary(agent => agent["id"]?.GetValue<string>() ?? "", StringComparer.OrdinalIgnoreCase);
        bool VisibleToClient(JsonObject item)
        {
            if (_clientProvider == "unknown") return true;
            var fromId = item["fromAgentId"]?.GetValue<string>() ?? "";
            var toId = item["toAgentId"]?.GetValue<string>() ?? "";
            return agents.TryGetValue(fromId, out var from) && ProviderOf(from) == _clientProvider
                || agents.TryGetValue(toId, out var to) && ProviderOf(to) == _clientProvider;
        }
        var rows = (registry["handoffs"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
            .Where(VisibleToClient)
            .Where(item => string.IsNullOrWhiteSpace(projectId) || item["projectId"]?.GetValue<string>() == projectId)
            .Where(item => string.IsNullOrWhiteSpace(agentId) || item["fromAgentId"]?.GetValue<string>() == agentId || item["toAgentId"]?.GetValue<string>() == agentId)
            .Where(item => string.IsNullOrWhiteSpace(status) || item["status"]?.GetValue<string>() == status)
            .TakeLast(limit).Reverse().ToArray();
        return new JsonObject { ["clientProvider"] = _clientProvider, ["handoffs"] = new JsonArray(rows.Select(item => item.DeepClone()).ToArray()),
            ["markdown"] = rows.Length == 0 ? $"No handoffs for {_clientProvider}." : string.Join('\n', rows.Select(item => $"- {item["status"]}: {item["fromAgentId"]} -> {item["toAgentId"]}: {item["task"]}")) };
    }

    private JsonObject ListAgentAudit(JsonObject arguments)
    {
        var registry = LoadRegistry(); var projectId = arguments["projectId"]?.GetValue<string>(); var agentId = arguments["agentId"]?.GetValue<string>(); var limit = Math.Clamp(arguments["limit"]?.GetValue<int?>() ?? 50, 1, 500);
        var events = (registry["auditLog"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Where(item => string.IsNullOrWhiteSpace(projectId) || item["projectId"]?.GetValue<string>() == projectId).Where(item => string.IsNullOrWhiteSpace(agentId) || item["agentId"]?.GetValue<string>() == agentId).TakeLast(limit).Reverse().ToArray();
        return new JsonObject { ["events"] = new JsonArray(events.Select(item => item.DeepClone()).ToArray()), ["markdown"] = events.Length == 0 ? "No audit events." : string.Join('\n', events.Select(item => $"- {item["at"]}: {item["action"]} ({item["agentId"]})")) };
    }

    private JsonObject RecordAgentOutcome(JsonObject arguments)
    {
        var registry = LoadRegistry(); var project = FindProject(registry, new JsonObject { ["projectId"] = RequiredString(arguments, "projectId") }); var agent = FindAgent(registry, RequiredString(arguments, "agentId")); EnsureAgentAccess(agent, project, "read");
        EnsureProviderAffinity(agent, "record the agent outcome");
        var completedHandoff = CompleteAcceptedHandoff(registry, project, agent, arguments["detail"]?.GetValue<string>() ?? "");
        AppendAudit(registry, "agent-outcome", agent["id"]?.GetValue<string>() ?? "", project["id"]?.GetValue<string>() ?? "", Array.Empty<string>(), arguments["detail"]?.GetValue<string>() ?? "", arguments["durationMs"]?.GetValue<int?>() ?? 0, arguments["contextChars"]?.GetValue<int?>() ?? 0, arguments["success"]?.GetValue<bool?>() ?? false,
            completedHandoff?["task"]?.GetValue<string>() ?? "", ProviderOf(agent), _clientProvider, _clientProvider, "completed", arguments["runId"]?.GetValue<string>() ?? "", arguments["taskId"]?.GetValue<string>() ?? "");
        SaveRegistry(registry); return new JsonObject { ["recorded"] = true, ["markdown"] = "Agent outcome recorded locally." };
    }

    private JsonObject ListAgentRuntimes(JsonObject arguments)
    {
        var registry = LoadRegistry();
        JsonObject runtimeState;
        using (AcquireRuntimeLock()) runtimeState = LoadRuntimeState();
        var providerFilter = arguments["provider"]?.GetValue<string>()?.Trim().ToLowerInvariant();
        var adapters = new[]
        {
            ("codex", "Codex", "MCP stdio", new[] { "read", "write", "review", "handoff", "audit" }),
            ("cursor", "Cursor", "MCP stdio", new[] { "read", "write", "review", "handoff", "audit" }),
            ("claude", "Claude", "MCP adapter", new[] { "read", "write", "review", "handoff", "audit" }),
            ("copilot", "Copilot", "MCP adapter", new[] { "read", "write", "review", "handoff", "audit" }),
            ("deepseek", "DeepSeek", "MCP stdio adapter", new[] { "read", "write", "review", "handoff", "audit" }),
            ("qwen", "Qwen", "MCP stdio adapter", new[] { "read", "write", "review", "handoff", "audit" }),
            ("local", "Local model", "local MCP adapter", new[] { "read", "write", "review", "handoff", "audit" }),
            ("custom", "Custom client", "generic MCP adapter", new[] { "read", "write", "review", "handoff", "audit" })
        };
        var rows = new JsonArray();
        foreach (var adapter in adapters.Where(item => string.IsNullOrWhiteSpace(providerFilter) || item.Item1 == providerFilter))
        {
            rows.Add(new JsonObject
            {
                ["provider"] = adapter.Item1,
                ["name"] = adapter.Item2,
                ["transport"] = adapter.Item3,
                ["capabilities"] = new JsonArray(adapter.Item4.Select(value => (JsonNode?)value).ToArray()),
                ["assignedAgents"] = Agents(registry).Count(agent => (agent["provider"]?.GetValue<string>() ?? "custom").Equals(adapter.Item1, StringComparison.OrdinalIgnoreCase)),
                ["writeRequiresAgentPermission"] = true,
                ["sessions"] = new JsonArray(RuntimeSessions(runtimeState).OfType<JsonObject>().Where(session => session["provider"]?.GetValue<string>() == adapter.Item1).Select(session => (JsonNode?)RuntimeSessionView(session)).ToArray())
            });
        }
        return new JsonObject
        {
            ["contract"] = "register_agent_runtime -> claim_agent_run_task -> resolve_agent_context -> start/progress -> complete/fail -> claim again",
            ["runtimes"] = rows,
            ["markdown"] = $"{rows.Count} provider-independent SkillGraph runtime adapters are available."
        };
    }

    private JsonObject RecordAgentEvaluation(JsonObject arguments)
    {
        var registry = LoadRegistry();
        var project = FindProject(registry, new JsonObject { ["projectId"] = RequiredString(arguments, "projectId") });
        var agent = FindAgent(registry, RequiredString(arguments, "agentId"));
        EnsureAgentAccess(agent, project, "read");
        var mode = RequiredString(arguments, "mode").Trim().ToLowerInvariant();
        if (mode is not ("baseline" or "skillgraph")) throw new McpException(-32602, "Argument 'mode' must be baseline or skillgraph.");
        var usefulness = arguments["usefulness"]?.GetValue<int?>() ?? 0;
        if (usefulness is < 1 or > 5) throw new McpException(-32602, "Argument 'usefulness' must be between 1 and 5.");
        var evaluation = new JsonObject
        {
            ["id"] = $"evaluation-{Guid.NewGuid():N}",
            ["projectId"] = project["id"]?.GetValue<string>() ?? "",
            ["agentId"] = agent["id"]?.GetValue<string>() ?? "",
            ["task"] = RequiredString(arguments, "task").Trim(),
            ["mode"] = mode,
            ["success"] = arguments["success"]?.GetValue<bool?>() ?? false,
            ["usefulness"] = usefulness,
            ["durationMs"] = Math.Max(0, arguments["durationMs"]?.GetValue<int?>() ?? 0),
            ["note"] = arguments["note"]?.GetValue<string>()?.Trim() ?? "",
            ["createdAt"] = DateTimeOffset.UtcNow.ToString("O")
        };
        var evaluations = registry["evaluations"] as JsonArray ?? new JsonArray(); registry["evaluations"] = evaluations;
        evaluations.Add(evaluation);
        while (evaluations.Count > 500) evaluations.RemoveAt(0);
        AppendAudit(registry, "agent-evaluation", evaluation["agentId"]?.GetValue<string>() ?? "", evaluation["projectId"]?.GetValue<string>() ?? "", Array.Empty<string>(), $"{mode}; usefulness {usefulness}/5", evaluation["durationMs"]?.GetValue<int>() ?? 0, 0, evaluation["success"]?.GetValue<bool>() ?? false);
        SaveRegistry(registry);
        return new JsonObject { ["recorded"] = true, ["evaluation"] = evaluation.DeepClone(), ["markdown"] = "Agent evaluation recorded locally." };
    }

    private JsonObject ListAgentEvaluations(JsonObject arguments)
    {
        var registry = LoadRegistry();
        var projectId = arguments["projectId"]?.GetValue<string>();
        var agentId = arguments["agentId"]?.GetValue<string>();
        var limit = Math.Clamp(arguments["limit"]?.GetValue<int?>() ?? 50, 1, 500);
        var source = (registry["evaluations"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
            .Where(item => string.IsNullOrWhiteSpace(projectId) || (item["projectId"]?.GetValue<string>() ?? "").Equals(projectId, StringComparison.OrdinalIgnoreCase))
            .Where(item => string.IsNullOrWhiteSpace(agentId) || (item["agentId"]?.GetValue<string>() ?? "").Equals(agentId, StringComparison.OrdinalIgnoreCase))
            .TakeLast(limit).Reverse().ToArray();
        var rows = new JsonArray(source.Select(item => (JsonNode?)item.DeepClone()).ToArray());
        JsonObject Summary(string mode)
        {
            var items = source.Where(item => (item["mode"]?.GetValue<string>() ?? "") == mode).ToArray();
            return new JsonObject
            {
                ["count"] = items.Length,
                ["successRate"] = items.Length == 0 ? 0 : Math.Round(items.Count(item => item["success"]?.GetValue<bool?>() ?? false) * 100d / items.Length, 1),
                ["averageUsefulness"] = items.Length == 0 ? 0 : Math.Round(items.Average(item => item["usefulness"]?.GetValue<int?>() ?? 0), 2)
            };
        }
        return new JsonObject { ["evaluations"] = rows, ["summary"] = new JsonObject { ["baseline"] = Summary("baseline"), ["skillgraph"] = Summary("skillgraph") }, ["markdown"] = $"{rows.Count} local agent evaluations." };
    }

    private JsonObject CreateAgentRun(JsonObject arguments) => MutateRegistry(registry =>
    {
        EnsureKnownExecutionProvider();
        var project = FindProject(registry, new JsonObject { ["projectId"] = RequiredString(arguments, "projectId") });
        var taskManager = FindAgent(registry, RequiredString(arguments, "taskManagerAgentId"));
        EnsureAgentAccess(taskManager, project, "read");
        EnsureProviderAffinity(taskManager, "create an agent run as Task Manager");
        var request = RequiredString(arguments, "request").Trim();
        var now = DateTimeOffset.UtcNow.ToString("O");
        var runId = $"run-{Guid.NewGuid():N}";
        var run = new JsonObject
        {
            ["id"] = runId, ["projectId"] = project["id"]?.GetValue<string>() ?? "", ["title"] = Bounded(RequiredString(arguments, "title"), 160),
            ["requestSummary"] = Bounded(request, 2000), ["requestHash"] = Sha256(request), ["workspacePath"] = project["location"]?.GetValue<string>() ?? "",
            ["taskManagerAgentId"] = taskManager["id"]?.GetValue<string>() ?? "", ["status"] = "planning", ["createdByProvider"] = _clientProvider,
            ["planRevision"] = 0, ["summary"] = "", ["error"] = "", ["createdAt"] = now, ["startedAt"] = now, ["updatedAt"] = now, ["finishedAt"] = null
        };
        var planningTask = new JsonObject
        {
            ["id"] = $"{runId}:planning", ["key"] = "planning", ["runId"] = runId, ["title"] = "Декомпозиция задачи",
            ["instructions"] = Bounded(request, 12000), ["agentId"] = taskManager["id"]?.GetValue<string>() ?? "", ["provider"] = ProviderOf(taskManager),
            ["dependsOn"] = new JsonArray(), ["status"] = "queued", ["priority"] = 100, ["workspaceMode"] = "read", ["capabilities"] = new JsonArray("read"),
            ["attempt"] = 0, ["maxAttempts"] = 2, ["leaseOwner"] = "", ["leaseToken"] = "", ["leaseExpiresAt"] = null,
            ["progress"] = 0, ["progressMessage"] = "Ожидает Task Manager", ["result"] = "", ["error"] = "",
            ["handoffIds"] = new JsonArray(), ["artifactIds"] = new JsonArray(), ["createdAt"] = now, ["startedAt"] = null, ["updatedAt"] = now, ["finishedAt"] = null
        };
        Runs(registry).Add(run); RunTasks(registry).Add(planningTask);
        AppendAudit(registry, "agent-run-created", taskManager["id"]?.GetValue<string>() ?? "", project["id"]?.GetValue<string>() ?? "", Array.Empty<string>(),
            $"run {runId}", task: run["title"]?.GetValue<string>() ?? "", requestedProvider: ProviderOf(taskManager), clientProvider: _clientProvider, actualProvider: "", phase: "planning");
        return new JsonObject { ["created"] = true, ["run"] = run.DeepClone(), ["planningTask"] = planningTask.DeepClone(), ["markdown"] = $"Agent run created: {run["title"]}" };
    });

    private JsonObject ListAgentRuns(JsonObject arguments)
    {
        var registry = LoadRegistry();
        var projectId = arguments["projectId"]?.GetValue<string>();
        var status = arguments["status"]?.GetValue<string>();
        var limit = Math.Clamp(arguments["limit"]?.GetValue<int?>() ?? 50, 1, 200);
        var rows = Runs(registry).OfType<JsonObject>()
            .Where(run => string.IsNullOrWhiteSpace(projectId) || run["projectId"]?.GetValue<string>() == projectId)
            .Where(run => string.IsNullOrWhiteSpace(status) || run["status"]?.GetValue<string>() == status)
            .TakeLast(limit).Reverse().Select(run => (JsonNode?)RunWithProgress(registry, run)).ToArray();
        return new JsonObject { ["runs"] = new JsonArray(rows), ["markdown"] = $"{rows.Length} agent runs." };
    }

    private JsonObject GetAgentRun(JsonObject arguments)
    {
        var registry = LoadRegistry();
        var run = FindRun(registry, RequiredString(arguments, "runId"));
        return RunDetails(registry, run);
    }

    private JsonObject SubmitAgentRunPlan(JsonObject arguments) => MutateRegistry(registry =>
    {
        EnsureKnownExecutionProvider();
        var run = FindRun(registry, RequiredString(arguments, "runId"));
        if ((run["status"]?.GetValue<string>() ?? "") is "cancelled" or "completed") throw new McpException(-32005, "A terminal run cannot receive a plan.");
        var project = FindProject(registry, new JsonObject { ["projectId"] = run["projectId"]?.GetValue<string>() ?? "" });
        var taskManager = FindAgent(registry, run["taskManagerAgentId"]?.GetValue<string>() ?? "");
        EnsureAgentAccess(taskManager, project, "read"); EnsureProviderAffinity(taskManager, "submit the agent run plan");
        var revision = arguments["planRevision"]?.GetValue<int?>() ?? 0;
        var expected = (run["planRevision"]?.GetValue<int?>() ?? 0) + 1;
        if (revision != expected) throw new McpException(-32602, $"planRevision must be {expected}.");
        var proposed = arguments["tasks"] as JsonArray ?? throw new McpException(-32602, "Argument 'tasks' must be an array.");
        if (proposed.Count is < 1 or > 100) throw new McpException(-32602, "A plan must contain between 1 and 100 tasks.");

        var assigned = (project["agentIds"] as JsonArray ?? new JsonArray()).Select(node => node?.GetValue<string>() ?? "").ToHashSet(StringComparer.OrdinalIgnoreCase);
        var definitions = new Dictionary<string, JsonObject>(StringComparer.OrdinalIgnoreCase);
        foreach (var node in proposed)
        {
            if (node is not JsonObject item) throw new McpException(-32602, "Every plan task must be an object.");
            var key = RequiredString(item, "id").Trim();
            if (!Regex.IsMatch(key, "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")) throw new McpException(-32602, $"Invalid task id: {key}");
            if (!definitions.TryAdd(key, item)) throw new McpException(-32602, $"Duplicate task id: {key}");
            var agent = FindAgent(registry, RequiredString(item, "agentId"));
            var agentId = agent["id"]?.GetValue<string>() ?? "";
            if (!assigned.Contains(agentId)) throw new McpException(-32003, $"Agent {agentId} is not assigned to the run project.");
            EnsureAgentAccess(agent, project, "read");
            var requestedMode = item["workspaceMode"]?.GetValue<string>() ?? "read";
            if (requestedMode is not ("read" or "review" or "project-write")) throw new McpException(-32602, $"Invalid workspaceMode for {key}.");
            if (requestedMode == "project-write" && !(agent["permissions"]?["edit"]?.GetValue<bool?>() ?? agent["permissions"]?["create"]?.GetValue<bool?>() ?? false))
                throw new McpException(-32003, $"Agent {agentId} cannot receive project-write work.");
        }
        ValidatePlanDag(definitions);

        var now = DateTimeOffset.UtcNow.ToString("O");
        var idPrefix = revision == 1 ? $"{run["id"]}:" : $"{run["id"]}:r{revision}:";
        var newTasks = new List<JsonObject>();
        foreach (var pair in definitions)
        {
            var item = pair.Value; var agent = FindAgent(registry, item["agentId"]?.GetValue<string>() ?? "");
            var dependencies = (item["dependsOn"] as JsonArray ?? new JsonArray()).Select(dep => dep?.GetValue<string>() ?? "").Where(value => value.Length > 0).ToArray();
            var task = new JsonObject
            {
                ["id"] = $"{idPrefix}{pair.Key}", ["key"] = pair.Key, ["runId"] = run["id"]?.GetValue<string>() ?? "", ["title"] = Bounded(RequiredString(item, "title"), 200),
                ["instructions"] = Bounded(RequiredString(item, "instructions"), 12000), ["agentId"] = agent["id"]?.GetValue<string>() ?? "", ["provider"] = ProviderOf(agent),
                ["dependsOn"] = new JsonArray(dependencies.Select(dep => (JsonNode?)$"{idPrefix}{dep}").ToArray()), ["status"] = dependencies.Length == 0 ? "queued" : "blocked",
                ["priority"] = Math.Clamp(item["priority"]?.GetValue<int?>() ?? 50, 0, 100), ["workspaceMode"] = item["workspaceMode"]?.GetValue<string>() ?? "read",
                ["capabilities"] = item["capabilities"]?.DeepClone() ?? new JsonArray("read"), ["attempt"] = 0, ["maxAttempts"] = Math.Clamp(item["maxAttempts"]?.GetValue<int?>() ?? 2, 1, 5),
                ["leaseOwner"] = "", ["leaseToken"] = "", ["leaseExpiresAt"] = null, ["progress"] = 0, ["progressMessage"] = "",
                ["result"] = "", ["error"] = "", ["handoffIds"] = new JsonArray(), ["artifactIds"] = new JsonArray(),
                ["createdAt"] = now, ["startedAt"] = null, ["updatedAt"] = now, ["finishedAt"] = null
            };
            newTasks.Add(task);
        }
        var dependedKeys = definitions.Values.SelectMany(item => (item["dependsOn"] as JsonArray ?? new JsonArray()).Select(dep => dep?.GetValue<string>() ?? "")).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var leafIds = definitions.Keys.Where(key => !dependedKeys.Contains(key)).Select(key => (JsonNode?)$"{idPrefix}{key}").ToArray();
        newTasks.Add(new JsonObject
        {
            ["id"] = $"{idPrefix}final-summary", ["key"] = "__final-summary", ["runId"] = run["id"]?.GetValue<string>() ?? "", ["title"] = "Свести результаты цепочки",
            ["instructions"] = "Проверь результаты исполнителей, артефакты и ошибки. Запиши краткую итоговую сводку запуска.",
            ["agentId"] = taskManager["id"]?.GetValue<string>() ?? "", ["provider"] = ProviderOf(taskManager), ["dependsOn"] = new JsonArray(leafIds),
            ["status"] = "blocked", ["priority"] = 90, ["workspaceMode"] = "read", ["capabilities"] = new JsonArray("read"),
            ["attempt"] = 0, ["maxAttempts"] = 2, ["leaseOwner"] = "", ["leaseToken"] = "", ["leaseExpiresAt"] = null,
            ["progress"] = 0, ["progressMessage"] = "Ожидает результатов исполнителей", ["result"] = "", ["error"] = "",
            ["handoffIds"] = new JsonArray(), ["artifactIds"] = new JsonArray(), ["createdAt"] = now, ["startedAt"] = null, ["updatedAt"] = now, ["finishedAt"] = null
        });
        var existing = RunTasks(registry).OfType<JsonObject>().Where(task => task["runId"]?.GetValue<string>() == run["id"]?.GetValue<string>() && task["key"]?.GetValue<string>() != "planning").ToArray();
        foreach (var task in existing)
        {
            task["supersededAt"] = now; task["supersededByRevision"] = revision; task["updatedAt"] = now;
            if ((task["status"]?.GetValue<string>() ?? "") is not ("completed" or "failed" or "cancelled"))
            {
                task["status"] = "cancelled"; task["leaseOwner"] = ""; task["leaseToken"] = ""; task["leaseExpiresAt"] = null; task["finishedAt"] = now;
            }
        }
        foreach (var task in newTasks) RunTasks(registry).Add(task);
        var planning = RunTasks(registry).OfType<JsonObject>().FirstOrDefault(task => task["runId"]?.GetValue<string>() == run["id"]?.GetValue<string>() && task["key"]?.GetValue<string>() == "planning");
        if (planning is not null) { planning["status"] = "completed"; planning["progress"] = 100; planning["progressMessage"] = "План принят"; planning["finishedAt"] = now; planning["updatedAt"] = now; }
        run["planRevision"] = revision; run["status"] = "running"; run["updatedAt"] = now;
        AppendAudit(registry, "agent-run-plan-submitted", taskManager["id"]?.GetValue<string>() ?? "", project["id"]?.GetValue<string>() ?? "", Array.Empty<string>(),
            $"run {run["id"]}; revision {revision}; {newTasks.Count} tasks", requestedProvider: ProviderOf(taskManager), clientProvider: _clientProvider, actualProvider: _clientProvider, phase: "planned");
        return RunDetails(registry, run);
    });

    private JsonObject PauseAgentRun(JsonObject arguments) => ChangeRunLifecycle(arguments, "paused");

    private JsonObject ResumeAgentRun(JsonObject arguments) => MutateRegistry(registry =>
    {
        var run = FindRun(registry, RequiredString(arguments, "runId"));
        if (run["status"]?.GetValue<string>() != "paused") throw new McpException(-32005, "Only a paused run can be resumed.");
        RecomputeReadyTasks(registry, run);
        run["status"] = TasksForRun(registry, run).Any(task => task["status"]?.GetValue<string>() == "queued") ? "running" : "waiting";
        run["updatedAt"] = DateTimeOffset.UtcNow.ToString("O");
        var manager = FindAgent(registry, run["taskManagerAgentId"]?.GetValue<string>() ?? ""); EnsureProviderAffinity(manager, "resume an agent run");
        AppendAudit(registry, "agent-run-resumed", manager["id"]?.GetValue<string>() ?? "", run["projectId"]?.GetValue<string>() ?? "", Array.Empty<string>(),
            $"run {run["id"]}", requestedProvider: ProviderOf(manager), clientProvider: _clientProvider, actualProvider: _clientProvider, phase: run["status"]?.GetValue<string>() ?? "running", runId: run["id"]?.GetValue<string>() ?? "");
        return RunDetails(registry, run);
    });

    private JsonObject CancelAgentRun(JsonObject arguments) => MutateRegistry(registry =>
    {
        var run = FindRun(registry, RequiredString(arguments, "runId"));
        var now = DateTimeOffset.UtcNow.ToString("O");
        foreach (var task in TasksForRun(registry, run).Where(task => (task["status"]?.GetValue<string>() ?? "") is not ("completed" or "cancelled")))
        {
            task["status"] = "cancelled"; task["leaseToken"] = ""; task["leaseOwner"] = ""; task["leaseExpiresAt"] = null; task["updatedAt"] = now; task["finishedAt"] = now;
        }
        run["status"] = "cancelled"; run["updatedAt"] = now; run["finishedAt"] = now;
        var manager = FindAgent(registry, run["taskManagerAgentId"]?.GetValue<string>() ?? ""); EnsureProviderAffinity(manager, "cancel an agent run");
        AppendAudit(registry, "agent-run-cancelled", manager["id"]?.GetValue<string>() ?? "", run["projectId"]?.GetValue<string>() ?? "", Array.Empty<string>(),
            $"run {run["id"]}", requestedProvider: ProviderOf(manager), clientProvider: _clientProvider, actualProvider: _clientProvider, phase: "cancelled", runId: run["id"]?.GetValue<string>() ?? "");
        return RunDetails(registry, run);
    });

    private JsonObject DeleteAgentRun(JsonObject arguments) => MutateRegistry(registry =>
    {
        var run = FindRun(registry, RequiredString(arguments, "runId"));
        var status = run["status"]?.GetValue<string>() ?? "";
        if (status is not ("completed" or "failed" or "cancelled"))
            throw new McpException(-32005, "Only a completed, failed, or cancelled run can be deleted.");

        var manager = FindAgent(registry, run["taskManagerAgentId"]?.GetValue<string>() ?? "");
        EnsureProviderAffinity(manager, "delete an agent run");
        var runId = run["id"]?.GetValue<string>() ?? "";
        var projectId = run["projectId"]?.GetValue<string>() ?? "";
        var title = run["title"]?.GetValue<string>() ?? runId;
        var removedTasks = RemoveWhere(RunTasks(registry), item => item["runId"]?.GetValue<string>() == runId);
        var removedArtifacts = RemoveWhere(RunArtifacts(registry), item => item["runId"]?.GetValue<string>() == runId);
        var handoffs = registry["handoffs"] as JsonArray ?? new JsonArray();
        registry["handoffs"] = handoffs;
        var removedHandoffs = RemoveWhere(handoffs, item => item["runId"]?.GetValue<string>() == runId);
        var audit = registry["auditLog"] as JsonArray ?? new JsonArray();
        registry["auditLog"] = audit;
        RemoveWhere(audit, item => item["runId"]?.GetValue<string>() == runId);
        RemoveWhere(Runs(registry), item => item["id"]?.GetValue<string>() == runId);
        AppendAudit(registry, "agent-run-deleted", manager["id"]?.GetValue<string>() ?? "", projectId, Array.Empty<string>(),
            $"deleted terminal run {title}; {removedTasks} tasks; {removedArtifacts} artifacts; {removedHandoffs} handoffs",
            requestedProvider: ProviderOf(manager), clientProvider: _clientProvider, actualProvider: _clientProvider, phase: "deleted");
        return new JsonObject
        {
            ["deleted"] = true, ["runId"] = runId, ["tasks"] = removedTasks,
            ["artifacts"] = removedArtifacts, ["handoffs"] = removedHandoffs,
            ["markdown"] = $"Agent run deleted: {title}"
        };
    });

    private JsonObject RegisterAgentRuntime(JsonObject arguments)
    {
        EnsureKnownExecutionProvider();
        var capabilities = (arguments["capabilities"] as JsonArray ?? new JsonArray()).Select(node => node?.GetValue<string>()?.Trim().ToLowerInvariant() ?? "").Where(value => value.Length > 0).Distinct().Take(20).ToArray();
        if (capabilities.Length == 0) throw new McpException(-32602, "At least one runtime capability is required.");
        var now = DateTimeOffset.UtcNow;
        return MutateRuntimeState(state =>
        {
            var session = new JsonObject
            {
                ["id"] = $"runtime-{Guid.NewGuid():N}", ["provider"] = _clientProvider, ["clientName"] = Bounded(RequiredString(arguments, "clientName"), 120),
                ["status"] = "online", ["capabilities"] = new JsonArray(capabilities.Select(value => (JsonNode?)value).ToArray()),
                ["connectedAt"] = now.ToString("O"), ["lastSeenAt"] = now.ToString("O"), ["maxParallelTasks"] = Math.Clamp(arguments["maxParallelTasks"]?.GetValue<int?>() ?? 1, 1, 8),
                ["activeTaskIds"] = new JsonArray()
            };
            RuntimeSessions(state).Add(session);
            return new JsonObject { ["session"] = session.DeepClone(), ["markdown"] = $"{_clientProvider} worker mode activated." };
        });
    }

    private JsonObject HeartbeatAgentRuntime(JsonObject arguments)
    {
        EnsureKnownExecutionProvider();
        return MutateRuntimeState(state =>
        {
            var session = FindRuntimeSession(state, RequiredString(arguments, "sessionId")); EnsureRuntimeProvider(session);
            session["lastSeenAt"] = DateTimeOffset.UtcNow.ToString("O"); session["status"] = "online";
            session["activeTaskIds"] = arguments["activeTaskIds"]?.DeepClone() ?? new JsonArray();
            return new JsonObject { ["session"] = RuntimeSessionView(session), ["markdown"] = "Runtime heartbeat recorded." };
        });
    }

    private JsonObject ClaimAgentRunTask(JsonObject arguments)
    {
        EnsureKnownExecutionProvider();
        var session = ReadRuntimeSession(RequiredString(arguments, "sessionId")); EnsureRuntimeProvider(session);
        if (RuntimeSessionIsStale(session)) throw new McpException(-32006, "Runtime session is stale; send a heartbeat or register again.");
        var sessionId = session["id"]?.GetValue<string>() ?? "";
        var maxParallel = Math.Clamp(session["maxParallelTasks"]?.GetValue<int?>() ?? 1, 1, 8);
        var capabilities = (session["capabilities"] as JsonArray ?? new JsonArray()).Select(node => node?.GetValue<string>() ?? "").ToHashSet(StringComparer.OrdinalIgnoreCase);
        return MutateRegistry(registry =>
        {
            ExpireStaleTaskLeases(registry);
            var activeCount = RunTasks(registry).OfType<JsonObject>().Count(task => task["leaseOwner"]?.GetValue<string>() == sessionId && (task["status"]?.GetValue<string>() ?? "") is "claimed" or "running");
            if (activeCount >= maxParallel) return new JsonObject { ["task"] = null, ["reason"] = "capacity", ["markdown"] = "Runtime capacity is full." };
            var candidates = RunTasks(registry).OfType<JsonObject>()
                .Where(task => task["status"]?.GetValue<string>() == "queued" && task["provider"]?.GetValue<string>() == _clientProvider)
                .Where(task => TaskCapabilities(task).All(capabilities.Contains))
                .Where(task =>
                {
                    var run = FindRun(registry, task["runId"]?.GetValue<string>() ?? "");
                    return (run["status"]?.GetValue<string>() ?? "") is "planning" or "running" or "waiting";
                })
                .OrderByDescending(task => task["priority"]?.GetValue<int?>() ?? 0).ThenBy(task => task["createdAt"]?.GetValue<string>() ?? "")
                .ToArray();
            var selected = candidates.FirstOrDefault(task => task["workspaceMode"]?.GetValue<string>() != "project-write" || !HasActiveProjectWriter(registry, task));
            if (selected is null) return new JsonObject { ["task"] = null, ["reason"] = candidates.Length == 0 ? "empty" : "project-write-locked", ["markdown"] = "No claimable task for this provider." };
            var now = DateTimeOffset.UtcNow; var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
            selected["status"] = "claimed"; selected["leaseOwner"] = sessionId; selected["leaseToken"] = token; selected["leaseExpiresAt"] = now.AddMinutes(10).ToString("O");
            selected["attempt"] = (selected["attempt"]?.GetValue<int?>() ?? 0) + 1; selected["updatedAt"] = now.ToString("O"); selected["progressMessage"] = $"Назначено {session["clientName"]}";
            var run = FindRun(registry, selected["runId"]?.GetValue<string>() ?? ""); if (run["status"]?.GetValue<string>() == "waiting") run["status"] = "running";
            AppendRunAudit(registry, "run-task-claimed", selected, $"runtime {sessionId}", "claimed");
            return new JsonObject { ["task"] = selected.DeepClone(), ["leaseToken"] = token, ["leaseExpiresAt"] = selected["leaseExpiresAt"]?.DeepClone(), ["markdown"] = $"Claimed {selected["title"]}" };
        });
    }

    private JsonObject StartAgentRunTask(JsonObject arguments) => MutateRegistry(registry =>
    {
        var task = FindRunTask(registry, RequiredString(arguments, "taskId")); ValidateTaskLease(task, RequiredString(arguments, "leaseToken"), "claimed");
        var now = DateTimeOffset.UtcNow.ToString("O"); task["status"] = "running"; task["startedAt"] ??= now; task["updatedAt"] = now; task["progressMessage"] = "Выполняется";
        AppendRunAudit(registry, "run-task-started", task, "worker started task", "running");
        return new JsonObject { ["task"] = task.DeepClone(), ["markdown"] = $"Started {task["title"]}" };
    });

    private JsonObject RecordAgentRunProgress(JsonObject arguments) => MutateRegistry(registry =>
    {
        var task = FindRunTask(registry, RequiredString(arguments, "taskId")); ValidateTaskLease(task, RequiredString(arguments, "leaseToken"), "running");
        task["progress"] = Math.Clamp(arguments["progress"]?.GetValue<int?>() ?? 0, 0, 99); task["progressMessage"] = Bounded(arguments["message"]?.GetValue<string>() ?? "", 500); task["updatedAt"] = DateTimeOffset.UtcNow.ToString("O");
        AppendRunAudit(registry, "run-task-progress", task, task["progressMessage"]?.GetValue<string>() ?? "", "running");
        return new JsonObject { ["task"] = task.DeepClone(), ["markdown"] = $"Progress {task["progress"]}%" };
    });

    private JsonObject CompleteAgentRunTask(JsonObject arguments) => MutateRegistry(registry =>
    {
        var task = FindRunTask(registry, RequiredString(arguments, "taskId"));
        var run = FindRun(registry, task["runId"]?.GetValue<string>() ?? "");
        var token = RequiredString(arguments, "leaseToken");
        if (task["status"]?.GetValue<string>() == "completed" && string.IsNullOrWhiteSpace(task["leaseToken"]?.GetValue<string>()))
            return new JsonObject { ["orphaned"] = false, ["idempotent"] = true, ["task"] = task.DeepClone(), ["run"] = RunWithProgress(registry, run), ["markdown"] = $"Already completed {task["title"]}" };
        if ((run["status"]?.GetValue<string>() ?? "") is "cancelled" or "completed" || task["status"]?.GetValue<string>() == "cancelled" || task["leaseToken"]?.GetValue<string>() != token)
        {
            AppendRunAudit(registry, "run-task-orphaned-completion", task, "late or invalid completion preserved for audit", "orphaned");
            return new JsonObject { ["orphaned"] = true, ["task"] = task.DeepClone(), ["markdown"] = "Late completion recorded as orphaned." };
        }
        ValidateTaskLease(task, token, "running", "claimed");
        var project = FindProject(registry, new JsonObject { ["projectId"] = run["projectId"]?.GetValue<string>() ?? "" });
        var artifacts = arguments["artifacts"] as JsonArray ?? new JsonArray();
        if (artifacts.Count > 100) throw new McpException(-32602, "A task may report at most 100 artifacts.");
        foreach (var node in artifacts)
        {
            if (node is not JsonObject source) throw new McpException(-32602, "Artifact entries must be objects.");
            var path = Path.GetFullPath(Environment.ExpandEnvironmentVariables(RequiredString(source, "path")));
            var normalizedArtifact = NormalizePath(path); var normalizedProject = NormalizePath(project["location"]?.GetValue<string>());
            if (!IsInside(normalizedArtifact, normalizedProject)) throw new McpException(-32003, "Artifact path is outside the project workspace.");
            var artifact = new JsonObject { ["id"] = $"artifact-{Guid.NewGuid():N}", ["runId"] = run["id"]?.GetValue<string>() ?? "", ["taskId"] = task["id"]?.GetValue<string>() ?? "", ["path"] = path,
                ["kind"] = Bounded(source["kind"]?.GetValue<string>() ?? "file", 40), ["operation"] = Bounded(source["operation"]?.GetValue<string>() ?? "modified", 40), ["hash"] = Bounded(source["hash"]?.GetValue<string>() ?? "", 160), ["createdAt"] = DateTimeOffset.UtcNow.ToString("O") };
            RunArtifacts(registry).Add(artifact); (task["artifactIds"] as JsonArray ?? new JsonArray()).Add((JsonNode?)(artifact["id"]?.GetValue<string>() ?? ""));
        }
        var now = DateTimeOffset.UtcNow.ToString("O"); task["status"] = "completed"; task["progress"] = 100; task["progressMessage"] = "Завершено"; task["result"] = Bounded(RequiredString(arguments, "result"), 12000);
        task["leaseOwner"] = ""; task["leaseToken"] = ""; task["leaseExpiresAt"] = null; task["updatedAt"] = now; task["finishedAt"] = now;
        if (task["key"]?.GetValue<string>() == "__final-summary") run["summary"] = task["result"]?.GetValue<string>() ?? "";
        RecomputeReadyTasks(registry, run); UpdateRunStatus(registry, run); AppendRunAudit(registry, "run-task-completed", task, task["result"]?.GetValue<string>() ?? "", "completed");
        return new JsonObject { ["orphaned"] = false, ["task"] = task.DeepClone(), ["run"] = RunWithProgress(registry, run), ["markdown"] = $"Completed {task["title"]}" };
    });

    private JsonObject FailAgentRunTask(JsonObject arguments) => MutateRegistry(registry =>
    {
        var task = FindRunTask(registry, RequiredString(arguments, "taskId")); ValidateTaskLease(task, RequiredString(arguments, "leaseToken"), "running", "claimed");
        var retryable = arguments["retryable"]?.GetValue<bool?>() ?? false; var attempt = task["attempt"]?.GetValue<int?>() ?? 0; var maxAttempts = task["maxAttempts"]?.GetValue<int?>() ?? 1;
        task["error"] = Bounded(RequiredString(arguments, "error"), 4000); task["leaseOwner"] = ""; task["leaseToken"] = ""; task["leaseExpiresAt"] = null; task["updatedAt"] = DateTimeOffset.UtcNow.ToString("O");
        task["status"] = retryable && attempt < maxAttempts ? "queued" : "failed"; task["progressMessage"] = task["status"]?.GetValue<string>() == "queued" ? "Ожидает повторной попытки" : "Ошибка";
        var run = FindRun(registry, task["runId"]?.GetValue<string>() ?? ""); UpdateRunStatus(registry, run); AppendRunAudit(registry, "run-task-failed", task, task["error"]?.GetValue<string>() ?? "", task["status"]?.GetValue<string>() ?? "failed", false);
        return new JsonObject { ["task"] = task.DeepClone(), ["run"] = RunWithProgress(registry, run), ["markdown"] = $"Task {task["status"]}" };
    });

    private JsonObject RetryAgentRunTask(JsonObject arguments) => MutateRegistry(registry =>
    {
        var task = FindRunTask(registry, RequiredString(arguments, "taskId")); var run = FindRun(registry, task["runId"]?.GetValue<string>() ?? "");
        var manager = FindAgent(registry, run["taskManagerAgentId"]?.GetValue<string>() ?? ""); EnsureProviderAffinity(manager, "retry a run task");
        if (task["status"]?.GetValue<string>() != "failed") throw new McpException(-32005, "Only a failed task can be retried manually.");
        if ((task["attempt"]?.GetValue<int?>() ?? 0) >= (task["maxAttempts"]?.GetValue<int?>() ?? 1)) throw new McpException(-32005, "The task has no retry attempts left.");
        task["status"] = "queued"; task["error"] = ""; task["progressMessage"] = "Ожидает повторной попытки"; task["updatedAt"] = DateTimeOffset.UtcNow.ToString("O");
        run["status"] = "running"; run["updatedAt"] = task["updatedAt"]?.DeepClone();
        AppendRunAudit(registry, "run-task-retried", task, "manual retry requested by Task Manager", "queued");
        return new JsonObject { ["task"] = task.DeepClone(), ["run"] = RunWithProgress(registry, run), ["markdown"] = $"Retry queued {task["title"]}" };
    });

    private JsonObject ReassignAgentRunTask(JsonObject arguments) => MutateRegistry(registry =>
    {
        var task = FindRunTask(registry, RequiredString(arguments, "taskId")); var run = FindRun(registry, task["runId"]?.GetValue<string>() ?? "");
        var manager = FindAgent(registry, run["taskManagerAgentId"]?.GetValue<string>() ?? ""); EnsureProviderAffinity(manager, "reassign a run task");
        if ((task["status"]?.GetValue<string>() ?? "") is not ("queued" or "blocked" or "failed")) throw new McpException(-32005, "Only an unleased queued, blocked, or failed task can be reassigned.");
        var project = FindProject(registry, new JsonObject { ["projectId"] = run["projectId"]?.GetValue<string>() ?? "" }); var agent = FindAgent(registry, RequiredString(arguments, "agentId"));
        var assigned = (project["agentIds"] as JsonArray ?? new JsonArray()).Select(node => node?.GetValue<string>() ?? "").ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (!assigned.Contains(agent["id"]?.GetValue<string>() ?? "")) throw new McpException(-32003, "Replacement agent is not assigned to the run project.");
        EnsureAgentAccess(agent, project, "read");
        if (task["workspaceMode"]?.GetValue<string>() == "project-write" && !(agent["permissions"]?["edit"]?.GetValue<bool?>() ?? agent["permissions"]?["create"]?.GetValue<bool?>() ?? false))
            throw new McpException(-32003, "Replacement agent cannot receive project-write work.");
        task["agentId"] = agent["id"]?.GetValue<string>() ?? ""; task["provider"] = ProviderOf(agent); task["updatedAt"] = DateTimeOffset.UtcNow.ToString("O");
        AppendRunAudit(registry, "run-task-reassigned", task, $"assigned to {task["agentId"]}", task["status"]?.GetValue<string>() ?? "queued");
        return new JsonObject { ["task"] = task.DeepClone(), ["run"] = RunWithProgress(registry, run), ["markdown"] = $"Reassigned {task["title"]}" };
    });

    private JsonObject ChangeRunLifecycle(JsonObject arguments, string status) => MutateRegistry(registry =>
    {
        var run = FindRun(registry, RequiredString(arguments, "runId"));
        if ((run["status"]?.GetValue<string>() ?? "") is "completed" or "cancelled") throw new McpException(-32005, "A terminal run cannot change lifecycle state.");
        run["status"] = status; run["updatedAt"] = DateTimeOffset.UtcNow.ToString("O");
        var manager = FindAgent(registry, run["taskManagerAgentId"]?.GetValue<string>() ?? ""); EnsureProviderAffinity(manager, $"set agent run status to {status}");
        AppendAudit(registry, $"agent-run-{status}", manager["id"]?.GetValue<string>() ?? "", run["projectId"]?.GetValue<string>() ?? "", Array.Empty<string>(),
            $"run {run["id"]}", requestedProvider: ProviderOf(manager), clientProvider: _clientProvider, actualProvider: _clientProvider, phase: status, runId: run["id"]?.GetValue<string>() ?? "");
        return RunDetails(registry, run);
    });

    private JsonObject MutateRuntimeState(Func<JsonObject, JsonObject> mutation)
    {
        using var runtimeLock = AcquireRuntimeLock();
        var state = LoadRuntimeState(); var result = mutation(state); SaveRuntimeStateUnlocked(state); return result;
    }

    private JsonObject ReadRuntimeSession(string sessionId)
    {
        using var runtimeLock = AcquireRuntimeLock(); return FindRuntimeSession(LoadRuntimeState(), sessionId).DeepClone() as JsonObject ?? new JsonObject();
    }

    private FileStream AcquireRuntimeLock()
    {
        var path = RuntimeStatePath + ".lock"; Directory.CreateDirectory(Path.GetDirectoryName(path)!); var deadline = DateTime.UtcNow.AddSeconds(8);
        while (true) { try { return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); } catch (IOException) when (DateTime.UtcNow < deadline) { Thread.Sleep(50); } }
    }

    private string RuntimeStatePath => Path.Combine(Path.GetDirectoryName(_registryPath)!, "runtime-state.json");

    private JsonObject LoadRuntimeState()
    {
        if (!File.Exists(RuntimeStatePath)) return new JsonObject { ["schema"] = "skillgraph/runtime-v1", ["sessions"] = new JsonArray(), ["updatedAt"] = DateTimeOffset.UtcNow.ToString("O") };
        try
        {
            var state = JsonNode.Parse(File.ReadAllText(RuntimeStatePath, Encoding.UTF8)) as JsonObject ?? new JsonObject();
            state["schema"] ??= "skillgraph/runtime-v1"; if (state["sessions"] is not JsonArray) state["sessions"] = new JsonArray(); return state;
        }
        catch (JsonException error) { throw new McpException(-32002, $"SkillGraph runtime state is invalid JSON: {error.Message}"); }
    }

    private void SaveRuntimeStateUnlocked(JsonObject state)
    {
        state["updatedAt"] = DateTimeOffset.UtcNow.ToString("O"); Directory.CreateDirectory(Path.GetDirectoryName(RuntimeStatePath)!);
        var temporary = $"{RuntimeStatePath}.{Environment.ProcessId}.{Guid.NewGuid():N}.tmp";
        File.WriteAllText(temporary, state.ToJsonString(new JsonSerializerOptions { WriteIndented = true }), new UTF8Encoding(false)); File.Move(temporary, RuntimeStatePath, true);
    }

    private static JsonArray RuntimeSessions(JsonObject state) => state["sessions"] as JsonArray ?? throw new McpException(-32002, "Runtime sessions collection is missing.");
    private static JsonObject FindRuntimeSession(JsonObject state, string sessionId) => RuntimeSessions(state).OfType<JsonObject>().FirstOrDefault(session => session["id"]?.GetValue<string>() == sessionId)
        ?? throw new McpException(-32602, $"Runtime session not found: {sessionId}");

    private void EnsureRuntimeProvider(JsonObject session)
    {
        var provider = session["provider"]?.GetValue<string>() ?? "unknown";
        if (!provider.Equals(_clientProvider, StringComparison.OrdinalIgnoreCase)) throw new McpException(-32004, $"Runtime session belongs to {provider}, not {_clientProvider}.");
    }

    private static bool RuntimeSessionIsStale(JsonObject session)
    {
        return !DateTimeOffset.TryParse(session["lastSeenAt"]?.GetValue<string>(), out var lastSeen) || DateTimeOffset.UtcNow - lastSeen > TimeSpan.FromMinutes(2);
    }

    private static JsonObject RuntimeSessionView(JsonObject session)
    {
        var clone = session.DeepClone() as JsonObject ?? new JsonObject(); clone["status"] = RuntimeSessionIsStale(session) ? "offline" : "online"; return clone;
    }

    private static JsonObject FindRunTask(JsonObject registry, string taskId) => RunTasks(registry).OfType<JsonObject>().FirstOrDefault(task => task["id"]?.GetValue<string>() == taskId)
        ?? throw new McpException(-32602, $"Run task not found: {taskId}");

    private void ValidateTaskLease(JsonObject task, string token, params string[] allowedStatuses)
    {
        EnsureKnownExecutionProvider();
        if (task["provider"]?.GetValue<string>() != _clientProvider) throw new McpException(-32004, $"Task belongs to {task["provider"]}, not {_clientProvider}.");
        if (!allowedStatuses.Contains(task["status"]?.GetValue<string>() ?? "")) throw new McpException(-32005, $"Task status is {task["status"]}; expected {string.Join(" or ", allowedStatuses)}.");
        if (task["leaseToken"]?.GetValue<string>() != token) throw new McpException(-32006, "Lease token is invalid.");
        if (!DateTimeOffset.TryParse(task["leaseExpiresAt"]?.GetValue<string>(), out var expiry) || expiry <= DateTimeOffset.UtcNow) throw new McpException(-32006, "Task lease has expired.");
    }

    private static IEnumerable<string> TaskCapabilities(JsonObject task) => (task["capabilities"] as JsonArray ?? new JsonArray()).Select(node => node?.GetValue<string>() ?? "").Where(value => value.Length > 0);

    private static bool HasActiveProjectWriter(JsonObject registry, JsonObject candidate)
    {
        var candidateRun = FindRun(registry, candidate["runId"]?.GetValue<string>() ?? ""); var projectId = candidateRun["projectId"]?.GetValue<string>() ?? "";
        var runProject = Runs(registry).OfType<JsonObject>().ToDictionary(run => run["id"]?.GetValue<string>() ?? "", run => run["projectId"]?.GetValue<string>() ?? "", StringComparer.OrdinalIgnoreCase);
        return RunTasks(registry).OfType<JsonObject>().Any(task => task["id"]?.GetValue<string>() != candidate["id"]?.GetValue<string>() && task["workspaceMode"]?.GetValue<string>() == "project-write"
            && (task["status"]?.GetValue<string>() ?? "") is "claimed" or "running" && runProject.TryGetValue(task["runId"]?.GetValue<string>() ?? "", out var otherProject) && otherProject == projectId);
    }

    private static void ExpireStaleTaskLeases(JsonObject registry)
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var task in RunTasks(registry).OfType<JsonObject>().Where(task => (task["status"]?.GetValue<string>() ?? "") is "claimed" or "running").ToArray())
        {
            if (DateTimeOffset.TryParse(task["leaseExpiresAt"]?.GetValue<string>(), out var expiry) && expiry > now) continue;
            var run = FindRun(registry, task["runId"]?.GetValue<string>() ?? "");
            if ((run["status"]?.GetValue<string>() ?? "") is "cancelled" or "completed") continue;
            task["status"] = "queued"; task["leaseOwner"] = ""; task["leaseToken"] = ""; task["leaseExpiresAt"] = null; task["progressMessage"] = "Lease истёк; ожидает повторного запуска"; task["updatedAt"] = now.ToString("O");
        }
    }

    private static void UpdateRunStatus(JsonObject registry, JsonObject run)
    {
        var tasks = ActiveTasksForRun(registry, run).ToArray(); var now = DateTimeOffset.UtcNow.ToString("O");
        if (tasks.Length > 0 && tasks.All(task => task["status"]?.GetValue<string>() == "completed")) { run["status"] = "completed"; run["finishedAt"] = now; }
        else if (tasks.Any(task => task["status"]?.GetValue<string>() == "failed")) run["status"] = "failed";
        else if (tasks.Any(task => (task["status"]?.GetValue<string>() ?? "") is "queued" or "claimed" or "running" or "review")) run["status"] = "running";
        else run["status"] = "waiting";
        run["updatedAt"] = now;
    }

    private void AppendRunAudit(JsonObject registry, string action, JsonObject task, string detail, string phase, bool success = true)
    {
        var run = FindRun(registry, task["runId"]?.GetValue<string>() ?? "");
        AppendAudit(registry, action, task["agentId"]?.GetValue<string>() ?? "", run["projectId"]?.GetValue<string>() ?? "", Array.Empty<string>(), detail,
            success: success, task: task["title"]?.GetValue<string>() ?? "", requestedProvider: task["provider"]?.GetValue<string>() ?? "", clientProvider: _clientProvider,
            actualProvider: _clientProvider, phase: phase, runId: run["id"]?.GetValue<string>() ?? "", taskId: task["id"]?.GetValue<string>() ?? "");
    }

    private static void ValidatePlanDag(Dictionary<string, JsonObject> definitions)
    {
        foreach (var pair in definitions)
            foreach (var dependency in (pair.Value["dependsOn"] as JsonArray ?? new JsonArray()).Select(node => node?.GetValue<string>() ?? ""))
                if (!definitions.ContainsKey(dependency)) throw new McpException(-32602, $"Task {pair.Key} depends on unknown task {dependency}.");
        var states = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        bool Visit(string id)
        {
            if (states.TryGetValue(id, out var state)) return state == 1;
            states[id] = 1;
            foreach (var dependency in (definitions[id]["dependsOn"] as JsonArray ?? new JsonArray()).Select(node => node?.GetValue<string>() ?? ""))
                if (Visit(dependency)) return true;
            states[id] = 2; return false;
        }
        if (definitions.Keys.Any(Visit)) throw new McpException(-32602, "The submitted plan contains a dependency cycle.");
    }

    private static JsonObject FindRun(JsonObject registry, string runId) => Runs(registry).OfType<JsonObject>().FirstOrDefault(run => run["id"]?.GetValue<string>() == runId)
        ?? throw new McpException(-32602, $"Agent run not found: {runId}");

    private static IEnumerable<JsonObject> TasksForRun(JsonObject registry, JsonObject run) => RunTasks(registry).OfType<JsonObject>().Where(task => task["runId"]?.GetValue<string>() == run["id"]?.GetValue<string>());
    private static IEnumerable<JsonObject> ActiveTasksForRun(JsonObject registry, JsonObject run) => TasksForRun(registry, run).Where(task => task["supersededAt"] is null);

    private static JsonObject RunWithProgress(JsonObject registry, JsonObject run)
    {
        var tasks = ActiveTasksForRun(registry, run).ToArray(); var completed = tasks.Count(task => task["status"]?.GetValue<string>() == "completed");
        var clone = run.DeepClone() as JsonObject ?? new JsonObject(); clone["taskCount"] = tasks.Length; clone["completedTaskCount"] = completed; clone["progress"] = tasks.Length == 0 ? 0 : (int)Math.Round(completed * 100d / tasks.Length);
        return clone;
    }

    private static JsonObject RunDetails(JsonObject registry, JsonObject run) => new()
    {
        ["run"] = RunWithProgress(registry, run), ["tasks"] = new JsonArray(TasksForRun(registry, run).Select(task => (JsonNode?)task.DeepClone()).ToArray()),
        ["artifacts"] = new JsonArray(RunArtifacts(registry).OfType<JsonObject>().Where(item => item["runId"]?.GetValue<string>() == run["id"]?.GetValue<string>()).Select(item => (JsonNode?)item.DeepClone()).ToArray()),
        ["markdown"] = $"Run {run["id"]}: {run["status"]}"
    };

    private static void RecomputeReadyTasks(JsonObject registry, JsonObject run)
    {
        var tasks = ActiveTasksForRun(registry, run).ToArray(); var byId = tasks.ToDictionary(task => task["id"]?.GetValue<string>() ?? "", StringComparer.OrdinalIgnoreCase);
        foreach (var task in tasks.Where(task => task["status"]?.GetValue<string>() == "blocked"))
        {
            var dependencies = task["dependsOn"] as JsonArray ?? new JsonArray();
            if (dependencies.All(node => byId.TryGetValue(node?.GetValue<string>() ?? "", out var dependency) && dependency["status"]?.GetValue<string>() == "completed"))
                task["status"] = "queued";
        }
    }

    private void EnsureKnownExecutionProvider()
    {
        if (_clientProvider == "unknown") throw new McpException(-32004, "Agent run execution tools require an explicit --client-provider value.");
    }

    private static string Bounded(string value, int max) => value.Trim().Length <= max ? value.Trim() : value.Trim()[..max];
    private static string Sha256(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    private static JsonArray Runs(JsonObject registry) => registry["agentRuns"] as JsonArray ?? throw new McpException(-32002, "agentRuns collection is missing.");
    private static JsonArray RunTasks(JsonObject registry) => registry["runTasks"] as JsonArray ?? throw new McpException(-32002, "runTasks collection is missing.");
    private static JsonArray RunArtifacts(JsonObject registry) => registry["runArtifacts"] as JsonArray ?? throw new McpException(-32002, "runArtifacts collection is missing.");

    private static int RemoveWhere(JsonArray collection, Func<JsonObject, bool> predicate)
    {
        var removed = 0;
        for (var index = collection.Count - 1; index >= 0; index--)
        {
            if (collection[index] is not JsonObject item || !predicate(item)) continue;
            collection.RemoveAt(index);
            removed++;
        }
        return removed;
    }

    private JsonObject ReadSkill(JsonObject arguments)
    {
        var reference = RequiredString(arguments, "reference");
        var registry = LoadRegistry();
        var skill = FindSkill(registry, reference)
            ?? throw new McpException(-32602, $"Skill not found in local registry: {reference}");
        var uri = SkillUri(skill);
        var attachments = SkillAttachmentManifest(skill);
        var markdown = new StringBuilder(skill["content"]?.GetValue<string>() ?? "");
        AppendAttachmentInstructions(markdown, skill);
        return new JsonObject
        {
            ["uri"] = uri,
            ["id"] = SkillId(skill),
            ["namespace"] = skill["namespace"]?.GetValue<string>() ?? "local",
            ["title"] = skill["title"]?.GetValue<string>() ?? SkillId(skill),
            ["version"] = skill["version"]?.GetValue<string>() ?? "0.1.0",
            ["dependencies"] = skill["deps"]?.DeepClone() ?? new JsonArray(),
            ["attachments"] = attachments,
            ["markdown"] = markdown.ToString()
        };
    }

    private JsonObject ReadSkillAsset(JsonObject arguments)
    {
        var reference = RequiredString(arguments, "reference");
        var assetId = RequiredString(arguments, "assetId");
        var registry = LoadRegistry();
        var skill = FindSkill(registry, reference)
            ?? throw new McpException(-32602, $"Skill not found in local registry: {reference}");
        var image = (skill["images"] as JsonArray ?? new JsonArray())
            .OfType<JsonObject>()
            .FirstOrDefault(item => (item["id"]?.GetValue<string>() ?? "").Equals(assetId, StringComparison.OrdinalIgnoreCase))
            ?? throw new McpException(-32602, $"Image attachment not found in {SkillUri(skill)}: {assetId}");
        var path = ResolveSkillAssetPath(image);
        var info = new FileInfo(path);
        if (info.Length > 20 * 1024 * 1024)
            throw new McpException(-32602, $"Image attachment is larger than the 20 MB MCP limit: {assetId}");

        var mimeType = ImageMimeType(path);
        if (!mimeType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
            throw new McpException(-32602, $"Unsupported image attachment format: {Path.GetExtension(path)}");
        var data = Convert.ToBase64String(File.ReadAllBytes(path));
        var caption = image["caption"]?.GetValue<string>() ?? image["name"]?.GetValue<string>() ?? assetId;
        var manifest = SkillAttachmentSummary(skill, image);
        manifest["sizeBytes"] = info.Length;
        manifest["available"] = true;
        manifest["markdown"] = $"Loaded image attachment {assetId} from {SkillUri(skill)}: {caption}";
        manifest["_mcpContent"] = new JsonArray
        {
            new JsonObject { ["type"] = "text", ["text"] = $"Skill image: {caption} ({assetId})" },
            new JsonObject { ["type"] = "image", ["data"] = data, ["mimeType"] = mimeType }
        };
        return manifest;
    }

    private JsonObject ListProjectSkills(JsonObject arguments)
    {
        var registry = LoadRegistry();
        var project = FindProject(registry, arguments);
        var resolution = ResolveProject(registry, project);
        var roots = project["roots"] as JsonArray ?? new JsonArray();
        var summary = new JsonObject
        {
            ["project"] = ProjectSummary(project),
            ["roots"] = roots.DeepClone(),
            ["requiredOrder"] = new JsonArray(resolution.Order.Select(skill => (JsonNode?)SkillUri(skill)).ToArray()),
            ["graph"] = GraphObject(resolution),
            ["conflicts"] = new JsonArray(resolution.Conflicts.Select(value => (JsonNode?)value).ToArray())
        };
        summary["markdown"] = $"Project {project["name"]}: {resolution.Order.Count} skills, {resolution.Edges.Count} edges, {resolution.Conflicts.Count} conflicts.\n" +
            string.Join("\n", resolution.Order.Select((skill, index) => $"{index + 1}. {SkillUri(skill)}"));
        return summary;
    }

    private JsonObject SearchSkills(JsonObject arguments)
    {
        var query = RequiredString(arguments, "query");
        var limit = Math.Clamp(arguments["limit"]?.GetValue<int?>() ?? 10, 1, 50);
        var tokens = Tokenize(query);
        var registry = LoadRegistry();
        var matches = Skills(registry)
            .Select(skill => new { Skill = skill, Score = Relevance(skill, tokens) })
            .Where(item => item.Score > 0)
            .OrderByDescending(item => item.Score)
            .ThenBy(item => SkillId(item.Skill), StringComparer.OrdinalIgnoreCase)
            .Take(limit)
            .ToArray();
        var results = new JsonArray(matches.Select(item => (JsonNode?)SkillSummary(item.Skill, SkillUri(item.Skill), item.Score)).ToArray());
        return new JsonObject
        {
            ["query"] = query,
            ["results"] = results,
            ["markdown"] = matches.Length == 0
                ? $"No local skills match: {query}"
                : string.Join("\n", matches.Select(item => $"- {SkillUri(item.Skill)} — {item.Skill["title"]} (score {item.Score})"))
        };
    }

    private JsonObject ValidateProjectGraph(JsonObject arguments)
    {
        var registry = LoadRegistry();
        var project = FindProject(registry, arguments);
        var resolution = ResolveProject(registry, project);
        return new JsonObject
        {
            ["valid"] = resolution.Conflicts.Count == 0,
            ["project"] = ProjectSummary(project),
            ["skillCount"] = resolution.Order.Count,
            ["edgeCount"] = resolution.Edges.Count,
            ["conflicts"] = new JsonArray(resolution.Conflicts.Select(value => (JsonNode?)value).ToArray()),
            ["markdown"] = resolution.Conflicts.Count == 0
                ? $"Graph is valid: {resolution.Order.Count} skills, {resolution.Edges.Count} edges."
                : "Graph validation failed:\n" + string.Join("\n", resolution.Conflicts.Select(value => $"- {value}"))
        };
    }

    private JsonObject CreateSkill(JsonObject arguments)
    {
        var id = Slug(RequiredString(arguments, "id"));
        var name = RequiredString(arguments, "name").Trim();
        var registry = LoadRegistry();
        if (Skills(registry).Any(skill => SkillId(skill).Equals(id, StringComparison.OrdinalIgnoreCase)))
            throw new McpException(-32602, $"Skill already exists: {id}");

        var skillNamespace = arguments["namespace"]?.GetValue<string>()?.Trim();
        if (string.IsNullOrWhiteSpace(skillNamespace)) skillNamespace = "codex";
        var version = arguments["version"]?.GetValue<string>()?.Trim();
        if (string.IsNullOrWhiteSpace(version)) version = "0.1.0";
        var description = arguments["description"]?.GetValue<string>()?.Trim() ?? "";
        var tags = arguments["tags"] as JsonArray ?? new JsonArray();
        var now = DateTimeOffset.UtcNow.ToString("O");
        var content = arguments["content"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(content)) content = SkillMarkdown(id, name, skillNamespace, version, description, tags);

        var skill = new JsonObject
        {
            ["id"] = id,
            ["namespace"] = skillNamespace,
            ["name"] = name,
            ["title"] = name,
            ["version"] = version,
            ["status"] = "draft",
            ["description"] = description,
            ["tags"] = tags.DeepClone(),
            ["deps"] = new JsonArray(),
            ["favorite"] = false,
            ["history"] = new JsonArray(),
            ["createdAt"] = now,
            ["updatedAt"] = now,
            ["content"] = content
        };
        var skills = registry["skills"] as JsonArray ?? new JsonArray();
        registry["skills"] = skills;
        skills.Add(skill);
        SaveRegistry(registry);
        return new JsonObject { ["created"] = true, ["skill"] = SkillSummary(skill, SkillUri(skill), 0), ["markdown"] = $"Created {SkillUri(skill)}" };
    }

    private JsonObject SetSkillRelation(JsonObject arguments)
    {
        var sourceId = CleanReference(RequiredString(arguments, "sourceId"));
        var targetId = CleanReference(RequiredString(arguments, "targetId"));
        var type = RequiredString(arguments, "type").Trim().ToLowerInvariant();
        if (type is not ("requires" or "extends" or "recommends"))
            throw new McpException(-32602, "Relation type must be requires, extends, or recommends.");
        if (sourceId.Equals(targetId, StringComparison.OrdinalIgnoreCase))
            throw new McpException(-32602, "A skill cannot be related to itself.");
        var range = arguments["range"]?.GetValue<string>()?.Trim();
        if (string.IsNullOrWhiteSpace(range)) range = "*";

        var registry = LoadRegistry();
        var source = FindSkill(registry, sourceId) ?? throw new McpException(-32602, $"Source skill not found: {sourceId}");
        var target = FindSkill(registry, targetId) ?? throw new McpException(-32602, $"Target skill not found: {targetId}");
        var deps = source["deps"] as JsonArray ?? new JsonArray();
        source["deps"] = deps;
        var existing = deps.OfType<JsonObject>().FirstOrDefault(dep =>
            CleanReference(dep["id"]?.GetValue<string>() ?? "").Equals(targetId, StringComparison.OrdinalIgnoreCase) &&
            (dep["type"]?.GetValue<string>() ?? "requires").Equals(type, StringComparison.OrdinalIgnoreCase));
        if (existing is null)
            deps.Add(new JsonObject { ["id"] = targetId, ["type"] = type, ["range"] = range });
        else
            existing["range"] = range;

        var references = deps.OfType<JsonObject>().Where(dep => (dep["type"]?.GetValue<string>() ?? "requires") == type)
            .Select(dep =>
            {
                var depId = CleanReference(dep["id"]?.GetValue<string>() ?? "");
                var depSkill = FindSkill(registry, depId);
                return $"skill://{depSkill?["namespace"]?.GetValue<string>() ?? "local"}.{depId}@{dep["range"]?.GetValue<string>() ?? "*"}";
            }).ToArray();
        source["content"] = ReplaceFrontmatterList(source["content"]?.GetValue<string>() ?? "", type, references);
        source["updatedAt"] = DateTimeOffset.UtcNow.ToString("O");
        SaveRegistry(registry);
        return new JsonObject { ["updated"] = true, ["source"] = SkillUri(source), ["target"] = SkillUri(target), ["type"] = type, ["range"] = range, ["markdown"] = $"Linked {sourceId} --{type}--> {targetId} ({range})" };
    }

    private JsonObject MutateRegistry(Func<JsonObject, JsonObject> mutation)
    {
        using var registryLock = AcquireRegistryLock();
        var registry = LoadRegistry();
        var result = mutation(registry);
        SaveRegistryUnlocked(registry);
        return result;
    }

    private FileStream AcquireRegistryLock()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_registryPath)!);
        var lockPath = _registryPath + ".lock";
        var deadline = DateTime.UtcNow.AddSeconds(8);
        while (true)
        {
            try { return new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) when (DateTime.UtcNow < deadline) { Thread.Sleep(50); }
        }
    }

    private void SaveRegistry(JsonObject registry)
    {
        using var registryLock = AcquireRegistryLock();
        SaveRegistryUnlocked(registry);
    }

    private void SaveRegistryUnlocked(JsonObject registry)
    {
        registry["updatedAt"] = DateTimeOffset.UtcNow.ToString("O");
        registry["registryRevision"] = Math.Max(0, registry["registryRevision"]?.GetValue<int?>() ?? 0) + 1;
        Directory.CreateDirectory(Path.GetDirectoryName(_registryPath)!);
        var temporary = $"{_registryPath}.{Environment.ProcessId}.{Guid.NewGuid():N}.mcp.tmp";
        File.WriteAllText(temporary, registry.ToJsonString(new JsonSerializerOptions { WriteIndented = true }), new UTF8Encoding(false));
        File.Move(temporary, _registryPath, true);
    }

    private static string SkillMarkdown(string id, string name, string skillNamespace, string version, string description, JsonArray tags)
    {
        var tagLines = tags.Count == 0 ? "  []" : string.Join('\n', tags.Select(tag => $"  - {tag?.GetValue<string>()}"));
        var purpose = string.IsNullOrWhiteSpace(description) ? "Опишите назначение скилла." : description;
        return string.Join('\n', new[]
        {
            "---", "schema: skillgraph/v1", $"id: {skillNamespace}.{id}", $"version: {version}",
            $"name: {name}", $"title: {name}", "status: draft", "", "requires:", "  []", "",
            "extends:", "  []", "", "recommends:", "  []", "", "tags:", tagLines, "---", "",
            $"# {name}", "", "## Назначение", "", purpose, "", "## Правила", "",
            "1. Добавьте правила и инструкции скилла.", ""
        });
    }

    private static string ReplaceFrontmatterList(string content, string key, IEnumerable<string> values)
    {
        var rows = values.ToArray();
        var block = $"{key}:\n{(rows.Length == 0 ? "  []" : string.Join('\n', rows.Select(value => $"  - {value}")))}\n\n";
        var pattern = new Regex($"^{Regex.Escape(key)}:\\s*(?:\\r?\\n)?[\\s\\S]*?(?=^(?:requires|extends|recommends|tags|permissions):|^---$)", RegexOptions.Multiline | RegexOptions.IgnoreCase);
        return pattern.IsMatch(content) ? pattern.Replace(content, block, 1) : content;
    }

    private static string Slug(string value)
    {
        var slug = Regex.Replace(value.Trim().ToLowerInvariant(), "[^a-z0-9-]+", "-").Trim('-');
        if (string.IsNullOrWhiteSpace(slug)) throw new McpException(-32602, "Skill id must contain Latin letters or digits.");
        return slug;
    }

    private JsonObject ListResources()
    {
        var registry = LoadRegistry();
        return new JsonObject
        {
            ["resources"] = new JsonArray(Skills(registry).Select(skill => (JsonNode?)new JsonObject
            {
                ["uri"] = SkillUri(skill),
                ["name"] = SkillId(skill),
                ["title"] = skill["title"]?.GetValue<string>() ?? SkillId(skill),
                ["description"] = skill["description"]?.GetValue<string>() ?? "SkillGraph skill",
                ["mimeType"] = "text/markdown"
            }).ToArray())
        };
    }

    private static JsonObject ListResourceTemplates() => new()
    {
        ["resourceTemplates"] = new JsonArray
        {
            new JsonObject
            {
                ["uriTemplate"] = "skill://{reference}",
                ["name"] = "skillgraph-skill",
                ["title"] = "SkillGraph skill",
                ["description"] = "Read a local SkillGraph Markdown skill by namespace.id@version.",
                ["mimeType"] = "text/markdown"
            }
        }
    };

    private JsonObject ReadResource(JsonObject parameters)
    {
        var uri = RequiredString(parameters, "uri");
        var registry = LoadRegistry();
        var skill = FindSkill(registry, uri)
            ?? throw new McpException(-32602, $"No local SkillGraph resource exists at {uri}");
        return new JsonObject
        {
            ["contents"] = new JsonArray
            {
                new JsonObject
                {
                    ["uri"] = SkillUri(skill),
                    ["mimeType"] = "text/markdown",
                    ["text"] = skill["content"]?.GetValue<string>() ?? ""
                }
            }
        };
    }

    private static JsonObject ListPrompts() => new()
    {
        ["prompts"] = new JsonArray
        {
            new JsonObject
            {
                ["name"] = "resolve-before-work",
                ["title"] = "Resolve SkillGraph before work",
                ["description"] = "Instruct an agent to resolve and read the project's skill chain before planning or editing.",
                ["arguments"] = new JsonArray
                {
                    new JsonObject { ["name"] = "workspacePath", ["description"] = "Current workspace root", ["required"] = true },
                    new JsonObject { ["name"] = "task", ["description"] = "Current user task", ["required"] = true }
                }
            }
        }
    };

    private static JsonObject GetPrompt(JsonObject parameters)
    {
        if (parameters["name"]?.GetValue<string>() != "resolve-before-work")
            throw new McpException(-32602, "Unknown prompt.");
        var arguments = parameters["arguments"] as JsonObject ?? new JsonObject();
        var workspace = arguments["workspacePath"]?.GetValue<string>() ?? "<current workspace>";
        var task = arguments["task"]?.GetValue<string>() ?? "<current task>";
        return new JsonObject
        {
            ["description"] = "Resolve SkillGraph context before work",
            ["messages"] = new JsonArray
            {
                new JsonObject
                {
                    ["role"] = "user",
                    ["content"] = new JsonObject
                    {
                        ["type"] = "text",
                        ["text"] = $"Before planning or editing, call resolve_task_context with workspacePath={workspace} and task={task}. Apply requiredOrder and do not download skill:// references."
                    }
                }
            }
        };
    }

    private JsonObject LoadRegistry()
    {
        if (!File.Exists(_registryPath))
            throw new McpException(-32001, $"SkillGraph registry was not found at {_registryPath}. Open SkillGraph and create or import skills first.");
        try
        {
            var registry = JsonNode.Parse(File.ReadAllText(_registryPath, Encoding.UTF8)) as JsonObject
                ?? throw new McpException(-32002, "SkillGraph registry is not a JSON object.");
            NormalizeRegistry(registry);
            return registry;
        }
        catch (JsonException error)
        {
            throw new McpException(-32002, $"SkillGraph registry is invalid JSON: {error.Message}");
        }
    }

    private static void NormalizeRegistry(JsonObject registry)
    {
        registry["schema"] ??= "skillgraph/registry-v2";
        registry["registryRevision"] ??= 0;
        foreach (var collection in new[] { "skills", "projects", "agents", "handoffs", "agentRuns", "runTasks", "runArtifacts", "auditLog", "evaluations", "sources", "groups" })
            if (registry[collection] is not JsonArray) registry[collection] = new JsonArray();
        if (registry["settings"] is not JsonObject) registry["settings"] = new JsonObject();
    }

    private static JsonObject FindProject(JsonObject registry, JsonObject arguments)
    {
        var projects = Projects(registry).ToArray();
        var projectId = arguments["projectId"]?.GetValue<string>();
        if (!string.IsNullOrWhiteSpace(projectId))
            return projects.FirstOrDefault(project => project["id"]?.GetValue<string>() == projectId)
                ?? throw new McpException(-32602, $"SkillGraph project not found: {projectId}");

        var workspace = arguments["workspacePath"]?.GetValue<string>();
        if (!string.IsNullOrWhiteSpace(workspace))
        {
            var normalizedWorkspace = NormalizePath(workspace);
            var exact = projects.FirstOrDefault(project => NormalizePath(project["location"]?.GetValue<string>()) == normalizedWorkspace);
            if (exact is not null) return exact;
            var containing = projects
                .Where(project => IsInside(normalizedWorkspace, NormalizePath(project["location"]?.GetValue<string>())))
                .OrderByDescending(project => NormalizePath(project["location"]?.GetValue<string>()).Length)
                .FirstOrDefault();
            if (containing is not null) return containing;
        }

        if (projects.Length == 1) return projects[0];
        if (projects.Length == 0) throw new McpException(-32602, "No projects are connected in SkillGraph.");
        throw new McpException(-32602, "Project could not be determined. Pass workspacePath or projectId.");
    }

    private static Resolution ResolveProject(JsonObject registry, JsonObject project)
        => ResolveRoots(registry, project["roots"] as JsonArray ?? new JsonArray());

    private static JsonArray RootsWithExplicitSkillReferences(JsonObject registry, JsonArray configuredRoots, string task)
    {
        var roots = new JsonArray(configuredRoots.Select(node => node?.DeepClone()).ToArray());
        var existing = roots
            .Where(node => node is not null)
            .Select(node => CleanReference(node!.GetValue<string>()))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        void AddSkill(JsonObject skill)
        {
            var id = SkillId(skill);
            if (existing.Add(id)) roots.Add(id);
        }

        foreach (Match match in Regex.Matches(
                     task,
                     @"skill://[a-zA-Z0-9._-]+(?:@[0-9A-Za-z.*+_-]+)?",
                     RegexOptions.IgnoreCase))
        {
            var skill = FindSkill(registry, match.Value);
            if (skill is not null) AddSkill(skill);
        }

        // A run preset may use a short phrase such as
        // "используй скилл project-template-builder" instead of a URI.
        // Treat an exact known id/name as an explicit reference, not as fuzzy search.
        foreach (var skill in Skills(registry))
        {
            var candidates = new[]
            {
                SkillId(skill),
                skill["name"]?.GetValue<string>() ?? "",
                $"{skill["namespace"]?.GetValue<string>() ?? "local"}.{SkillId(skill)}"
            };
            if (candidates.Where(value => !string.IsNullOrWhiteSpace(value)).Any(value =>
                    Regex.IsMatch(task, $@"(?<![\p{{L}}\p{{N}}_-]){Regex.Escape(value)}(?![\p{{L}}\p{{N}}_-])", RegexOptions.IgnoreCase)))
            {
                AddSkill(skill);
            }
        }

        return roots;
    }

    private static Resolution ResolveRoots(JsonObject registry, JsonArray roots)
    {
        var skills = Skills(registry).ToDictionary(SkillId, StringComparer.OrdinalIgnoreCase);
        var order = new List<JsonObject>();
        var edges = new List<JsonObject>();
        var conflicts = new List<string>();
        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var visiting = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void Visit(string id, List<string> trail)
        {
            if (visited.Contains(id)) return;
            if (visiting.Contains(id))
            {
                conflicts.Add($"Dependency cycle: {string.Join(" -> ", trail.Append(id))}");
                return;
            }
            if (!skills.TryGetValue(id, out var skill))
            {
                conflicts.Add($"Missing skill: {id}");
                return;
            }

            visiting.Add(id);
            foreach (var dependencyNode in skill["deps"] as JsonArray ?? new JsonArray())
            {
                if (dependencyNode is not JsonObject dependency) continue;
                var target = CleanReference(dependency["id"]?.GetValue<string>() ?? "");
                if (string.IsNullOrWhiteSpace(target)) continue;
                edges.Add(new JsonObject
                {
                    ["source"] = id,
                    ["target"] = target,
                    ["type"] = dependency["type"]?.GetValue<string>() ?? "requires",
                    ["range"] = dependency["range"]?.GetValue<string>() ?? "*"
                });
                Visit(target, trail.Append(id).ToList());
            }
            visiting.Remove(id);
            visited.Add(id);
            order.Add(skill);
        }

        foreach (var root in roots)
            if (root is not null) Visit(CleanReference(root.GetValue<string>()), new List<string>());

        return new Resolution(order, edges, conflicts.Distinct(StringComparer.OrdinalIgnoreCase).ToList());
    }

    private static JsonObject GraphObject(Resolution resolution) => new()
    {
        ["nodes"] = new JsonArray(resolution.Order.Select(skill => (JsonNode?)new JsonObject
        {
            ["id"] = SkillId(skill),
            ["uri"] = SkillUri(skill),
            ["title"] = skill["title"]?.GetValue<string>() ?? SkillId(skill)
        }).ToArray()),
        ["edges"] = new JsonArray(resolution.Edges.Select(edge => (JsonNode?)edge.DeepClone()).ToArray())
    };

    private static JsonObject? FindSkill(JsonObject registry, string reference)
    {
        var id = CleanReference(reference);
        var qualified = reference.Replace("skill://", "", StringComparison.OrdinalIgnoreCase).Split('@')[0].TrimEnd('/');
        return Skills(registry).FirstOrDefault(skill =>
            SkillId(skill).Equals(id, StringComparison.OrdinalIgnoreCase) ||
            $"{skill["namespace"]?.GetValue<string>() ?? "local"}.{SkillId(skill)}".Equals(qualified, StringComparison.OrdinalIgnoreCase));
    }

    private static IEnumerable<JsonObject> Skills(JsonObject registry) =>
        (registry["skills"] as JsonArray ?? new JsonArray()).OfType<JsonObject>();

    private static IEnumerable<JsonObject> Projects(JsonObject registry) =>
        (registry["projects"] as JsonArray ?? new JsonArray()).OfType<JsonObject>();

    private static IEnumerable<JsonObject> Agents(JsonObject registry) =>
        (registry["agents"] as JsonArray ?? new JsonArray()).OfType<JsonObject>();

    private static JsonObject FindAgent(JsonObject registry, string id) => Agents(registry).FirstOrDefault(agent => (agent["id"]?.GetValue<string>() ?? "").Equals(id, StringComparison.OrdinalIgnoreCase))
        ?? throw new McpException(-32602, $"SkillGraph agent not found: {id}");

    private static void EnsureAgentAccess(JsonObject agent, JsonObject project, string permission)
    {
        if (!(agent["permissions"]?[permission]?.GetValue<bool?>() ?? permission == "read")) throw new McpException(-32003, $"Agent is not allowed to {permission}.");
        var agentId = agent["id"]?.GetValue<string>() ?? "";
        if (!(project["agentIds"] as JsonArray ?? new JsonArray()).Any(node => (node?.GetValue<string>() ?? "").Equals(agentId, StringComparison.OrdinalIgnoreCase))) throw new McpException(-32003, "Agent is not assigned to this project.");
    }

    private static JsonObject AgentSummary(JsonObject agent) => new()
    {
        ["id"] = agent["id"]?.GetValue<string>() ?? "unknown", ["name"] = agent["name"]?.GetValue<string>() ?? "Agent", ["role"] = agent["role"]?.GetValue<string>() ?? "", ["provider"] = agent["provider"]?.GetValue<string>() ?? "custom", ["status"] = agent["status"]?.GetValue<string>() ?? "active"
    };

    private static string ProviderOf(JsonObject agent)
    {
        var provider = agent["provider"]?.GetValue<string>()?.Trim().ToLowerInvariant();
        return provider is "codex" or "cursor" or "claude" or "copilot" or "deepseek" or "qwen" or "local" or "custom" ? provider : "custom";
    }

    private void EnsureProviderAffinity(JsonObject agent, string operation)
    {
        if (_clientProvider == "unknown") return;
        var assigned = ProviderOf(agent);
        if (assigned.Equals(_clientProvider, StringComparison.OrdinalIgnoreCase)) return;
        throw new McpException(-32004, $"Provider mismatch: agent '{agent["name"]}' is assigned to {assigned}, but this MCP connection is {_clientProvider}. The {_clientProvider} client may route or create a handoff, but cannot {operation}. Open the task in {assigned} and use its SkillGraph MCP connection.");
    }

    private JsonObject? AcceptPendingHandoff(JsonObject registry, JsonObject project, JsonObject agent, string task)
    {
        var projectId = project["id"]?.GetValue<string>() ?? "";
        var agentId = agent["id"]?.GetValue<string>() ?? "";
        var handoff = (registry["handoffs"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().LastOrDefault(item =>
            item["projectId"]?.GetValue<string>() == projectId
            && item["toAgentId"]?.GetValue<string>() == agentId
            && (item["status"]?.GetValue<string>() ?? "pending") == "pending"
            && (string.IsNullOrWhiteSpace(task) || (item["task"]?.GetValue<string>() ?? "").Equals(task, StringComparison.OrdinalIgnoreCase)));
        if (handoff is null) return null;
        handoff["status"] = "accepted";
        handoff["updatedAt"] = DateTimeOffset.UtcNow.ToString("O");
        AppendAudit(registry, "handoff-accepted", agentId, projectId,
            (handoff["skillIds"] as JsonArray ?? new JsonArray()).Select(node => node?.GetValue<string>() ?? "").Where(value => value.Length > 0),
            $"accepted {handoff["id"]}", task: handoff["task"]?.GetValue<string>() ?? task, requestedProvider: ProviderOf(agent),
            clientProvider: _clientProvider, actualProvider: _clientProvider, phase: "started");
        return handoff;
    }

    private JsonObject? AcceptLinkedHandoff(JsonObject registry, JsonObject project, JsonObject agent, string? handoffId, JsonObject runTask)
    {
        if (string.IsNullOrWhiteSpace(handoffId)) return null;
        var handoff = (registry["handoffs"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().FirstOrDefault(item => item["id"]?.GetValue<string>() == handoffId)
            ?? throw new McpException(-32602, $"Handoff not found: {handoffId}");
        if (handoff["projectId"]?.GetValue<string>() != project["id"]?.GetValue<string>() || handoff["toAgentId"]?.GetValue<string>() != agent["id"]?.GetValue<string>()
            || handoff["runId"]?.GetValue<string>() != runTask["runId"]?.GetValue<string>()) throw new McpException(-32003, "Handoff is not linked to this agent run task.");
        if (handoff["status"]?.GetValue<string>() == "pending")
        {
            handoff["status"] = "accepted"; handoff["updatedAt"] = DateTimeOffset.UtcNow.ToString("O");
            AppendAudit(registry, "handoff-accepted", agent["id"]?.GetValue<string>() ?? "", project["id"]?.GetValue<string>() ?? "", Array.Empty<string>(),
                $"accepted {handoffId}", task: handoff["task"]?.GetValue<string>() ?? "", requestedProvider: ProviderOf(agent), clientProvider: _clientProvider,
                actualProvider: _clientProvider, phase: "started", runId: runTask["runId"]?.GetValue<string>() ?? "", taskId: runTask["id"]?.GetValue<string>() ?? "");
        }
        return handoff;
    }

    private JsonObject? CompleteAcceptedHandoff(JsonObject registry, JsonObject project, JsonObject agent, string result)
    {
        var projectId = project["id"]?.GetValue<string>() ?? "";
        var agentId = agent["id"]?.GetValue<string>() ?? "";
        var handoff = (registry["handoffs"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().LastOrDefault(item =>
            item["projectId"]?.GetValue<string>() == projectId
            && item["toAgentId"]?.GetValue<string>() == agentId
            && (item["status"]?.GetValue<string>() ?? "") == "accepted");
        if (handoff is null) return null;
        handoff["status"] = "done";
        if (!string.IsNullOrWhiteSpace(result)) handoff["result"] = result;
        handoff["updatedAt"] = DateTimeOffset.UtcNow.ToString("O");
        AppendAudit(registry, "handoff-done", agentId, projectId,
            (handoff["skillIds"] as JsonArray ?? new JsonArray()).Select(node => node?.GetValue<string>() ?? "").Where(value => value.Length > 0),
            $"completed {handoff["id"]}", task: handoff["task"]?.GetValue<string>() ?? "", requestedProvider: ProviderOf(agent),
            clientProvider: _clientProvider, actualProvider: _clientProvider, phase: "completed");
        return handoff;
    }

    private static void AppendAudit(JsonObject registry, string action, string agentId, string projectId, IEnumerable<string> skillIds, string detail = "", int durationMs = 0, int contextChars = 0, bool success = true,
        string task = "", string requestedProvider = "", string clientProvider = "", string actualProvider = "", string phase = "", string runId = "", string taskId = "")
    {
        var audit = registry["auditLog"] as JsonArray ?? new JsonArray(); registry["auditLog"] = audit;
        audit.Add(new JsonObject { ["id"] = $"audit-{Guid.NewGuid():N}", ["at"] = DateTimeOffset.UtcNow.ToString("O"), ["action"] = action, ["agentId"] = agentId, ["projectId"] = projectId,
            ["task"] = task, ["skillIds"] = new JsonArray(skillIds.Select(id => (JsonNode?)id).ToArray()), ["durationMs"] = durationMs, ["contextChars"] = contextChars,
            ["success"] = success, ["detail"] = detail, ["requestedProvider"] = requestedProvider, ["clientProvider"] = clientProvider,
            ["actualProvider"] = actualProvider, ["phase"] = phase, ["runId"] = runId, ["taskId"] = taskId });
        while (audit.Count > 500) audit.RemoveAt(0);
    }

    private static string SkillId(JsonObject skill) => skill["id"]?.GetValue<string>() ?? "unknown";

    private static string SkillUri(JsonObject skill) =>
        $"skill://{skill["namespace"]?.GetValue<string>() ?? "local"}.{SkillId(skill)}@{skill["version"]?.GetValue<string>() ?? "0.1.0"}";

    private static string CleanReference(string reference)
    {
        var value = reference.Trim().Replace("skill://", "", StringComparison.OrdinalIgnoreCase);
        value = value.Split('@')[0].TrimEnd('/');
        if (value.EndsWith("/SKILL.md", StringComparison.OrdinalIgnoreCase)) value = value[..^9];
        if (value.Contains('/')) value = value.Split('/')[0];
        return value.Split('.').LastOrDefault() ?? value;
    }

    private static string RequiredString(JsonObject source, string key)
    {
        var value = source[key]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(value)) throw new McpException(-32602, $"Argument '{key}' is required.");
        return value;
    }

    private static JsonObject SkillSummary(JsonObject skill, string uri, int relevance) => new()
    {
        ["id"] = SkillId(skill),
        ["uri"] = uri,
        ["title"] = skill["title"]?.GetValue<string>() ?? SkillId(skill),
        ["description"] = skill["description"]?.GetValue<string>() ?? "",
        ["version"] = skill["version"]?.GetValue<string>() ?? "0.1.0",
        ["tags"] = skill["tags"]?.DeepClone() ?? new JsonArray(),
        ["attachments"] = SkillAttachmentManifest(skill),
        ["relevance"] = relevance
    };

    private static JsonArray SkillAttachmentManifest(JsonObject skill) => new(
        (skill["images"] as JsonArray ?? new JsonArray())
            .OfType<JsonObject>()
            .Select(image => (JsonNode?)SkillAttachmentSummary(skill, image))
            .ToArray());

    private static JsonObject SkillAttachmentSummary(JsonObject skill, JsonObject image)
    {
        var assetId = image["id"]?.GetValue<string>() ?? "unknown";
        return new JsonObject
        {
            ["id"] = assetId,
            ["name"] = image["name"]?.GetValue<string>() ?? assetId,
            ["caption"] = image["caption"]?.GetValue<string>() ?? "",
            ["relation"] = image["relation"]?.GetValue<string>() ?? "extends",
            ["mimeType"] = ImageMimeType(image["name"]?.GetValue<string>() ?? image["relativePath"]?.GetValue<string>() ?? assetId),
            ["uri"] = $"skillgraph-asset://{SkillUri(skill).Replace("skill://", "", StringComparison.OrdinalIgnoreCase)}/{Uri.EscapeDataString(assetId)}",
            ["readWith"] = new JsonObject
            {
                ["tool"] = "read_skill_asset",
                ["reference"] = SkillUri(skill),
                ["assetId"] = assetId
            }
        };
    }

    private static void AppendAttachmentInstructions(StringBuilder markdown, JsonObject skill)
    {
        var images = (skill["images"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().ToArray();
        if (images.Length == 0) return;
        markdown.AppendLine().AppendLine("### Attached images");
        markdown.AppendLine("These are real visual references. Call `read_skill_asset` for every relevant or required image before implementing visual work; do not infer the design from the filename alone.");
        foreach (var image in images)
        {
            var id = image["id"]?.GetValue<string>() ?? "unknown";
            var caption = image["caption"]?.GetValue<string>() ?? image["name"]?.GetValue<string>() ?? id;
            markdown.AppendLine($"- `{id}` — {caption}. Read with `read_skill_asset(reference: \"{SkillUri(skill)}\", assetId: \"{id}\")`.");
        }
    }

    private string ResolveSkillAssetPath(JsonObject image)
    {
        var registryDirectory = Path.GetDirectoryName(_registryPath)
            ?? throw new McpException(-32001, "SkillGraph registry directory could not be determined.");
        var assetRoot = Path.GetFullPath(Path.Combine(registryDirectory, "assets"));
        var candidates = new List<string>();
        foreach (var value in new[]
                 {
                     image["relativePath"]?.GetValue<string>(),
                     image["name"]?.GetValue<string>()
                 })
        {
            if (string.IsNullOrWhiteSpace(value)) continue;
            var candidate = Path.GetFullPath(Path.Combine(assetRoot, value));
            if (IsInside(candidate.ToUpperInvariant(), assetRoot.ToUpperInvariant())) candidates.Add(candidate);
        }

        var resolved = candidates.Distinct(StringComparer.OrdinalIgnoreCase).FirstOrDefault(File.Exists);
        if (resolved is null)
            throw new McpException(-32602, $"Image attachment file is missing: {image["id"]?.GetValue<string>() ?? "unknown"}. Expected it under {assetRoot}.");
        return resolved;
    }

    private static string ImageMimeType(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".webp" => "image/webp",
        ".gif" => "image/gif",
        ".bmp" => "image/bmp",
        ".svg" => "image/svg+xml",
        _ => "application/octet-stream"
    };

    private static JsonObject ProjectSummary(JsonObject project) => new()
    {
        ["id"] = project["id"]?.GetValue<string>() ?? "unknown",
        ["name"] = project["name"]?.GetValue<string>() ?? "Без названия",
        ["location"] = project["location"]?.GetValue<string>() ?? ""
    };

    private static HashSet<string> Tokenize(string text) => text
        .ToLowerInvariant()
        .Split(new[] { ' ', '\t', '\r', '\n', '.', ',', ':', ';', '/', '\\', '-', '_', '(', ')', '[', ']' }, StringSplitOptions.RemoveEmptyEntries)
        .Where(token => token.Length > 2)
        .ToHashSet(StringComparer.OrdinalIgnoreCase);

    private static int Relevance(JsonObject skill, HashSet<string> tokens)
    {
        if (tokens.Count == 0) return 0;
        var searchable = string.Join(' ', new[]
        {
            SkillId(skill),
            skill["namespace"]?.GetValue<string>() ?? "",
            skill["title"]?.GetValue<string>() ?? "",
            skill["description"]?.GetValue<string>() ?? "",
            string.Join(' ', (skill["tags"] as JsonArray ?? new JsonArray()).Select(item => item?.GetValue<string>() ?? ""))
        }).ToLowerInvariant();
        return tokens.Count(token => searchable.Contains(token, StringComparison.OrdinalIgnoreCase));
    }

    private static string NormalizePath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return "";
        try { return Path.GetFullPath(Environment.ExpandEnvironmentVariables(path)).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).ToUpperInvariant(); }
        catch { return path.Trim().TrimEnd('\\', '/').ToUpperInvariant(); }
    }

    private static bool IsInside(string path, string parent)
    {
        if (string.IsNullOrWhiteSpace(path) || string.IsNullOrWhiteSpace(parent)) return false;
        return path.Equals(parent, StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith(parent + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    private static JsonObject Tool(string name, string description, JsonObject inputSchema, IEnumerable<string>? required = null, bool readOnly = true)
    {
        if (required is not null) inputSchema["required"] = new JsonArray(required.Select(value => (JsonNode?)value).ToArray());
        return new JsonObject
        {
            ["name"] = name,
            ["description"] = description,
            ["inputSchema"] = inputSchema,
            ["annotations"] = new JsonObject
            {
                ["title"] = name.Replace('_', ' '),
                ["readOnlyHint"] = readOnly,
                ["destructiveHint"] = false,
                ["idempotentHint"] = true,
                ["openWorldHint"] = false
            }
        };
    }

    private static JsonObject ObjectSchema(params (string Name, string Type, string Description)[] properties)
    {
        var values = new JsonObject();
        foreach (var property in properties)
        {
            var schema = new JsonObject { ["type"] = property.Type, ["description"] = property.Description };
            if (property.Type == "array")
                schema["items"] = property.Name is "tasks" or "artifacts"
                    ? new JsonObject { ["type"] = "object", ["additionalProperties"] = true }
                    : new JsonObject { ["type"] = "string" };
            values[property.Name] = schema;
        }
        return new JsonObject { ["type"] = "object", ["properties"] = values, ["additionalProperties"] = false };
    }

    private static JsonObject ToolResult(string text, JsonObject structured, bool isError, JsonArray? content = null) => new()
    {
        ["content"] = content ?? new JsonArray { new JsonObject { ["type"] = "text", ["text"] = text } },
        ["structuredContent"] = structured,
        ["isError"] = isError
    };

    private sealed record Resolution(List<JsonObject> Order, List<JsonObject> Edges, List<string> Conflicts);
}

internal sealed class McpException : Exception
{
    public int Code { get; }
    public McpException(int code, string message) : base(message) => Code = code;
}
