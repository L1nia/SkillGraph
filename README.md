**English** | [Русский](README.ru.md)

# SkillGraph

SkillGraph is an interactive desktop registry for reusable AI skills. Its focused, Obsidian-inspired workspace lets you author Markdown instructions, model dependencies, connect skills to projects, and coordinate provider-aware agent workflows. A new registry starts empty: users create or import their own skills and data.

## Download

Download the latest Windows x64 package from [GitHub Releases](https://github.com/L1nia/SkillGraph/releases/latest), extract it to a separate folder, and run `SkillGraph.exe`.

The portable package includes the required .NET runtime. SkillGraph is a desktop application; the bundled HTML, CSS, and JavaScript are WebView2 resources and are not intended to run as a standalone website.

## Run from source

```powershell
dotnet run --project desktop-native/SkillGraph.Desktop.csproj
```

Local desktop data and the MCP connector share one portable registry located at `data\registry.json` next to `SkillGraph.exe`. The repository does not ship preconfigured skills. The `data` directory is reserved for local storage, while the registry and `data\assets` are created and populated at runtime.

On first launch, SkillGraph can locate older registries in `Documents\Codex\SkillGraphData` and AppData, select the most complete valid copy, and migrate it into the application directory. Each save keeps the previous valid registry in `registry.json.backup.json`; a damaged registry or a suspiciously large data loss is recovered from the fuller valid copy.

To create a self-contained Windows build:

```powershell
dotnet restore desktop-native/SkillGraph.Desktop.csproj -r win-x64
dotnet publish desktop-native/SkillGraph.Desktop.csproj -c Release -r win-x64 --self-contained true --no-restore -o release/SkillGraph-portable
```

The result is written to `release/SkillGraph-portable/`. Use the packaged directory from `release` or an extracted archive from `outputs`; `desktop-native/bin`, `desktop-native/obj`, `work`, and `.build-temp` are development artifacts and must not be used as distributions.

## Features

### Skills and projects

- Markdown editor with preview and local save history.
- Git-style comparison between the current and previous save.
- Import from Markdown, JSON, folders, and downloaded ZIP archives.
- Full-registry export and local search.
- Create, rename, edit, delete, favorite, group, and tag skills.
- Typed `requires`, `extends`, and `recommends` relationships.
- Direct resolution of `skill://namespace.id@version` references without downloading content from the Internet.
- Projects store references to root skills instead of copying skill content.
- Automatic dependency ordering and detection of missing or cyclic dependencies.
- PNG, JPG, WebP, GIF, and BMP attachments stored in portable `data\assets` and referenced through `skillgraph-asset://...`.

### Dependency graph

- Scalable graph with a large virtual canvas, panning, zooming, and fit-to-view.
- Dragging nodes with soft displacement of connected nodes.
- Relationship labels, hub highlighting, direct link creation, and dependency inspection.
- Double-click to open a skill and context actions for editing.
- Responsive graph controls and resizable navigator and inspector panels.

### Agents and execution

- Reusable agent profiles with roles, permissions, assigned provider, and root skills.
- Explainable routing, provider-aware runtime capabilities, and secure handoffs.
- Persistent autonomous runs represented as a DAG and horizontal swimlane graph.
- Task leasing, progress reporting, retry, reassignment, pause, resume, and cancellation.
- Automatic local audit trail for routing, context resolution, handoffs, and outcomes.
- Evaluation of runs with and without the SkillGraph context chain.

### AI and MCP integration

- Local read/write MCP server for Codex, Cursor, Claude, Copilot, DeepSeek, Qwen, compatible local clients, and custom providers.
- One-time global setup for Codex and Cursor with a real MCP handshake check.
- Portable MCP profiles for other providers in `data/connections/<provider>.mcp.json`.
- Provider identity is enforced at runtime rather than used as a decorative label.
- SkillGraph does not store model API keys.
- The managed MCP connector is deployed to `%LOCALAPPDATA%\SkillGraph\connector`, so AI clients do not lock the portable application directory.

### Desktop experience and safety

- Dark and light themes.
- Responsive layout for narrow and short windows.
- Windows Snap support and maximization within the taskbar work area.
- Keyboard shortcuts for saving, search, command palette, undo/redo, navigation, creation, and import.
- Native host file watching keeps the UI synchronized with agent changes.
- Browser `localStorage` is never used for the desktop registry.
- Failed optional integration updates are logged without blocking application startup.
- Mass accidental skill loss is rejected and recoverable backups are preserved.

## Connecting AI clients

1. Add a project folder in SkillGraph and attach its root skills.
2. Open **Project context → AI connections**.
3. For Cursor or Codex, select **Connect** or **Repair connection**. SkillGraph validates both the configuration and an actual MCP handshake.
4. Restart the AI client if it was already open during setup.

For Claude, Copilot, DeepSeek, Qwen, local models, and custom providers, SkillGraph generates a portable `stdio` MCP profile and copies its JSON to the clipboard. Paste it into the MCP settings of the corresponding client. The `--client-provider` value ensures that a runtime only receives tasks assigned to its provider.

The MCP server instructs agents to resolve the required project chain before planning or modifying code. It rereads the registry for every request, so saved changes are available without a separate export.

## MCP tools

Context and skills:

- `resolve_task_context` — resolve the complete ordered project chain.
- `read_skill` — read one skill and its attachment manifest.
- `read_skill_asset` — return an attached image as MCP `ImageContent`.
- `list_project_skills` — list roots, order, and the project graph.
- `search_skills` — search the local registry.
- `validate_project_graph` — detect cycles and missing dependencies.

Agents and handoffs:

- `resolve_agent_context` — resolve an agent context with provider checks.
- `route_agent_task` — recommend an executor without falsely marking the task as started.
- `create_agent_handoff`, `list_agent_handoffs`, `record_agent_outcome` — manage provider-aware task transfer and completion.
- `list_agent_audit` — read the automatic routing and execution audit trail.

Autonomous runs:

- `create_agent_run`, `submit_agent_run_plan`, `list_agent_runs`, `get_agent_run`.
- `register_agent_runtime`, `heartbeat_agent_runtime`, `claim_agent_run_task`.
- `start_agent_run_task`, `record_agent_run_progress`, `complete_agent_run_task`, `fail_agent_run_task`.
- `pause_agent_run`, `resume_agent_run`, `cancel_agent_run`, `retry_agent_run_task`, `reassign_agent_run_task`.

The **Agents → Execution** tab displays runs as a horizontal swimlane graph. A Task Manager and each executor run through the provider assigned in their agent profile. An open AI client becomes a worker after worker mode is enabled according to [WORKER-MODE.md](docs/WORKER-MODE.md).

To start the connector manually:

```powershell
SkillGraph.Mcp.exe --registry ".\data\registry.json" --client-provider cursor
```

## Documentation

- [Roadmap](docs/ROADMAP.md)
- [Worker mode](docs/WORKER-MODE.md)
- [Cursor MCP integration](docs/CURSOR-MCP.md)
- [Remote skill sources](docs/REMOTE-SOURCES.md)

## Repository data policy

The repository intentionally tracks only `data/.gitkeep`. Registries, attached skill assets, provider profiles, runtime state, backups, and logs remain local and are excluded from Git.
