# Hybrid Agent Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent, provider-safe agent run scheduler and live swimlane execution view for already running Codex and Cursor worker sessions.

**Architecture:** Extend registry-v2 with runs, tasks, artifacts, and lightweight runtime sessions. The MCP server remains the scheduling authority: Codex plans, provider-matched workers claim leased tasks, and every transition is audited. The desktop UI reads the same state and renders a deterministic agent-lane/dependency-depth graph.

**Tech Stack:** .NET 8 MCP server, WinForms/WebView2 desktop host, vanilla JavaScript/CSS/HTML, PowerShell verification scripts.

**Spec:** `docs/superpowers/specs/2026-11-09-hybrid-agent-runs-design.md`

## Global Constraints

- Keep every application and assembly version at `1.0.0`; do not increment the version.
- Work only with already running Codex and Cursor clients; never automate or launch their windows.
- Provider affinity is mandatory; `unknown` cannot register, claim, start, progress, complete, or fail tasks.
- One `project-write` task per project may run at a time; read/review tasks may run concurrently.
- Existing skills, projects, agents, handoffs, audit, static route, imports, and migrations remain backward compatible.
- The directory is not a Git repository; do not initialize Git or add commit steps without user authorization.

## Review Focus

- Two MCP processes claim the same task simultaneously: exactly one receives the lease and the registry stays valid.
- Cursor is offline while its task is ready: the task remains queued/waiting and Codex never substitutes itself.
- A worker completes after pause/cancel or lease expiry: scheduler state is unchanged and an orphaned attempt is audited.
- Desktop and MCP write the registry concurrently: revision/lock handling prevents lost updates and temp-file collisions.
- A cyclic or out-of-scope Task Manager plan is rejected without partially creating runnable tasks.

---

### Task 1: Registry run model and migration

**Files:**
- Modify: `app.js`
- Modify: `mcp-server/Program.cs`
- Create: `tools/verify-agent-run-registry.ps1`

**Interfaces:**
- Consumes: existing registry-v2 normalization and persistence.
- Produces: normalized `agentRuns`, `runTasks`, `runArtifacts`, `registryRevision`; JavaScript normalizers `normalizeAgentRun`, `normalizeRunTask`, `normalizeRunArtifact`.

- [ ] **Step 1: Write the failing registry verification**

Create `tools/verify-agent-run-registry.ps1` to start the MCP server against a temporary minimal registry, call a read operation, and assert that missing run collections normalize to empty arrays without changing the version.

- [ ] **Step 2: Run the verification and confirm failure**

Run: `pwsh -NoProfile -File tools/verify-agent-run-registry.ps1`

Expected: FAIL because the run collections and revision are absent.

- [ ] **Step 3: Implement registry normalization**

Add the run collections and revision to `freshRegistry`, `normalizeRegistry`, snapshot/import/merge/signature paths in `app.js`, and equivalent MCP load normalization in `Program.cs`.

- [ ] **Step 4: Run verification**

Expected: PASS and server/app version remains `1.0.0`.

### Task 2: Atomic scheduler and plan validation

**Files:**
- Modify: `mcp-server/Program.cs`
- Create: `tools/verify-agent-run-scheduler.ps1`

**Interfaces:**
- Consumes: normalized run collections from Task 1.
- Produces: MCP tools `create_agent_run`, `list_agent_runs`, `get_agent_run`, `submit_agent_run_plan`, `pause_agent_run`, `resume_agent_run`, `cancel_agent_run`; atomic registry mutation helper guarded by interprocess lock and revision.

- [ ] **Step 1: Write failing scheduler scenarios**

The script asserts: a run starts in `planning`; only the assigned Codex Task Manager may submit a plan; valid dependencies become queued/blocked; duplicate IDs, missing agents, cycles, excessive plans, and workspace paths outside the project are rejected atomically.

- [ ] **Step 2: Confirm the tools are missing**

Run: `pwsh -NoProfile -File tools/verify-agent-run-scheduler.ps1`

Expected: FAIL with an unknown-tool response.

- [ ] **Step 3: Implement atomic mutation and strict plan schema**

Add tool declarations and handlers. Validate unique IDs, project agent membership, provider equality, dependency DAG, bounded strings/arrays, capabilities, and derived `workspaceMode`. Store a bounded request summary/hash by default.

- [ ] **Step 4: Implement pause/resume/cancel state transitions**

Pause prevents new claims; resume recomputes ready tasks; cancel marks non-terminal tasks cancelled and rejects late state changes.

- [ ] **Step 5: Run scheduler verification**

Expected: PASS for valid plans and all rejection cases.

### Task 3: Runtime registration, leasing, and worker cycle

**Files:**
- Modify: `mcp-server/Program.cs`
- Modify: `docs/CURSOR-MCP.md`
- Create: `docs/WORKER-MODE.md`
- Create: `tools/verify-agent-run-worker.ps1`

**Interfaces:**
- Consumes: Task 2 scheduler state.
- Produces: `register_agent_runtime`, `heartbeat_agent_runtime`, `claim_agent_run_task`, `start_agent_run_task`, `record_agent_run_progress`, `complete_agent_run_task`, `fail_agent_run_task`; prompt/instructions for one-time Codex/Cursor worker activation.

- [ ] **Step 1: Write failing provider and lease scenarios**

Assert provider isolation, single atomic claim, unique lease token, one project writer, concurrent read claims, heartbeat/stale status, idempotent completion, retryable failure, lease expiry, and orphaned late completion.

- [ ] **Step 2: Confirm failure before handlers exist**

Run: `pwsh -NoProfile -File tools/verify-agent-run-worker.ps1`

- [ ] **Step 3: Implement runtime and claim tools**

Keep heartbeat state in `data/runtime-state.json`; use a separate interprocess lock and unique temp file. Derive runtime readiness from `lastSeenAt` and reject `unknown` providers.

- [ ] **Step 4: Link context, handoff, outcome, and artifacts**

Add optional `runId`, `taskId`, and `handoffId` to existing tools. Validate artifact canonical paths inside the project root and record automatic audit events.

- [ ] **Step 5: Document one-time worker activation**

Document the exact provider loop: register, claim, resolve context, start, progress, outcome, complete/fail, then claim again until the queue is empty. State clearly that an idle client is not ready until this loop is activated.

- [ ] **Step 6: Run worker verification**

Expected: all provider, concurrency, lease, and cancellation scenarios PASS.

### Task 4: Desktop run controls and deterministic swimlane layout

**Files:**
- Modify: `index.html`
- Modify: `app.js`
- Modify: `styles.css`
- Create: `tools/verify-agent-run-ui.mjs`

**Interfaces:**
- Consumes: `agentRuns`, `runTasks`, runtime status, agents, projects.
- Produces: `execution` agent view; pure functions `tasksForRun(runId)`, `computeRunDepths(tasks)`, `buildSwimlaneLayout(run, tasks, agents)`, `runProgress(runId)`.

- [ ] **Step 1: Write failing static/pure UI checks**

Use Node built-ins to assert that sequential tasks receive increasing depth, parallel tasks share depth in separate lanes, cycles render an error state, completed node coordinates remain stable, and the execution mode/control labels exist.

- [ ] **Step 2: Confirm UI verification fails**

Run: `node tools/verify-agent-run-ui.mjs`

- [ ] **Step 3: Add execution mode and controls**

Add an `Исполнение` tab, project/run selectors, task field, start, pause/resume/cancel actions, progress count, and Codex/Cursor readiness indicators. Use existing button, field, custom-select, and toolbar styles.

- [ ] **Step 4: Implement the swimlane graph**

Render one lane per assigned agent and one depth column per dependency level. Draw dependency edges beneath nodes; support horizontal scrolling/panning, zoom, keyboard node selection, and `Показать текущий этап`. Do not rearrange terminal nodes during refresh.

- [ ] **Step 5: Add task inspector state**

Selecting a node shows provider, runtime, dependencies, skills, progress, attempts, artifacts, handoffs, and errors in the right inspector; leaving execution restores the skill inspector.

- [ ] **Step 6: Run UI verification**

Expected: PASS at 320px-equivalent constrained layout checks and standard desktop markup checks.

### Task 5: Desktop persistence, recovery, and packaging integration

**Files:**
- Modify: `desktop-native/MainForm.cs`
- Modify: `app.js`
- Modify: `docs/ROADMAP.md`
- Create: `tools/verify-agent-run-recovery.ps1`

**Interfaces:**
- Consumes: registry revision/locks and runtime-state file.
- Produces: restart recovery, stale lease reconciliation, external update refresh, active-run project deletion guard.

- [ ] **Step 1: Write failing recovery verification**

Assert that a queued run survives desktop/MCP restart, stale claims are returned safely, completed nodes remain immutable, and a project with a non-terminal run cannot be deleted.

- [ ] **Step 2: Implement recovery and deletion guard**

Reconcile stale leases during MCP mutations/startup reads, refresh the UI on external run updates, and require cancel/complete before project deletion.

- [ ] **Step 3: Update ROADMAP**

Record the hybrid worker/swimlane feature as implemented without changing the version heading or package version.

- [ ] **Step 4: Run recovery verification**

Expected: PASS across a stopped/restarted MCP process.

### Task 6: Whole-product verification and republish

**Files:**
- Modify only if verification finds a defect: files from Tasks 1–5.
- Update: existing portable output directory and desktop copy using the established packaging workflow.

**Interfaces:**
- Consumes: completed implementation.
- Produces: verified desktop package with unchanged version `1.0.0`.

- [ ] **Step 1: Run all focused checks**

Run:

```powershell
pwsh -NoProfile -File tools/verify-agent-run-registry.ps1
pwsh -NoProfile -File tools/verify-agent-run-scheduler.ps1
pwsh -NoProfile -File tools/verify-agent-run-worker.ps1
node tools/verify-agent-run-ui.mjs
pwsh -NoProfile -File tools/verify-agent-run-recovery.ps1
dotnet build mcp-server/SkillGraph.Mcp.csproj -c Release
dotnet build desktop-native/SkillGraph.Desktop.Offline.csproj -c Release
```

Expected: all scripts PASS and both builds succeed with version `1.0.0`.

- [ ] **Step 2: Perform desktop smoke test**

Verify: create run, Codex planning task, parallel Cursor queue, offline waiting state, worker activation, progress updates, failed/retried review, pause/resume/cancel, restart recovery, and task inspector.

- [ ] **Step 3: Republish without version increment**

Use the existing portable preparation/package scripts, replace the current desktop package and desktop folder, and confirm no background MCP/worker process keeps the output directory locked.

- [ ] **Step 4: Record final SkillGraph outcome**

Record success/failure and verification summary without storing the original task text.
