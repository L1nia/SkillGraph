# Hybrid Agent Runs and Swimlane Router

## Intent

SkillGraph should turn a user task into a visible, resumable chain of work across
the already running Codex and Cursor clients. The Task Manager remains a Codex
agent. It decomposes the request into a dependency graph, while provider workers
claim only tasks assigned to their own provider. SkillGraph owns orchestration,
status, handoffs, audit, and the final workspace path; it does not automate or
launch the Codex or Cursor desktop applications.

## Goals

- Start one project run from the SkillGraph desktop UI.
- Ask the Codex Task Manager for a bounded DAG of tasks and agent assignments.
- Let connected Codex and Cursor workers claim ready tasks from the MCP queue.
- Support sequential and parallel branches with dependency checks and cycle
  prevention.
- Display live progress as a horizontal swimlane graph grouped by agent.
- Persist all run state in the registry so a desktop restart does not lose work.
- Reuse the existing provider-affinity, handoff, context, audit, and permission
  checks.
- Keep the current application version unchanged.

## Non-goals

- Launching, focusing, or automating Codex or Cursor windows.
- Bypassing provider confirmations or granting new filesystem permissions.
- Remote workers, authentication, or multi-user collaboration.
- Automatic merge conflict resolution between simultaneous writers.
- Replacing the existing static skill-route view; it remains useful for
  inspecting which skills an agent can receive.

## Chosen approach

Use a hybrid pull-based orchestrator. SkillGraph stores runs and schedules ready
nodes. Already running provider clients poll their own queue through MCP, claim a
task with a lease, resolve agent context, report progress, and complete or fail
the node. This preserves provider separation and avoids brittle UI automation.

Two alternatives were rejected:

1. **MCP handoffs only.** Safe and already implemented, but not a complete run:
   no DAG, no dependency scheduling, and no unified progress view.
2. **SkillGraph launches provider applications.** More autonomous, but tightly
   coupled to vendor-specific UI/CLI behavior and conflicts with the requirement
   to work with already running clients.

## Domain model

### `agentRuns`

Each record represents one user-visible execution:

- `id`, `projectId`, `title`, `request`, `workspacePath`;
- `status`: `draft`, `planning`, `running`, `waiting`, `reviewing`,
  `completed`, `failed`, `cancelled`;
- `taskManagerAgentId`, `createdAt`, `startedAt`, `updatedAt`, `finishedAt`;
- `createdByProvider`, `summary`, `error`;
- `planRevision` for safe Task Manager replanning.

### `runTasks`

Each node belongs to one run:

- `id`, `runId`, `title`, `instructions`, `agentId`, `provider`;
- `dependsOn[]`, `status`, `priority`, `attempt`, `maxAttempts`;
- `leaseOwner`, `leaseToken`, `leaseExpiresAt`;
- `progress`, `progressMessage`, `result`, `error`;
- `createdAt`, `startedAt`, `updatedAt`, `finishedAt`;
- `handoffIds[]`, `artifactIds[]`.

Task statuses are `blocked`, `queued`, `claimed`, `running`, `waiting`,
`review`, `completed`, `failed`, and `cancelled`. A node becomes `queued` only
when every dependency is `completed`. A failed dependency leaves descendants
blocked until the Task Manager retries, replaces, or cancels the branch.

### `runArtifacts`

Artifacts link execution to the project without copying file contents into the
registry:

- `id`, `runId`, `taskId`, `path`, `kind`, `operation`, `hash`, `createdAt`.

Paths must resolve inside the connected project workspace. Hashes make repeated
reports idempotent and allow the review stage to identify changed outputs.

### `runtimeSessions`

Runtime sessions represent already running clients:

- `id`, `provider`, `clientName`, `status`, `capabilities[]`;
- `connectedAt`, `lastSeenAt`, `maxParallelTasks`, `activeTaskIds[]`.

Sessions are ephemeral. A missing heartbeat marks a runtime offline but does not
delete or fail its queued tasks.

## Orchestration flow

1. The user chooses a connected project, enters a task, and presses
   `Запустить цепочку`.
2. SkillGraph creates a run in `planning` and queues a Task Manager planning
   node for the Codex provider.
3. A connected Codex worker claims the planning node and returns a plan through
   `submit_agent_run_plan`.
4. SkillGraph validates agent assignments, provider affinity, permissions,
   dependencies, cycles, and workspace scope.
5. Valid root tasks become `queued`; dependent tasks remain `blocked`.
6. Each provider calls `claim_agent_run_task`. Only tasks matching its provider
   and available capacity are returned.
7. The worker resolves agent context, changes the node to `running`, reports
   bounded progress, creates handoffs/artifact references, and records outcome.
8. Completion atomically queues newly unblocked descendants.
9. Review failure creates a structured change request. The Task Manager may
   increment `planRevision` and append replacement nodes without mutating
   completed history.
10. The run becomes `completed` only when all terminal nodes succeed and the
    Task Manager records a final summary.

Agents do not directly start other agents. They request a handoff or plan change;
the SkillGraph scheduler remains the sole authority that changes queue state.

## MCP additions

- `register_agent_runtime(provider, clientName, capabilities,
  maxParallelTasks)`
- `heartbeat_agent_runtime(sessionId, activeTaskIds)`
- `create_agent_run(projectId, taskManagerAgentId, title, request)`
- `list_agent_runs(projectId, status?)`
- `get_agent_run(runId)`
- `submit_agent_run_plan(runId, planRevision, tasks[])`
- `claim_agent_run_task(sessionId)`
- `start_agent_run_task(taskId, leaseToken)`
- `record_agent_run_progress(taskId, leaseToken, progress, message)`
- `complete_agent_run_task(taskId, leaseToken, result, artifacts[])`
- `fail_agent_run_task(taskId, leaseToken, error, retryable)`
- `pause_agent_run(runId)` / `resume_agent_run(runId)`
- `cancel_agent_run(runId)`

All mutating calls append audit events automatically. Existing
`resolve_agent_context`, `create_agent_handoff`, and `record_agent_outcome`
remain valid and gain optional `runId` and `taskId` links.

## Provider worker behavior

- Codex and Cursor keep separate MCP configurations with explicit
  `--client-provider` values.
- A worker registers after its provider client starts and uses a lightweight
  polling interval while SkillGraph is available.
- Claims are leases, not permanent ownership. An expired claim returns to the
  queue only if no completion event was recorded.
- A worker cannot claim another provider's task even if it has the same agent
  skills.
- An offline provider appears as `Ожидает Cursor` or `Ожидает Codex`; SkillGraph
  never silently substitutes another provider.

An ordinary stdio MCP connection is request-driven and cannot wake an idle
provider client. Therefore the execution design requires one explicit worker
mechanism before product implementation begins: an in-client connector, a
companion process using a supported provider API/CLI, or a user-started agent
loop. Merely detecting that the Codex or Cursor window is open is not sufficient
and must never be displayed as an execution-ready runtime.

## Workspace and concurrency

The first implementation uses one writable task at a time for a project. Read,
research, and review tasks may run in parallel. This conservative lock prevents
two provider clients from overwriting the same files.

Each write node declares `workspaceMode: project-write`. SkillGraph holds the
project write lease until completion or expiry. Later versions may add Git
worktrees and parallel write branches, but that is outside this change.

## Router UI

Add an `Исполнение` mode beside the existing static route. The header contains:

- project selector;
- run selector;
- task input and `Запустить цепочку`;
- `Пауза`, `Продолжить`, and `Остановить`;
- compact progress: completed tasks / total tasks;
- runtime indicators for Codex and Cursor.

The graph is a horizontal swimlane:

- one lane per assigned agent, ordered by first appearance in the plan;
- x-axis represents dependency depth from start to final result;
- parallel tasks share a depth column and occupy their agent lanes;
- curved edges show dependencies and handoffs;
- a node label shows task title, provider, progress, and elapsed time;
- selecting a node opens its details in the existing inspector.

Node states use the existing restrained visual language:

- neutral: blocked;
- purple: queued/claimed;
- blue with reduced-motion-safe activity indicator: running;
- yellow: waiting for runtime, answer, or approval;
- green: completed;
- red: failed;
- muted strike: cancelled.

The graph supports horizontal pan/scroll, zoom, keyboard selection, and a
`Показать текущий этап` action. It must not continuously rearrange completed
nodes. Layout positions are derived from dependency depth and agent lane, then
persisted per run.

## Inspector

For a selected task show:

- task, agent, assigned provider, and actual runtime session;
- dependencies and dependants;
- resolved skills;
- current status and progress message;
- handoffs, artifacts, timestamps, attempts, and errors;
- actions permitted for the current state: retry, reassign, pause, cancel.

Reassignment requires explicit user confirmation when it changes provider or
write permissions.

## Persistence and recovery

- Extend registry normalization with empty arrays for new collections.
- Keep the schema backward compatible with existing `registry-v2` data.
- Debounce desktop persistence, but write task transitions atomically in the MCP
  server.
- On startup, expire stale leases, preserve completed tasks, and resume queued
  work when the matching runtime reconnects.
- Never clear a run because the desktop application or MCP process closed.
- Protect every registry read-modify-write sequence with one interprocess lock,
  a monotonically increasing revision, and unique temporary files. Claim and
  task transition writes are atomic and reject stale revisions.
- Keep high-frequency runtime heartbeat state in a small separate runtime-state
  file. Do not create a full registry backup for every heartbeat.
- The scheduler is transaction logic invoked by UI/MCP operations in the first
  implementation, not an additional always-running daemon.
- Extend registry normalization, signatures, import/export, and merge behavior
  for all run collections so external MCP updates become visible in the UI.

## Security

- Reuse agent project assignments, permissions, trusted-source policy, and
  provider affinity.
- Validate all artifact paths against the canonical project root.
- Store bounded summaries rather than full provider prompts by default.
- Do not treat runtime registration as permission to write.
- Pause a run when a task requires capability or permission unavailable to the
  assigned runtime.
- Reject runtime and run execution tools when the MCP client provider is
  `unknown`.
- Validate `workspaceMode` from agent permissions and runtime capabilities;
  never trust the value supplied by a Task Manager plan.
- Store the full task request only when local history is explicitly enabled.
  The default persisted record contains a title, bounded summary, and hash.

## Plan and transition invariants

- Task Manager plans use a strict bounded JSON schema with unique task IDs,
  existing project agent IDs, known providers, explicit dependencies,
  capabilities, and size limits.
- `claim` is atomic and returns a unique lease token plus idempotency key.
- Completion and failure require the current lease token and are idempotent.
- `resolve_agent_context` receives explicit `runId`, `taskId`, and optional
  `handoffId`; run execution never matches a pending handoff by task text.
- Pause and cancel are cooperative. A late completion from a cancelled lease is
  stored as an orphaned attempt for audit and does not change scheduler state.
- A project with a non-terminal run cannot be deleted until that run is
  cancelled or completed.
- The existing skill inspector remains unchanged. Selecting a run node switches
  the right panel to a dedicated task inspector and restores the prior skill
  inspector when the execution view closes.

## Testing seams

The primary seam is the scheduler state machine through MCP calls. Tests should
cover externally visible transitions rather than rendering internals:

- valid and cyclic plans;
- provider-specific claims;
- parallel read tasks and serialized write tasks;
- lease expiry and idempotent completion;
- dependency unblocking and failure propagation;
- pause, resume, cancel, retry, and restart recovery;
- handoff/audit links to run and task;
- registry migration with no run collections;
- swimlane layout for sequential, parallel, and reconnecting tasks;
- keyboard navigation and narrow-window overflow;
- version value remains unchanged.

## Delivery order

1. Registry model and scheduler state machine.
2. MCP runtime, run, plan, claim, progress, and completion tools.
3. Runtime polling contract for already running Codex and Cursor.
4. Run controls and swimlane graph.
5. Inspector details, pause/retry/cancel, and recovery.
6. Automated tests, package verification, and desktop republish without a
   version increment.

## Success criteria

- A task entered once in SkillGraph is planned by the Codex Task Manager.
- Ready Cursor tasks are claimed by an already connected Cursor runtime without
  manual handoff creation.
- The UI distinguishes assigned provider, actual provider, offline waiting, and
  active execution.
- Parallel branches and dependencies are visible and survive restart.
- The final result is written only inside the connected project directory.
- Existing registry, skill graph, handoff, audit, and static route features keep
  working.
- The packaged application reports the same version as before this change.
