import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const layout = require(path.join(root, 'agent-run-layout.js'));

const tasks = [
  { id: 'plan', agentId: 'task-agent', status: 'completed', dependsOn: [] },
  { id: 'api', agentId: 'api-agent', status: 'running', dependsOn: ['plan'] },
  { id: 'ui', agentId: 'ui-agent', status: 'queued', dependsOn: ['plan'] },
  { id: 'review', agentId: 'review-agent', status: 'blocked', dependsOn: ['api', 'ui'] }
];
const depths = layout.computeRunDepths(tasks);
assert.equal(depths.plan, 0, 'root depth');
assert.equal(depths.api, 1, 'first branch depth');
assert.equal(depths.ui, 1, 'parallel branch shares depth');
assert.equal(depths.review, 2, 'join follows deepest dependency');

const agents = [
  { id: 'task-agent', name: 'Task Manager', color: '#d4ff00' },
  { id: 'api-agent', name: 'API', color: '#4f9dde' },
  { id: 'ui-agent', name: 'Frontend', color: '#8b6dde' },
  { id: 'review-agent', name: 'Review', color: '#e6a85c' }
];
const graph = layout.buildSwimlaneLayout({ id: 'run-1' }, tasks, agents);
assert.equal(graph.lanes.length, 4, 'one lane per participating agent');
assert.equal(graph.nodes.find(node => node.id === 'api').x, graph.nodes.find(node => node.id === 'ui').x, 'parallel nodes align');
assert.ok(graph.edges.some(edge => edge.from === 'api' && edge.to === 'review'), 'dependency edge exists');
assert.deepEqual(layout.runProgress(tasks), { completed: 1, total: 4, percent: 25 }, 'progress uses terminal completion');
assert.equal(layout.currentRunTask(tasks)?.id, 'api', 'running task is the current graph target');
assert.equal(layout.nextRunTaskAfterCompletion(tasks, { plan: 'running', api: 'running', ui: 'queued', review: 'blocked' })?.id, 'api', 'completion advances focus to the active task');
assert.equal(layout.nextRunTaskAfterCompletion(tasks, { plan: 'completed', api: 'running', ui: 'queued', review: 'blocked' }), null, 'unchanged completion does not move the viewport again');
assert.throws(() => layout.computeRunDepths([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]), /cycle/i, 'cycles must be rejected');

const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
assert.match(index, /data-agent-mode="execution"/, 'execution tab exists');
assert.match(app, /function renderAgentExecution\(/, 'execution renderer exists');
assert.match(app, /Запустить цепочку/, 'run action exists');
assert.match(app, /Показать текущий этап/, 'focus-current action exists');
assert.match(app, /runViewportById/, 'execution viewport is persisted per run');
assert.match(app, /nextRunTaskAfterCompletion/, 'execution advances to the next task after completion');
assert.match(app, /deleteAgentRun/, 'terminal run delete action exists');
assert.match(app, /Удалить выбранную цепочку/, 'run delete action is accessible');
assert.match(app, /supportedProviders = \['codex', 'cursor', 'claude', 'copilot', 'deepseek', 'qwen', 'local', 'custom'\]/, 'all supported AI providers share one connection contract');
assert.match(styles, /\.agent-list-row \{[^}]*background:color-mix\(in srgb,var\(--accent\) 18%/s, 'agent cards use the application purple palette');
assert.match(styles, /\.agent-list-row\.active \{ background:color-mix\(in srgb,var\(--accent\) 36%/, 'selected agent uses a stronger application purple');
assert.match(styles, /\.run-swimlane/, 'swimlane styles exist');
assert.match(styles, /@media[^}]*max-width/s, 'narrow layout rules exist');
console.log('PASS deterministic swimlane layout and execution UI contract');
