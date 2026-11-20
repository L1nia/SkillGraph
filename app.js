const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const escapeRegex = value => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const slugify = value => String(value ?? '').toLowerCase().trim().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-|-$/g, '') || `skill-${Date.now()}`;
const splitList = value => String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);
const freshRegistry = () => ({ schema: 'skillgraph/registry-v2', updatedAt: new Date().toISOString(), registryRevision: 0, skills: [], projects: [], agents: [], handoffs: [], agentRuns: [], runTasks: [], runArtifacts: [], auditLog: [], evaluations: [], sources: [], groups: [], settings: { theme: 'dark' } });
const demoIds = new Set(['react-frontend', 'typescript-base', 'api-contracts', 'frontend-testing', 'accessibility-review', 'web-development', 'ui-architecture', 'security-review']);
const GRAPH_VIEW_WIDTH = 1200;
const GRAPH_VIEW_HEIGHT = 800;
const GRAPH_WORKSPACE_MARGIN = 2400;
const desktopHostExpected = new URLSearchParams(window.location.search).get('desktop') === '1';

let state = freshRegistry();
let desktopRuntime = false;
let activeSkillId = null;
let openSkillTabs = [];
let currentView = 'workspace';
let activeProjectId = null;
let activeAgentId = null;
let agentViewMode = 'profiles';
let tabSessionTimer = null;
let savedEditorValue = '';
let dirty = false;
let graphTransform = { scale: 1, x: 0, y: 0 };
let graphDragging = null;
let graphContextSkillId = null;
let linkMode = { active: false, source: null };
let graphClickTimer = null;
let lastGraphPointer = { id: null, at: 0 };
let nodeDragging = null;
let graphNodeMovedUntil = 0;
const supportedProviders = ['codex', 'cursor', 'claude', 'copilot', 'deepseek', 'qwen', 'local', 'custom'];
let integrationStatus = Object.fromEntries(supportedProviders.flatMap(provider => [[provider, false], [`${provider}Status`, null]]));
let lastRegistrySignature = '';
let registryRefreshInFlight = false;
let registryScope = 'global';
let undoStack = [];
let redoStack = [];
let lastPersistedSnapshot = null;
let applyingHistory = false;
let bindingCandidates = [];
let pendingRegistryImport = null;
let remoteSourceSyncing = false;
let editingSkillGroupId = null;
let pendingAgentRootSkills = new Set();
let routingTask = '';
let activeRunId = null;
let selectedRunTaskId = null;
let runtimeSessions = [];
let runtimeStateSignature = '';
let runGraphScale = 1;
let compactLayoutActive = window.innerWidth <= 760;
let navigatorDockTimer = null;
let workspaceTabsScrollLeft = 0;
let agentModeTabsScrollLeft = 0;
let executionDocumentScrollTop = 0;
const runViewportById = new Map();
const runDetailScrollByTaskId = new Map();
const runTaskStatusesByRun = new Map();
let pendingRunAutoFocus = null;

const editor = $('#sourceEditor');
const gutter = $('#editorGutter');
const preview = $('#markdownPreview');
const shell = $('.app-shell');

function activeSkill() { return state.skills.find(skill => skill.id === activeSkillId) ?? null; }
function activeProject() { return state.projects.find(project => project.id === activeProjectId) ?? null; }
function activeAgent() { return state.agents.find(agent => agent.id === activeAgentId) ?? null; }
function cloneRegistry(registry = state) { return JSON.parse(JSON.stringify(registry)); }
function visibleSkills() {
  const project = activeProject();
  if (registryScope !== 'project' || !project) return state.skills;
  const ids = new Set(resolveProject(project).order.map(skill => skill.id));
  return state.skills.filter(skill => ids.has(skill.id));
}
function skillName(skill) { return skill.name || skill.title || skill.id || 'Без имени'; }
function skillIcon(skill) { return (skill.icon || skillName(skill) || '?').replace(/[^a-z0-9а-яё]/gi, '').slice(0, 3).toUpperCase() || '?'; }
function connectionCountLabel(count) {
  const value = Math.abs(Number(count) || 0);
  const lastTwo = value % 100;
  const last = value % 10;
  const word = lastTwo >= 11 && lastTwo <= 14 ? 'связей' : last === 1 ? 'связь' : last >= 2 && last <= 4 ? 'связи' : 'связей';
  return `${count} ${word}`;
}
function syncThemeToggle() {
  const toggle = $('#themeToggle');
  if (!toggle) return;
  const dark = document.documentElement.dataset.theme === 'dark';
  const label = dark ? 'Тёмная тема' : 'Светлая тема';
  toggle.title = label;
  toggle.setAttribute('aria-label', label);
  toggle.querySelector('use')?.setAttribute('href', dark ? '#i-moon' : '#i-sun');
}
function allImages() { return state.skills.flatMap(skill => (skill.images || []).map(image => ({ ...image, skillId: skill.id }))); }
function findImage(id) { return allImages().find(image => image.id === id) || null; }
function imageAssetUrl(image) {
  if (!image) return '';
  if (image.url) return image.url;
  const relativePath = String(image.relativePath || '').replace(/\\/g, '/');
  return relativePath ? `https://skillgraph-assets.local/${relativePath.split('/').map(encodeURIComponent).join('/')}` : '';
}
function dependency(id, type, range = '*') { return { id: cleanReference(id), type, range: range || '*' }; }
function cleanReference(value) {
  return String(value ?? '').trim().replace(/^skill:\/\//, '').split('@')[0].split('.').at(-1);
}

function uniqueSkillId(preferred, excludedId = null) {
  const base = slugify(preferred);
  let candidate = base;
  let suffix = 2;
  while (state.skills.some(skill => skill.id === candidate && skill.id !== excludedId)) candidate = `${base}-${suffix++}`;
  return candidate;
}

function replaceFrontmatterValue(content, key, value) {
  const line = new RegExp(`^${key}:\\s*.*$`, 'mi');
  if (line.test(content)) return content.replace(line, `${key}: ${value}`);
  return content.replace(/^---\s*\r?\n/, `---\n${key}: ${value}\n`);
}

function remapSkillId(oldId, nextId) {
  const escaped = oldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  state.skills.forEach(item => {
    item.deps.forEach(dep => { if (dep.id === oldId) dep.id = nextId; });
    item.content = item.content
      .replace(new RegExp(`(skill:\\/\\/[^\\s@]*\\.)${escaped}(?=@)`, 'g'), `$1${nextId}`)
      .replace(new RegExp(`(skill:\\/\\/)${escaped}(?=@)`, 'g'), `$1${nextId}`);
  });
  state.projects.forEach(project => { project.roots = project.roots.map(id => id === oldId ? nextId : id); });
  if (state.settings.graphPositions?.[oldId]) {
    state.settings.graphPositions[nextId] = state.settings.graphPositions[oldId];
    delete state.settings.graphPositions[oldId];
  }
  openSkillTabs = openSkillTabs.map(id => id === oldId ? nextId : id);
}

function replaceFrontmatterList(content, key, rows) {
  const block = `${key}:\n${rows.length ? rows.map(row => `  - ${row}`).join('\n') : '  []'}\n\n`;
  const pattern = new RegExp(`^${key}:\\s*(?:\\r?\\n)?[\\s\\S]*?(?=^(?:requires|extends|recommends|tags|permissions):|^---$)`, 'mi');
  return pattern.test(content) ? content.replace(pattern, block) : content;
}

function syncSkillDependenciesToContent(skill) {
  ['requires', 'extends', 'recommends'].forEach(type => {
    const rows = skill.deps.filter(dep => dep.type === type).map(dep => {
      const target = state.skills.find(item => item.id === dep.id);
      return `skill://${target?.namespace || 'local'}.${dep.id}@${dep.range || '*'}`;
    });
    skill.content = replaceFrontmatterList(skill.content, type, rows);
  });
}

function skillTemplate(skill) {
  const dependencyBlock = type => {
    const rows = skill.deps.filter(item => item.type === type).map(item => {
      const target = state.skills.find(candidate => candidate.id === item.id);
      return `  - skill://${target?.namespace || 'local'}.${item.id}@${item.range}`;
    });
    return rows.length ? rows.join('\n') : '  []';
  };
  return `---
schema: skillgraph/v1
id: ${skill.namespace}.${skill.id}
version: ${skill.version}
name: ${skill.name}
title: ${skill.title}
status: ${skill.status || 'draft'}

requires:
${dependencyBlock('requires')}

extends:
${dependencyBlock('extends')}

recommends:
${dependencyBlock('recommends')}

tags:
${skill.tags.length ? skill.tags.map(tag => `  - ${tag}`).join('\n') : '  []'}
---

# ${skill.name}

## Назначение

${skill.description || 'Опишите назначение скилла.'}

## Правила

1. Добавьте правила и инструкции скилла.

## Критерии готовности

- [ ] Результат проверен.
`;
}

function scalar(frontmatter, key, fallback = '') {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'mi'));
  return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : fallback;
}

function parseFrontmatter(content) {
  const match = String(content).match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = match?.[1] ?? '';
  const body = match ? String(content).slice(match[0].length).trim() : String(content).trim();
  const rawId = scalar(frontmatter, 'id');
  const fullId = rawId.replace(/^skill:\/\//, '').split('@')[0];
  const parts = fullId.split('.');
  const id = cleanReference(fullId);
  const namespace = parts.length > 1 ? parts.slice(0, -1).join('.') : scalar(frontmatter, 'namespace', 'local');
  const list = key => {
    const section = frontmatter.match(new RegExp(`^${key}:\\s*(?:\\r?\\n)?([\\s\\S]*?)(?=^[a-z][a-z0-9_-]*:|$)`, 'mi'))?.[1] ?? '';
    return [...section.matchAll(/^\s*-\s*(.+)$/gm)].map(item => item[1].trim());
  };
  const deps = ['requires', 'extends', 'recommends'].flatMap(type => list(type).map(item => {
    const clean = item.replace(/^skill:\/\//, '');
    const [name, range = '*'] = clean.split('@');
    return dependency(name, type, range);
  }));
  const tags = list('tags').map(tag => tag.replace(/^['"]|['"]$/g, ''));
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const description = body.match(/##\s+Назначение\s+([\s\S]*?)(?=\n##|$)/i)?.[1]?.trim() ?? '';
  const title = scalar(frontmatter, 'title', heading || id);
  return { id, namespace, name: scalar(frontmatter, 'name', title), title, version: scalar(frontmatter, 'version', '0.1.0'), status: scalar(frontmatter, 'status', 'draft'), tags, deps, description };
}

function normalizeImage(raw) {
  const relativePath = String(raw?.relativePath || '').replace(/\\/g, '/');
  return {
    id: raw?.id || `image-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: raw?.name || 'Изображение',
    caption: raw?.caption || raw?.name || 'Изображение',
    path: raw?.path || '',
    relativePath,
    url: raw?.url || (relativePath ? `https://skillgraph-assets.local/${encodeURIComponent(relativePath)}` : ''),
    relation: 'extends',
    createdAt: raw?.createdAt || new Date().toISOString()
  };
}

function normalizeSkill(raw, fallbackId = '') {
  const parsed = raw.content ? parseFrontmatter(raw.content) : {};
  const id = raw.id || parsed.id || fallbackId || `skill-${Date.now()}`;
  const skill = {
    id: slugify(id),
    namespace: raw.namespace || parsed.namespace || 'local',
    name: raw.name || parsed.name || raw.title || parsed.title || id,
    title: raw.title || parsed.title || id,
    version: raw.version || parsed.version || '0.1.0',
    status: raw.status || parsed.status || 'draft',
    description: raw.description || parsed.description || '',
    tags: Array.isArray(raw.tags) ? raw.tags : (parsed.tags || []),
    deps: Array.isArray(raw.deps) ? raw.deps.map(item => Array.isArray(item) ? dependency(item[0], item[1], item[2]) : dependency(item.id, item.type, item.range)) : (parsed.deps || []),
    favorite: Boolean(raw.favorite),
    groupId: raw.groupId || '',
    icon: raw.icon || '',
    history: Array.isArray(raw.history) ? raw.history : [],
    images: Array.isArray(raw.images) ? raw.images.map(normalizeImage) : [],
    origin: raw.origin && typeof raw.origin === 'object' ? { ...raw.origin } : null,
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || new Date().toISOString(),
    content: raw.content || ''
  };
  if (!skill.content) skill.content = skillTemplate(skill);
  return skill;
}

function normalizeSource(raw) {
  return {
    id: raw?.id || `source-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: raw?.name || 'Удалённый реестр',
    type: raw?.type || 'git',
    provider: raw?.provider || '',
    endpoint: raw?.endpoint || '',
    branch: raw?.branch || '',
    path: raw?.path || '',
    status: raw?.status || 'configured',
    syncMode: 'remote-read',
    skillIds: Array.isArray(raw?.skillIds) ? raw.skillIds : [],
    lastSyncAt: raw?.lastSyncAt || null,
    lastError: raw?.lastError || '',
    createdAt: raw?.createdAt || new Date().toISOString()
  };
}

function normalizeProject(raw) {
  const candidates = Array.isArray(raw.roots) ? raw.roots : (Array.isArray(raw.skills) ? raw.skills : []);
  const roots = candidates.map(reference => {
    if (typeof reference === 'string') return cleanReference(reference);
    return cleanReference(reference?.skillId || reference?.id || reference?.reference || '');
  }).filter(Boolean);
  return {
    id: raw.id || `project-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: raw.name || 'Без названия',
    location: raw.location || '',
    description: raw.description || '',
    color: /^#[0-9a-f]{6}$/i.test(raw.color || '') ? raw.color : '#8b6dde',
    roots: [...new Set(roots)],
    agentIds: [...new Set((Array.isArray(raw.agentIds) ? raw.agentIds : []).map(String).filter(Boolean))],
    bindingMode: 'reference',
    versionMode: 'follow-registry',
    createdAt: raw.createdAt || new Date().toISOString()
  };
}

function normalizeAgent(raw) {
  const permissions = raw?.permissions || {};
  const roots = (Array.isArray(raw?.rootSkills) ? raw.rootSkills : (Array.isArray(raw?.skills) ? raw.skills : []))
    .map(reference => cleanReference(typeof reference === 'string' ? reference : reference?.id || reference?.skillId || ''))
    .filter(Boolean);
  return {
    id: raw?.id || `agent-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: String(raw?.name || 'Новый агент').trim() || 'Новый агент',
    role: String(raw?.role || 'Без роли').trim() || 'Без роли',
    provider: raw?.provider || 'codex',
    description: String(raw?.description || ''),
    color: /^#[0-9a-f]{6}$/i.test(raw?.color || '') ? raw.color : '#8b6dde',
    status: ['active', 'paused', 'draft'].includes(raw?.status) ? raw.status : 'active',
    rootSkills: [...new Set(roots)],
    permissions: {
      read: permissions.read !== false,
      create: Boolean(permissions.create),
      edit: Boolean(permissions.edit),
      relations: Boolean(permissions.relations),
      delete: Boolean(permissions.delete)
    },
    routing: {
      keywords: [...new Set((Array.isArray(raw?.routing?.keywords) ? raw.routing.keywords : splitList(raw?.routing?.keywords || '')).map(String).filter(Boolean))],
      tags: [...new Set((Array.isArray(raw?.routing?.tags) ? raw.routing.tags : splitList(raw?.routing?.tags || '')).map(String).filter(Boolean))],
      priority: Math.max(0, Math.min(100, Number(raw?.routing?.priority) || 50)),
      fallback: Boolean(raw?.routing?.fallback)
    },
    security: {
      trustedOnly: raw?.security?.trustedOnly !== false,
      allowedSourceIds: [...new Set((Array.isArray(raw?.security?.allowedSourceIds) ? raw.security.allowedSourceIds : []).map(String).filter(Boolean))]
    },
    versionMode: 'follow-registry',
    createdAt: raw?.createdAt || new Date().toISOString(),
    updatedAt: raw?.updatedAt || raw?.createdAt || new Date().toISOString()
  };
}

function normalizeHandoff(raw) {
  return {
    id: raw?.id || `handoff-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    projectId: raw?.projectId || '', fromAgentId: raw?.fromAgentId || '', toAgentId: raw?.toAgentId || '',
    task: String(raw?.task || ''), result: String(raw?.result || ''), questions: String(raw?.questions || ''),
    runId: String(raw?.runId || ''), taskId: String(raw?.taskId || ''),
    skillIds: [...new Set((Array.isArray(raw?.skillIds) ? raw.skillIds : []).map(cleanReference).filter(Boolean))],
    status: ['pending', 'accepted', 'done'].includes(raw?.status) ? raw.status : 'pending',
    createdAt: raw?.createdAt || new Date().toISOString(), updatedAt: raw?.updatedAt || raw?.createdAt || new Date().toISOString()
  };
}

function normalizeAgentRun(raw) {
  const statuses = ['draft', 'planning', 'running', 'waiting', 'reviewing', 'completed', 'failed', 'cancelled', 'paused'];
  return {
    id: raw?.id || `run-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    projectId: raw?.projectId || '', title: String(raw?.title || 'Новый запуск').slice(0, 160),
    requestSummary: String(raw?.requestSummary || raw?.request || '').slice(0, 2000), requestHash: String(raw?.requestHash || ''),
    workspacePath: String(raw?.workspacePath || ''), taskManagerAgentId: raw?.taskManagerAgentId || 'task-agent',
    status: statuses.includes(raw?.status) ? raw.status : 'draft', createdByProvider: String(raw?.createdByProvider || ''),
    planRevision: Math.max(0, Number(raw?.planRevision) || 0), summary: String(raw?.summary || ''), error: String(raw?.error || ''),
    createdAt: raw?.createdAt || new Date().toISOString(), startedAt: raw?.startedAt || null,
    updatedAt: raw?.updatedAt || raw?.createdAt || new Date().toISOString(), finishedAt: raw?.finishedAt || null
  };
}

function normalizeRunTask(raw) {
  const statuses = ['blocked', 'queued', 'claimed', 'running', 'waiting', 'review', 'completed', 'failed', 'cancelled'];
  const workspaceModes = ['read', 'project-write', 'review'];
  return {
    id: raw?.id || `run-task-${Date.now()}-${Math.random().toString(16).slice(2)}`, runId: raw?.runId || '',
    key: String(raw?.key || ''),
    title: String(raw?.title || 'Подзадача').slice(0, 200), instructions: String(raw?.instructions || '').slice(0, 12000),
    agentId: raw?.agentId || '', provider: raw?.provider || '', dependsOn: [...new Set((raw?.dependsOn || []).map(String).filter(Boolean))],
    status: statuses.includes(raw?.status) ? raw.status : 'blocked', priority: Math.max(0, Math.min(100, Number(raw?.priority) || 50)),
    workspaceMode: workspaceModes.includes(raw?.workspaceMode) ? raw.workspaceMode : 'read', capabilities: [...new Set((raw?.capabilities || []).map(String).filter(Boolean))],
    attempt: Math.max(0, Number(raw?.attempt) || 0), maxAttempts: Math.max(1, Math.min(5, Number(raw?.maxAttempts) || 2)),
    leaseOwner: String(raw?.leaseOwner || ''), leaseToken: String(raw?.leaseToken || ''), leaseExpiresAt: raw?.leaseExpiresAt || null,
    progress: Math.max(0, Math.min(100, Number(raw?.progress) || 0)), progressMessage: String(raw?.progressMessage || ''),
    result: String(raw?.result || ''), error: String(raw?.error || ''), handoffIds: [...new Set((raw?.handoffIds || []).map(String).filter(Boolean))],
    artifactIds: [...new Set((raw?.artifactIds || []).map(String).filter(Boolean))], createdAt: raw?.createdAt || new Date().toISOString(),
    startedAt: raw?.startedAt || null, updatedAt: raw?.updatedAt || raw?.createdAt || new Date().toISOString(), finishedAt: raw?.finishedAt || null,
    supersededAt: raw?.supersededAt || null, supersededByRevision: Math.max(0, Number(raw?.supersededByRevision) || 0)
  };
}

function normalizeRunArtifact(raw) {
  return {
    id: raw?.id || `artifact-${Date.now()}-${Math.random().toString(16).slice(2)}`, runId: raw?.runId || '', taskId: raw?.taskId || '',
    path: String(raw?.path || ''), kind: String(raw?.kind || 'file'), operation: String(raw?.operation || 'modified'),
    hash: String(raw?.hash || ''), createdAt: raw?.createdAt || new Date().toISOString()
  };
}

function normalizeAuditEntry(raw) {
  return {
    id: raw?.id || `audit-${Date.now()}-${Math.random().toString(16).slice(2)}`, at: raw?.at || new Date().toISOString(), action: raw?.action || 'event',
    agentId: raw?.agentId || '', projectId: raw?.projectId || '', task: String(raw?.task || ''), skillIds: Array.isArray(raw?.skillIds) ? raw.skillIds : [],
    durationMs: Number(raw?.durationMs) || 0, contextChars: Number(raw?.contextChars) || 0, success: raw?.success !== false, detail: String(raw?.detail || ''),
    requestedProvider: String(raw?.requestedProvider || ''), clientProvider: String(raw?.clientProvider || ''), actualProvider: String(raw?.actualProvider || ''),
    phase: String(raw?.phase || ''), runId: String(raw?.runId || ''), taskId: String(raw?.taskId || '')
  };
}

function normalizeEvaluation(raw) {
  return {
    id: raw?.id || `evaluation-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    projectId: raw?.projectId || '', agentId: raw?.agentId || '', task: String(raw?.task || ''),
    mode: raw?.mode === 'baseline' ? 'baseline' : 'skillgraph', success: raw?.success !== false,
    usefulness: Math.max(1, Math.min(5, Number(raw?.usefulness) || 3)), durationMs: Math.max(0, Number(raw?.durationMs) || 0),
    note: String(raw?.note || ''), createdAt: raw?.createdAt || new Date().toISOString()
  };
}

function normalizeGroup(raw) {
  return {
    id: raw?.id || `group-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: String(raw?.name || 'Новая группа').trim() || 'Новая группа',
    createdAt: raw?.createdAt || new Date().toISOString()
  };
}

function normalizeRegistry(raw) {
  if (!raw || typeof raw !== 'object') return freshRegistry();
  if (raw.schema === 'skillgraph/registry-v1') {
    const customSkills = (raw.skills || []).filter(skill => !demoIds.has(skill.id)).map(skill => normalizeSkill(skill));
    return { ...freshRegistry(), skills: customSkills };
  }
  if (raw.schema !== 'skillgraph/registry-v2') return freshRegistry();
  return { ...freshRegistry(), ...raw, registryRevision: Math.max(0, Number(raw.registryRevision) || 0), skills: (raw.skills || []).map(skill => normalizeSkill(skill)), projects: (raw.projects || []).map(normalizeProject), agents: Array.isArray(raw.agents) ? raw.agents.map(normalizeAgent) : [], handoffs: Array.isArray(raw.handoffs) ? raw.handoffs.map(normalizeHandoff) : [], agentRuns: Array.isArray(raw.agentRuns) ? raw.agentRuns.map(normalizeAgentRun) : [], runTasks: Array.isArray(raw.runTasks) ? raw.runTasks.map(normalizeRunTask) : [], runArtifacts: Array.isArray(raw.runArtifacts) ? raw.runArtifacts.map(normalizeRunArtifact) : [], auditLog: Array.isArray(raw.auditLog) ? raw.auditLog.map(normalizeAuditEntry) : [], evaluations: Array.isArray(raw.evaluations) ? raw.evaluations.map(normalizeEvaluation) : [], sources: Array.isArray(raw.sources) ? raw.sources.map(normalizeSource) : [], groups: Array.isArray(raw.groups) ? raw.groups.map(normalizeGroup) : [], settings: { ...freshRegistry().settings, ...(raw.settings || {}) } };
}

const agentPresetVersion = '1.0.1';

function applyAgentPresetV1(registry) {
  if (registry.settings?.agentPresetVersion === agentPresetVersion) return false;
  const now = new Date().toISOString();
  const seededSkills = [
    {
      id: 'api-integration', namespace: 'local', name: 'API Integration', title: 'API Integration', version: '1.0.0', status: 'stable',
      description: 'Подключение REST, GraphQL и webhook API через явный контракт, безопасную конфигурацию, обработку ошибок и проверяемые тесты.',
      tags: ['api', 'integration', 'rest', 'graphql'],
      deps: [dependency('research', 'requires', '^0.1.0'), dependency('verification-before-completion', 'requires', '^0.1.0'), dependency('codebase-design', 'extends', '^0.1.0'), dependency('systematic-debugging', 'recommends', '^0.1.0')],
      content: `---
schema: skillgraph/v1
id: skill://local.api-integration@1.0.0
name: API Integration
version: 1.0.0
title: API Integration
status: stable
tags:
  - api
  - integration
  - rest
  - graphql
requires:
  - skill://research@^0.1.0
  - skill://verification-before-completion@^0.1.0
extends:
  - skill://codebase-design@^0.1.0
recommends:
  - skill://systematic-debugging@^0.1.0
---

# API Integration

## Назначение

Подключать внешние REST, GraphQL и webhook API без смешивания транспортного кода с бизнес-логикой.

## Порядок работы

1. Зафиксировать контракт, авторизацию, лимиты, таймауты и формат ошибок.
2. Вынести endpoint и секреты в конфигурацию; секреты не хранить в коде и логах.
3. Создать изолированный клиент и типизированные модели запросов и ответов.
4. Добавить отмену, таймаут, ограниченные повторы с backoff и обработку rate limit.
5. Проверить успешный ответ, ошибки авторизации, валидации, сети и деградацию сервиса.
6. Документировать настройку и способ локальной проверки.

## Ограничения

- Не вызывать внешние API из UI-компонентов напрямую.
- Не повторять небезопасные операции без идемпотентности.
- Не выводить токены и персональные данные в логи.

## Готовность

- Контракт и конфигурация описаны.
- Ошибки преобразованы в понятные приложению состояния.
- Интеграционные тесты или воспроизводимая проверка пройдены.`,
      createdAt: now, updatedAt: now
    },
    {
      id: 'git-release-management', namespace: 'local', name: 'Git Release Management', title: 'Git Release Management', version: '1.0.0', status: 'stable',
      description: 'Безопасная подготовка и публикация изменений в GitHub, GitLab и других Git-репозиториях.',
      tags: ['git', 'github', 'gitlab', 'release'],
      deps: [dependency('verification-before-completion', 'requires', '^0.1.0'), dependency('resolving-merge-conflicts', 'requires', '^0.1.0'), dependency('executing-plans', 'extends', '^0.1.0'), dependency('code-review', 'recommends', '^0.1.0')],
      content: `---
schema: skillgraph/v1
id: skill://local.git-release-management@1.0.0
name: Git Release Management
version: 1.0.0
title: Git Release Management
status: stable
tags:
  - git
  - github
  - gitlab
  - release
requires:
  - skill://verification-before-completion@^0.1.0
  - skill://resolving-merge-conflicts@^0.1.0
extends:
  - skill://executing-plans@^0.1.0
recommends:
  - skill://code-review@^0.1.0
---

# Git Release Management

## Назначение

Подготавливать проверяемые обновления для GitHub, GitLab и совместимых Git-репозиториев без потери пользовательских изменений.

## Порядок работы

1. Проверить текущую ветку, remotes, незакоммиченные изменения и правила репозитория.
2. Просмотреть diff, исключить секреты, сборочные артефакты и случайные файлы.
3. Запустить обязательные проверки и зафиксировать результат.
4. Сформировать атомарные коммиты и понятное описание обновления.
5. Перед push, созданием репозитория, изменением видимости или релизом получить явное разрешение пользователя.
6. При конфликте не перезаписывать удалённую историю; остановиться и применить безопасное разрешение конфликтов.

## Готовность

- Diff соответствует задаче.
- Секреты и локальные данные не опубликованы.
- Проверки пройдены, целевая ветка и удалённый адрес подтверждены.`,
      createdAt: now, updatedAt: now
    }
  ];
  const existingSkillIds = new Set(registry.skills.map(skill => skill.id));
  seededSkills.forEach(skill => { if (!existingSkillIds.has(skill.id)) registry.skills.push(normalizeSkill(skill)); });

  const presets = [
    { id: 'task-agent', name: 'Task Manager', role: 'Просмотр, декомпозиция и делегирование задач', provider: 'codex', description: 'Просматривает задание, создаёт задачи и подзадачи, выбирает исполнителей и передаёт контекст между агентами.', color: '#d4ff00', rootSkills: ['find-skills', 'to-spec', 'to-tickets', 'handoff'], routing: { keywords: ['задача', 'подзадача', 'делегирование', 'план'], tags: ['task', 'manager', 'handoff'], priority: 90, fallback: true } },
    { id: 'frontend-template-agent', name: 'Frontend Template Agent', role: 'Frontend-дизайн по шаблону проекта', provider: 'cursor', description: 'Создаёт интерфейс по правилам project-template-builder и сохраняет визуальную согласованность проекта.', color: '#8b6dde', rootSkills: ['project-template-builder', 'frontend-design', 'design-taste-frontend', 'web-design-guidelines'], routing: { keywords: ['frontend', 'интерфейс', 'дизайн', 'шаблон'], tags: ['frontend', 'ui', 'design'], priority: 75, fallback: false } },
    { id: 'api-integration-agent', name: 'API Integration Agent', role: 'Подключение и проверка внешних API', provider: 'cursor', description: 'Проектирует контракт интеграции, создаёт API-клиенты и проверяет обработку ошибок и секретов.', color: '#4f9dde', rootSkills: ['api-integration', 'mcp-builder', 'systematic-debugging'], routing: { keywords: ['api', 'rest', 'graphql', 'webhook', 'интеграция'], tags: ['api', 'integration'], priority: 72, fallback: false } },
    { id: 'code-review-agent', name: 'Code Review Agent', role: 'Review кода и поиск ошибок', provider: 'cursor', description: 'Проверяет изменения на ошибки, регрессии, нарушение контрактов и недостаточное покрытие проверками.', color: '#e6a85c', rootSkills: ['code-review', 'verification-before-completion', 'systematic-debugging'], permissions: { read: true, create: true, edit: false, relations: true, delete: false }, routing: { keywords: ['review', 'ошибка', 'регрессия', 'проверка'], tags: ['review', 'quality'], priority: 70, fallback: false } },
    { id: 'git-release-agent', name: 'Git Release Agent', role: 'Выгрузка и обновление Git-репозиториев', provider: 'cursor', description: 'Подготавливает проверенные обновления для GitHub, GitLab и других Git-репозиториев; публикация выполняется только с разрешения пользователя.', color: '#55b989', rootSkills: ['git-release-management', 'resolving-merge-conflicts', 'verification-before-completion'], routing: { keywords: ['git', 'github', 'gitlab', 'push', 'release'], tags: ['git', 'release'], priority: 65, fallback: false } },
    { id: 'code-refactor-agent', name: 'Code Refactoring Agent', role: 'Безопасный рефакторинг кодовой базы', provider: 'cursor', description: 'Упрощает структуру кода без изменения поведения и подтверждает результат тестами и сравнением.', color: '#d56f9d', rootSkills: ['improve-codebase-architecture', 'codebase-design', 'ponytail', 'systematic-debugging'], routing: { keywords: ['рефакторинг', 'архитектура', 'упрощение', 'техдолг'], tags: ['refactor', 'architecture'], priority: 68, fallback: false } }
  ];
  presets.forEach(preset => {
    const index = registry.agents.findIndex(agent => agent.id === preset.id);
    const permissions = preset.permissions || { read: true, create: true, edit: true, relations: true, delete: false };
    const next = normalizeAgent({ ...preset, permissions, status: 'active', security: { trustedOnly: true, allowedSourceIds: [] }, createdAt: index >= 0 ? registry.agents[index].createdAt : now, updatedAt: now });
    if (index >= 0) registry.agents[index] = next; else registry.agents.push(next);
  });
  registry.settings = { ...(registry.settings || {}), agentPresetVersion };
  return true;
}

function snapshot() {
  const registry = cloneRegistry(state);
  registry.projects = registry.projects.map(normalizeProject);
  registry.agents = registry.agents.map(normalizeAgent);
  registry.handoffs = (registry.handoffs || []).map(normalizeHandoff);
  registry.agentRuns = (registry.agentRuns || []).map(normalizeAgentRun);
  registry.runTasks = (registry.runTasks || []).map(normalizeRunTask);
  registry.runArtifacts = (registry.runArtifacts || []).map(normalizeRunArtifact);
  registry.auditLog = (registry.auditLog || []).map(normalizeAuditEntry).slice(-500);
  registry.evaluations = (registry.evaluations || []).map(normalizeEvaluation).slice(-500);
  if (registry.settings) delete registry.settings.registryScope;
  return { ...registry, schema: 'skillgraph/registry-v2', updatedAt: state.updatedAt };
}

function registrySignature(registry) {
  if (!registry || typeof registry !== 'object') return '';
  const skills = Array.isArray(registry.skills)
    ? registry.skills.map(skill => [skill.id, skill.namespace, skill.version, skill.updatedAt, skill.deps?.length || 0, skill.images?.length || 0])
    : [];
  const groups = Array.isArray(registry.groups) ? registry.groups.map(group => [group.id, group.name]) : [];
  const agents = Array.isArray(registry.agents) ? registry.agents.map(agent => [agent.id, agent.updatedAt, agent.rootSkills?.length || 0, agent.status]) : [];
  const runs = Array.isArray(registry.agentRuns) ? registry.agentRuns.map(run => [run.id, run.status, run.updatedAt, run.planRevision]) : [];
  const runTasks = Array.isArray(registry.runTasks) ? registry.runTasks.map(task => [task.id, task.status, task.updatedAt, task.progress, task.leaseOwner]) : [];
  return JSON.stringify([registry.updatedAt, registry.registryRevision || 0, skills, registry.projects?.length || 0, agents, registry.handoffs?.length || 0, runs, runTasks, registry.runArtifacts?.length || 0, registry.auditLog?.length || 0, registry.evaluations?.length || 0, registry.sources?.length || 0, groups]);
}

async function persistRegistry(message = 'Реестр сохранён', recordHistory = true) {
  state.updatedAt = new Date().toISOString();
  const previousRevision = Math.max(0, Number(state.registryRevision) || 0);
  state.registryRevision = previousRevision + 1;
  const registry = snapshot();
  if (recordHistory && !applyingHistory && lastPersistedSnapshot) {
    const before = JSON.stringify(lastPersistedSnapshot);
    const after = JSON.stringify(registry);
    if (before !== after) {
      undoStack.push(cloneRegistry(lastPersistedSnapshot));
      undoStack = undoStack.slice(-40);
      redoStack = [];
    }
  }
  try {
    if (!desktopRuntime || !window.skillGraphDesktop) throw new Error('Связь с настольным хостом потеряна. Реестр не был перезаписан.');
    await window.skillGraphDesktop.saveRegistry(registry);
    lastRegistrySignature = registrySignature(registry);
    lastPersistedSnapshot = cloneRegistry(registry);
    $('#runtimeState').textContent = message;
    $('#syncDot').classList.remove('error');
    return true;
  } catch (error) {
    state.registryRevision = previousRevision;
    $('#runtimeState').textContent = 'Ошибка сохранения';
    $('#syncDot').classList.add('error');
    console.error(error);
    setTimeout(refreshExternalRegistry, 0);
    return false;
  }
}

async function waitForDesktopBridge(timeoutMs = 8000) {
  const startedAt = performance.now();
  while (!window.skillGraphDesktop && performance.now() - startedAt < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return window.skillGraphDesktop || null;
}

function showDesktopStartupFailure(message) {
  document.body.innerHTML = `<main class="startup-failure" role="alert"><div class="brand-mark large" aria-hidden="true"><span></span><span></span><span></span></div><h1>Не удалось открыть общий реестр</h1><p>${escapeHtml(message)}</p><p>SkillGraph не переключился на старую браузерную копию. Проверьте доступ на запись и файл реестра в переносимой папке приложения.</p><code>data\\registry.json рядом с SkillGraph.exe</code></main>`;
}

async function restoreRegistrySnapshot(nextState, message) {
  if (!nextState) return;
  applyingHistory = true;
  try {
    const previousSkill = activeSkillId;
    const previousProject = activeProjectId;
    const previousAgent = activeAgentId;
    state = normalizeRegistry(cloneRegistry(nextState));
    registryScope = 'global';
    activeSkillId = state.skills.some(skill => skill.id === previousSkill) ? previousSkill : (state.skills[0]?.id ?? null);
    openSkillTabs = openSkillTabs.filter(id => state.skills.some(skill => skill.id === id));
    activeProjectId = state.projects.some(project => project.id === previousProject) ? previousProject : (state.projects[0]?.id ?? null);
    activeAgentId = state.agents.some(agent => agent.id === previousAgent) ? previousAgent : (state.agents[0]?.id ?? null);
    if (activeSkillId) openSkill(activeSkillId, true); else clearEditor();
    await persistRegistry(message, false);
    renderAll();
    showToast(message);
  } finally {
    applyingHistory = false;
  }
}

async function undoRegistry() {
  if (dirty) return showToast('В редакторе сначала используйте Ctrl+Z или сохраните файл');
  const previous = undoStack.pop();
  if (!previous) return showToast('Нет действий для отмены');
  redoStack.push(cloneRegistry(state));
  await restoreRegistrySnapshot(previous, 'Последнее действие отменено');
}

async function redoRegistry() {
  if (dirty) return showToast('Сначала завершите редактирование файла');
  const next = redoStack.pop();
  if (!next) return showToast('Нет действий для повтора');
  undoStack.push(cloneRegistry(state));
  await restoreRegistrySnapshot(next, 'Действие выполнено повторно');
}

async function initializeRegistry() {
  const loaderStartedAt = performance.now();
  let stored = null;
  let appInfo = null;
  if (!desktopHostExpected) {
    const error = new Error('Самостоятельная web-панель удалена. Запустите SkillGraph.exe.');
    showDesktopStartupFailure(error.message);
    throw error;
  }
  if (!window.skillGraphDesktop) await waitForDesktopBridge();
  desktopRuntime = Boolean(window.skillGraphDesktop);
  if (!desktopRuntime) {
    const error = new Error('Настольный мост WebView2 не ответил за 8 секунд.');
    showDesktopStartupFailure(error.message);
    throw error;
  }
  document.body.classList.add('desktop');
  try { stored = await window.skillGraphDesktop.loadRegistry(); } catch (error) { $('#runtimeState').textContent = 'Ошибка загрузки общего реестра'; $('#syncDot').classList.add('error'); throw error; }
  try { appInfo = await window.skillGraphDesktop.getAppInfo(); } catch (error) { console.error(error); }
  state = normalizeRegistry(stored);
  const v1PresetApplied = applyAgentPresetV1(state);
  registryScope = 'global';
  lastPersistedSnapshot = cloneRegistry(state);
  lastRegistrySignature = registrySignature(stored);
  document.documentElement.dataset.theme = state.settings.theme || 'dark';
  syncThemeToggle();
  const panelWidths = state.settings.panelWidths || {};
  if (panelWidths.explorer) shell.style.setProperty('--explorer-width', `${panelWidths.explorer}px`);
  if (panelWidths.inspector) shell.style.setProperty('--inspector-width', `${panelWidths.inspector}px`);
  const availableSkillIds = new Set(state.skills.map(skill => skill.id));
  openSkillTabs = (Array.isArray(state.settings.openSkillTabs) ? state.settings.openSkillTabs : []).filter(id => availableSkillIds.has(id));
  activeSkillId = availableSkillIds.has(state.settings.activeSkillTab) ? state.settings.activeSkillTab : (openSkillTabs[0] || state.skills[0]?.id || null);
  if (activeSkillId && !openSkillTabs.includes(activeSkillId)) openSkillTabs.push(activeSkillId);
  activeProjectId = state.projects[0]?.id ?? null;
  activeAgentId = state.agents[0]?.id ?? null;
  const agentMigrationRequired = stored?.schema === 'skillgraph/registry-v2' && (!Array.isArray(stored.agents) || (stored.projects || []).some(project => !Array.isArray(project.agentIds)));
  if (v1PresetApplied) await persistRegistry('Профили агентов SkillGraph 1.0 добавлены', false);
  else if (stored?.schema !== 'skillgraph/registry-v2') await persistRegistry('Пустой реестр готов');
  else if (agentMigrationRequired) await persistRegistry('Реестр подготовлен для агентов', false);
  $('#runtimeState').textContent = `Общий реестр · ${state.skills.length}`;
  $('#runtimeState').title = appInfo?.dataPath || 'Единый реестр SkillGraph';
  const loaderDuration = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 120 : 760;
  const remainingLoaderTime = Math.max(0, loaderDuration - (performance.now() - loaderStartedAt));
  if (remainingLoaderTime) await new Promise(resolve => setTimeout(resolve, remainingLoaderTime));
  document.body.classList.remove('registry-loading');
  $('#registryLoader')?.setAttribute('hidden', '');

  $('#windowMinimize').addEventListener('click', () => window.skillGraphDesktop.minimize());
  $('#windowMaximize').addEventListener('click', () => window.skillGraphDesktop.toggleMaximize());
  $('#windowClose').addEventListener('click', () => { if (!dirty || confirm('Закрыть приложение и потерять несохранённые изменения?')) window.skillGraphDesktop.close(); });
  $('.titlebar').addEventListener('pointerdown', event => { if (event.button === 0 && !event.target.closest('button,input,kbd')) window.skillGraphDesktop.dragWindow?.(); });
  $('.titlebar').addEventListener('dblclick', event => { if (!event.target.closest('button,input,kbd')) window.skillGraphDesktop.toggleMaximize(); });
}

async function refreshExternalRegistry() {
  if (!desktopRuntime || !window.skillGraphDesktop?.loadRegistry || dirty || $$('dialog[open]').length || registryRefreshInFlight) return;
  registryRefreshInFlight = true;
  try {
    const stored = await window.skillGraphDesktop.loadRegistry();
    const incomingSignature = registrySignature(stored);
    if (!stored || incomingSignature === lastRegistrySignature) return;
    const previousSkillCount = state.skills.length;
    const previousSkill = activeSkillId;
    const previousProject = activeProjectId;
    const previousAgent = activeAgentId;
    state = normalizeRegistry(stored);
    registryScope = 'global';
    lastRegistrySignature = incomingSignature;
    lastPersistedSnapshot = cloneRegistry(state);
    undoStack = [];
    redoStack = [];
    activeSkillId = state.skills.some(skill => skill.id === previousSkill) ? previousSkill : (state.skills[0]?.id ?? null);
    openSkillTabs = openSkillTabs.filter(id => state.skills.some(skill => skill.id === id));
    activeProjectId = state.projects.some(project => project.id === previousProject) ? previousProject : (state.projects[0]?.id ?? null);
    activeAgentId = state.agents.some(agent => agent.id === previousAgent) ? previousAgent : (state.agents[0]?.id ?? null);
    if (activeSkillId) openSkill(activeSkillId, true); else clearEditor();
    renderAll();
    const added = Math.max(0, state.skills.length - previousSkillCount);
    showToast(added ? `Добавлено новых скиллов: ${added}` : 'Реестр SkillGraph обновлён');
  } catch (error) {
    console.error(error);
  } finally {
    registryRefreshInFlight = false;
  }
}

async function refreshRuntimeState(render = true) {
  if (!desktopRuntime || !window.skillGraphDesktop?.getRuntimeState) return;
  try {
    const runtime = await window.skillGraphDesktop.getRuntimeState();
    const sessions = Array.isArray(runtime?.sessions) ? runtime.sessions : [];
    const signature = JSON.stringify(sessions.map(session => [session.id, session.provider, session.lastSeenAt, session.activeTaskIds?.length || 0]));
    if (signature === runtimeStateSignature) return;
    runtimeStateSignature = signature;
    runtimeSessions = sessions;
    if (render && currentView === 'agents' && agentViewMode === 'execution') renderAgentExecution();
  } catch (error) { console.error(error); }
}

function setDirty(value) {
  const nextDirty = Boolean(value && activeSkill());
  const changed = dirty !== nextDirty;
  dirty = nextDirty;
  $('#saveSkill').disabled = !dirty;
  $('#runtimeState').textContent = dirty ? 'Есть несохранённые изменения' : 'Локальный реестр сохранён';
  if (changed) renderSkillTabs();
}

function syncOpenSkillTabs() {
  const available = new Set(state.skills.map(skill => skill.id));
  openSkillTabs = [...new Set(openSkillTabs)].filter(id => available.has(id));
  if (activeSkillId && available.has(activeSkillId) && !openSkillTabs.includes(activeSkillId)) openSkillTabs.push(activeSkillId);
  state.settings.openSkillTabs = [...openSkillTabs];
  state.settings.activeSkillTab = activeSkillId;
}

function scheduleTabSessionSave() {
  if (!desktopRuntime || !window.skillGraphDesktop) return;
  clearTimeout(tabSessionTimer);
  tabSessionTimer = setTimeout(async () => {
    try {
      syncOpenSkillTabs();
      const registry = snapshot();
      await window.skillGraphDesktop.saveRegistry(registry);
      lastPersistedSnapshot = cloneRegistry(registry);
    } catch (error) { console.error('Не удалось сохранить открытые вкладки', error); }
  }, 250);
}

function renderSkillTabs() {
  const tabs = $('#workspaceTabs');
  if (tabs) workspaceTabsScrollLeft = tabs.scrollLeft;
  syncOpenSkillTabs();
  $('#skillTabs').innerHTML = openSkillTabs.map(id => {
    const skill = state.skills.find(item => item.id === id);
    if (!skill) return '';
    const active = currentView === 'workspace' && id === activeSkillId;
    return `<div class="tab skill-tab ${active ? 'active' : ''}" data-skill-tab="${escapeHtml(id)}" role="tab" tabindex="0" aria-selected="${active}" title="${escapeHtml(skillName(skill))}"><svg><use href="#i-file"/></svg><span>${escapeHtml(id)}.md</span>${dirty && id === activeSkillId ? '<i class="dirty-dot" title="Есть несохранённые изменения"></i>' : ''}<button class="tab-close" data-close-skill-tab="${escapeHtml(id)}" type="button" aria-label="Закрыть вкладку ${escapeHtml(skillName(skill))}" title="Закрыть"><svg><use href="#i-x"/></svg></button></div>`;
  }).join('');
  $$('.tab[data-view]').forEach(tab => {
    const active = tab.dataset.view === currentView;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  requestAnimationFrame(() => { if (tabs) tabs.scrollLeft = workspaceTabsScrollLeft; });
}

function closeSkillTab(id) {
  const index = openSkillTabs.indexOf(id);
  if (index < 0) return;
  if (id === activeSkillId && dirty && !confirm('Закрыть вкладку и потерять несохранённые изменения?')) return;
  openSkillTabs.splice(index, 1);
  scheduleTabSessionSave();
  if (id !== activeSkillId) { renderSkillTabs(); return; }
  const nextId = openSkillTabs[index] || openSkillTabs[index - 1] || null;
  if (nextId) openSkill(nextId, true);
  else { clearEditor(); renderAll(); }
}

function updateEditor() {
  const lines = editor.value.split('\n');
  gutter.textContent = Array.from({ length: lines.length }, (_, index) => index + 1).join('\n');
  const pieces = editor.value.split('---');
  const body = pieces.length >= 3 ? pieces.slice(2).join('---') : editor.value;
  const frontmatter = pieces.length >= 3 ? pieces[1].trim() : '';
  const html = escapeHtml(body)
    .replace(/!\[([^\]]*)\]\(skillgraph-asset:\/\/([^)]+)\)/g, (_, alt, id) => {
      const image = findImage(id);
      return image ? `<figure class="markdown-image"><img src="${escapeHtml(imageAssetUrl(image))}" alt="${alt}"><figcaption>${alt || escapeHtml(image.name)}</figcaption></figure>` : `<p class="missing-image">Изображение ${escapeHtml(id)} не найдено</p>`;
    })
    .replace(/^### (.+)$/gm, '<h3>$1</h3>').replace(/^## (.+)$/gm, '<h2>$1</h2>').replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/`([^`]+)`/g, '<code>$1</code>').replace(/^\d+\. (.+)$/gm, '<p>• $1</p>').replace(/^- \[ \] (.+)$/gm, '<p>☐ $1</p>').replace(/^- (.+)$/gm, '<p>• $1</p>');
  preview.innerHTML = `${frontmatter ? `<div class="frontmatter-preview">${escapeHtml(frontmatter)}</div>` : ''}${html}`;
}

function openSkill(id, force = false) {
  if (!force && dirty && id !== activeSkillId && !confirm('Отменить несохранённые изменения текущего скилла?')) return false;
  const skill = state.skills.find(item => item.id === id);
  if (!skill) return false;
  activeSkillId = id;
  if (!openSkillTabs.includes(id)) openSkillTabs.push(id);
  scheduleTabSessionSave();
  editor.disabled = false;
  editor.value = skill.content;
  savedEditorValue = skill.content;
  $('#editorEmpty').hidden = true;
  $('#crumbNamespace').textContent = skill.namespace;
  $('#crumbFile').textContent = `${skill.id}.md`;
  setDirty(false);
  updateEditor();
  renderAll();
  return true;
}

function clearEditor() {
  activeSkillId = null;
  editor.value = '';
  editor.disabled = true;
  savedEditorValue = '';
  $('#editorEmpty').hidden = false;
  $('#crumbNamespace').textContent = '—';
  $('#crumbFile').textContent = 'ничего не открыто';
  setDirty(false);
  updateEditor();
}

function suggestedPatchVersion(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}.${Number(match[3]) + 1}` : '0.1.0';
}

function saveActiveSkill() {
  const skill = activeSkill();
  if (!skill || !dirty) return;
  const parsed = parseFrontmatter(editor.value);
  const form = $('#saveVersionForm');
  form.elements.version.value = parsed.version && parsed.version !== skill.version ? parsed.version : suggestedPatchVersion(skill.version);
  $('#saveVersionCurrent').textContent = `Текущая версия: ${skill.version}`;
  if (!$('#saveVersionDialog').open) $('#saveVersionDialog').showModal();
  setTimeout(() => { form.elements.version.focus(); form.elements.version.select(); }, 20);
}

async function commitActiveSkill(nextVersion) {
  const skill = activeSkill();
  if (!skill || !dirty) return;
  editor.value = replaceFrontmatterValue(editor.value, 'version', nextVersion);
  const parsed = parseFrontmatter(editor.value);
  const nextId = parsed.id ? slugify(parsed.id) : skill.id;
  const conflict = state.skills.find(item => item.id === nextId && item !== skill);
  if (conflict) state.skills = state.skills.filter(item => item !== conflict);
  const oldId = skill.id;
  skill.history.unshift({ savedAt: new Date().toISOString(), version: skill.version, content: savedEditorValue });
  skill.history = skill.history.slice(0, 25);
  Object.assign(skill, { id: nextId, namespace: parsed.namespace || skill.namespace, name: parsed.name || skill.name, title: parsed.title || parsed.name || skill.title, version: nextVersion, status: parsed.status || skill.status, description: parsed.description || skill.description, tags: parsed.tags, deps: parsed.deps, content: editor.value, updatedAt: new Date().toISOString() });
  if (oldId !== skill.id) {
    remapSkillId(oldId, skill.id);
    activeSkillId = skill.id;
  }
  savedEditorValue = editor.value;
  setDirty(false);
  await persistRegistry(`Скилл «${skillName(skill)}» сохранён`);
  renderAll();
  showToast(conflict ? 'Новая версия сохранена, предыдущий конфликтующий скилл заменён' : 'Изменения сохранены');
}

function renderSkillLists() {
  const query = $('#skillSearch').value.toLowerCase();
  const scoped = visibleSkills();
  const filtered = scoped.filter(skill => `${skillName(skill)} ${skill.id} ${skill.tags.join(' ')}`.toLowerCase().includes(query));
  const row = skill => `<button class="skill-row ${skill.id === activeSkillId ? 'active' : ''}" data-skill="${escapeHtml(skill.id)}" draggable="${registryScope === 'global'}" type="button" title="${escapeHtml(skill.id)}"><svg><use href="#i-file"/></svg><span>${escapeHtml(skillName(skill))}</span><span class="version">${escapeHtml(skill.version)}</span></button>`;
  const favorites = filtered.filter(skill => skill.favorite);
  const groupIds = new Set((state.groups || []).map(group => group.id));
  const regular = registryScope === 'global' ? filtered.filter(skill => !skill.favorite && (!skill.groupId || !groupIds.has(skill.groupId))) : filtered;
  $('#favoriteSkills').innerHTML = favorites.map(row).join('') || '<div class="tree-empty">Перетащите скилл сюда</div>';
  $('#allSkills').innerHTML = regular.map(row).join('') || '<div class="tree-empty">Скиллы не найдены</div>';
  $('#customSkillGroups').innerHTML = registryScope === 'global' ? (state.groups || []).map(group => {
    const skills = filtered.filter(skill => !skill.favorite && skill.groupId === group.id);
    return `<section class="tree-section custom-skill-group" data-skill-group="${escapeHtml(group.id)}"><div class="custom-group-heading"><button class="tree-label" type="button" aria-expanded="true"><span class="chevron">⌄</span><span>${escapeHtml(group.name)}</span><span class="count">${skills.length}</span></button><button class="group-edit" data-group-edit="${escapeHtml(group.id)}" type="button" title="Редактировать группу" aria-label="Редактировать группу"><svg><use href="#i-pencil"/></svg></button></div><div class="skill-list">${skills.map(row).join('') || '<div class="tree-empty">Перетащите скилл сюда</div>'}</div></section>`;
  }).join('') : '';
  $('#favoriteCount').textContent = scoped.filter(skill => skill.favorite).length;
  $('#allCount').textContent = regular.length;
  $('#skillsTreeLabelText').textContent = registryScope === 'project' ? 'Скиллы проекта' : 'Все скиллы';
  $('#favoriteSection').hidden = registryScope === 'project';
  $('#addSkillGroup').hidden = registryScope === 'project';
  $$('[data-registry-scope]').forEach(button => {
    button.classList.toggle('active', button.dataset.registryScope === registryScope);
    if (button.dataset.registryScope === 'project') {
      button.disabled = !activeProject();
      button.title = activeProject() ? `Цепочка проекта «${activeProject().name}»` : 'Сначала добавьте или выберите проект';
    }
  });
  $$('.skill-row').forEach(button => {
    button.addEventListener('click', () => { if (openSkill(button.dataset.skill)) switchView('workspace'); });
    button.addEventListener('dragstart', event => {
      if (registryScope !== 'global') return event.preventDefault();
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-skillgraph-skill', button.dataset.skill);
      event.dataTransfer.setData('text/plain', button.dataset.skill);
      requestAnimationFrame(() => button.classList.add('dragging'));
    });
    button.addEventListener('dragend', () => { button.classList.remove('dragging'); $$('.tree-section.drag-over').forEach(section => section.classList.remove('drag-over')); });
  });
  $$('.custom-skill-group').forEach(section => {
    const groupId = section.dataset.skillGroup;
    const label = section.querySelector('.tree-label');
    const list = section.querySelector('.skill-list');
    label.addEventListener('click', () => {
      const open = label.getAttribute('aria-expanded') === 'true';
      label.setAttribute('aria-expanded', String(!open));
      list.hidden = open;
      label.querySelector('.chevron').textContent = open ? '›' : '⌄';
    });
    bindSkillDropSection(section, { favorite: false, groupId });
  });
  $$('[data-group-edit]').forEach(button => button.addEventListener('click', () => openSkillGroupDialog(button.dataset.groupEdit)));
}

function bindSkillDropSection(section, placement) {
  section.addEventListener('dragenter', event => { if (registryScope === 'global') { event.preventDefault(); section.classList.add('drag-over'); } });
  section.addEventListener('dragover', event => { if (registryScope === 'global') { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; section.classList.add('drag-over'); } });
  section.addEventListener('dragleave', event => { if (!section.contains(event.relatedTarget)) section.classList.remove('drag-over'); });
  section.addEventListener('drop', async event => { section.classList.remove('drag-over'); await moveDraggedSkill(event, placement); });
}

async function moveDraggedSkill(event, placement) {
  event.preventDefault();
  const id = event.dataTransfer.getData('application/x-skillgraph-skill') || event.dataTransfer.getData('text/plain');
  const skill = state.skills.find(item => item.id === id);
  if (!skill || registryScope !== 'global') return;
  const favorite = Boolean(placement.favorite);
  const groupId = favorite ? skill.groupId : (placement.groupId || '');
  if (skill.favorite === favorite && skill.groupId === groupId) return;
  skill.favorite = favorite;
  skill.groupId = groupId;
  const targetName = favorite ? 'Избранное' : (state.groups.find(group => group.id === groupId)?.name || 'Все скиллы');
  await persistRegistry(`Скилл перемещён в «${targetName}»`);
  renderAll();
  showToast(`Скилл перемещён в «${targetName}»`);
}

function renderProjectsList() {
  $('#projectList').innerHTML = state.projects.map(project => `<button class="project-row ${project.id === activeProjectId ? 'active' : ''}" data-project="${escapeHtml(project.id)}" type="button"><span class="project-dot" style="background:${escapeHtml(project.color)}"></span><span>${escapeHtml(project.name)}</span><span class="count">${project.roots.length}</span></button>`).join('') || '<div class="tree-empty">Нет проектов</div>';
  $('#projectCount').textContent = state.projects.length;
  $$('.project-row').forEach(button => button.addEventListener('click', () => { activeProjectId = button.dataset.project; registryScope = 'project'; renderAll(); switchView('projects'); $('#runtimeState').textContent = 'Открыто представление проекта'; }));
}

const providerLabels = { codex: 'Codex', cursor: 'Cursor', claude: 'Claude', copilot: 'Copilot', deepseek: 'DeepSeek', qwen: 'Qwen', local: 'Локальная модель', custom: 'Другой' };
const agentProviderSelect = $('#agentForm select[name="provider"]');
for (const provider of ['deepseek', 'qwen']) {
  if (!agentProviderSelect.querySelector(`option[value="${provider}"]`)) agentProviderSelect.add(new Option(providerLabels[provider], provider));
}
const agentStatusLabels = { active: 'активен', paused: 'приостановлен', draft: 'черновик' };
const agentRuntimeAdapters = {
  codex: { transport: 'MCP', capabilities: ['read', 'write', 'review', 'handoff', 'audit'], configured: () => Boolean(integrationStatus.codex) },
  cursor: { transport: 'MCP', capabilities: ['read', 'write', 'review', 'handoff', 'audit'], configured: () => Boolean(integrationStatus.cursor) },
  claude: { transport: 'MCP', capabilities: ['read', 'write', 'review', 'handoff', 'audit'], configured: () => Boolean(integrationStatus.claude) },
  copilot: { transport: 'MCP', capabilities: ['read', 'write', 'review', 'handoff', 'audit'], configured: () => Boolean(integrationStatus.copilot) },
  deepseek: { transport: 'MCP/stdio', capabilities: ['read', 'write', 'review', 'handoff', 'audit'], configured: () => Boolean(integrationStatus.deepseek) },
  qwen: { transport: 'MCP/stdio', capabilities: ['read', 'write', 'review', 'handoff', 'audit'], configured: () => Boolean(integrationStatus.qwen) },
  local: { transport: 'локальный MCP', capabilities: ['read', 'write', 'review', 'handoff', 'audit'], configured: () => Boolean(integrationStatus.local) },
  custom: { transport: 'MCP/stdio', capabilities: ['read', 'write', 'review', 'handoff', 'audit'], configured: () => Boolean(integrationStatus.custom) }
};

function resolveAgent(agent) {
  return resolveProject({ roots: agent?.rootSkills || [] });
}

function taskTokens(text) {
  return [...new Set(String(text || '').toLowerCase().split(/[^a-zа-яё0-9]+/i).filter(token => token.length > 2))];
}

function appendAudit(action, { agentId = '', projectId = activeProjectId || '', task = '', skillIds = [], durationMs = 0, contextChars = 0, success = true, detail = '', requestedProvider = '', clientProvider = 'skillgraph-desktop', actualProvider = '', phase = '', runId = '', taskId = '' } = {}) {
  state.auditLog ||= [];
  state.auditLog.push(normalizeAuditEntry({ action, agentId, projectId, task, skillIds, durationMs, contextChars, success, detail, requestedProvider, clientProvider, actualProvider, phase, runId, taskId }));
  state.auditLog = state.auditLog.slice(-500);
}

function resolveAgentContext(agent, project = activeProject(), task = '') {
  const started = performance.now();
  const projectRoots = project?.roots || [];
  const roots = [...new Set([...projectRoots, ...(agent?.rootSkills || [])])];
  const resolved = resolveProject({ roots });
  const conflicts = [...resolved.conflicts];
  if (!agent?.permissions?.read) conflicts.unshift('У агента нет разрешения на чтение скиллов.');
  if (project && !(project.agentIds || []).includes(agent.id)) conflicts.unshift('Агент не назначен этому проекту.');
  const allowedSources = new Set(agent?.security?.allowedSourceIds || []);
  const order = resolved.order.filter(skill => {
    const sourceId = skill.origin?.sourceId || '';
    if (!sourceId) return true;
    const allowed = !agent?.security?.trustedOnly || allowedSources.has(sourceId);
    if (!allowed) conflicts.push(`Удалённый скилл ${skill.id} заблокирован политикой доверия.`);
    return allowed;
  });
  const tokens = taskTokens(task);
  const relevance = new Map(order.map(skill => [skill.id, tokens.filter(token => `${skillName(skill)} ${skill.description} ${skill.tags.join(' ')}`.toLowerCase().includes(token)).length]));
  const contextChars = order.reduce((sum, skill) => sum + String(skill.content || '').length, 0);
  return { ...resolved, order, conflicts: [...new Set(conflicts)], roots, relevance, durationMs: Math.round(performance.now() - started), contextChars };
}

function routeTask(task, project = activeProject()) {
  const tokens = taskTokens(task);
  const candidates = (project?.agentIds || []).map(id => state.agents.find(agent => agent.id === id)).filter(agent => agent && agent.status === 'active' && agent.permissions.read);
  const scored = candidates.map(agent => {
    const routing = agent.routing || {};
    const haystack = `${agent.name} ${agent.role} ${agent.description} ${(routing.keywords || []).join(' ')} ${(routing.tags || []).join(' ')}`.toLowerCase();
    const resolved = resolveAgentContext(agent, project, task);
    const skillScore = resolved.order.reduce((sum, skill) => sum + (resolved.relevance.get(skill.id) || 0), 0);
    const directScore = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 3 : 0), 0);
    const score = directScore + skillScore * 2 + (Number(routing.priority) || 0) / 25;
    const reasons = [];
    if (directScore) reasons.push('совпадение роли/ключевых слов');
    if (skillScore) reasons.push(`подходящие скиллы: ${skillScore}`);
    if (routing.fallback) reasons.push('fallback');
    return { agent, score, reasons, resolved };
  }).sort((a, b) => b.score - a.score);
  if (scored.length && scored[0].score <= 2) {
    const fallback = scored.find(item => item.agent.routing?.fallback);
    if (fallback) { scored.splice(scored.indexOf(fallback), 1); scored.unshift(fallback); fallback.reasons = ['fallback-агент']; }
  }
  const max = Math.max(1, ...scored.map(item => item.score));
  return scored.map(item => ({ ...item, confidence: Math.round(item.score / max * 100) }));
}

function openAgentDialog(id = null) {
  const agent = state.agents.find(item => item.id === id);
  const form = $('#agentForm');
  form.reset();
  form.elements.id.value = agent?.id || '';
  form.elements.name.value = agent?.name || '';
  form.elements.role.value = agent?.role || '';
  form.elements.provider.value = agent?.provider || 'codex';
  form.elements.status.value = agent?.status || 'active';
  setProjectColorControl(form, agent?.color || '#8B6DDE');
  form.elements.description.value = agent?.description || '';
  form.elements.permissionRead.checked = agent?.permissions.read !== false;
  form.elements.permissionCreate.checked = Boolean(agent?.permissions.create);
  form.elements.permissionEdit.checked = Boolean(agent?.permissions.edit);
  form.elements.permissionRelations.checked = Boolean(agent?.permissions.relations);
  form.elements.permissionDelete.checked = Boolean(agent?.permissions.delete);
  form.elements.routingKeywords.value = (agent?.routing.keywords || []).join(', ');
  form.elements.routingTags.value = (agent?.routing.tags || []).join(', ');
  form.elements.routingPriority.value = agent?.routing.priority ?? 50;
  form.elements.routingFallback.checked = Boolean(agent?.routing.fallback);
  form.elements.trustedOnly.checked = agent?.security.trustedOnly !== false;
  syncCustomSelect(form.elements.provider);
  syncCustomSelect(form.elements.status);
  $('#agentDialogTitle').textContent = agent ? 'Редактировать агента' : 'Новый агент';
  $('#agentDialog').showModal();
}

function renderAgentSkillChoices(query = '') {
  const agent = activeAgent();
  if (!agent) return;
  const normalizedQuery = query.trim().toLowerCase();
  const skills = state.skills.filter(skill => !normalizedQuery || `${skillName(skill)} ${skill.id} ${skill.tags.join(' ')}`.toLowerCase().includes(normalizedQuery));
  $('#agentSkillsList').innerHTML = skills.map(skill => `<label class="binding-skill-row"><input type="checkbox" name="skill" value="${escapeHtml(skill.id)}" ${pendingAgentRootSkills.has(skill.id) ? 'checked' : ''}><span class="skill-icon purple">${escapeHtml(skillIcon(skill))}</span><span><strong>${escapeHtml(skillName(skill))}</strong><small>${escapeHtml(skill.id)} · ${escapeHtml(skill.version)}</small></span></label>`).join('') || '<div class="section-empty">Скиллы не найдены.</div>';
  $$('#agentSkillsList input[name="skill"]').forEach(input => input.addEventListener('change', () => { if (input.checked) pendingAgentRootSkills.add(input.value); else pendingAgentRootSkills.delete(input.value); }));
}

function openAgentSkillsDialog(id) {
  activeAgentId = id;
  const agent = activeAgent();
  if (!agent) return;
  pendingAgentRootSkills = new Set(agent.rootSkills);
  $('#agentSkillsSummary').textContent = `${agent.name} · версии синхронизируются с реестром`;
  $('#agentSkillSearch').value = '';
  renderAgentSkillChoices();
  $('#agentSkillsDialog').showModal();
}

function openProjectAgentsDialog(projectId = activeProjectId) {
  activeProjectId = projectId;
  const project = activeProject();
  if (!project) return;
  const selected = new Set(project.agentIds || []);
  $('#projectAgentsSummary').textContent = project.name;
  $('#projectAgentsList').innerHTML = state.agents.map(agent => `<label class="binding-skill-row"><input type="checkbox" name="agent" value="${escapeHtml(agent.id)}" ${selected.has(agent.id) ? 'checked' : ''}><span class="agent-color-dot" style="--agent-color:${escapeHtml(agent.color)}"></span><span><strong>${escapeHtml(agent.name)}</strong><small>${escapeHtml(agent.role)} · ${escapeHtml(providerLabels[agent.provider] || agent.provider)}</small></span></label>`).join('') || '<div class="section-empty">Сначала создайте хотя бы одного агента.</div>';
  $('#projectAgentsDialog').showModal();
}

async function removeAgent(id) {
  const agent = state.agents.find(item => item.id === id);
  if (!agent || !confirm(`Удалить агента «${agent.name}»? Скиллы останутся в общем реестре.`)) return;
  state.agents = state.agents.filter(item => item.id !== id);
  state.projects.forEach(project => { project.agentIds = (project.agentIds || []).filter(agentId => agentId !== id); });
  activeAgentId = state.agents[0]?.id || null;
  await persistRegistry('Агент удалён');
  renderAll();
}

async function assignSkillToAgent(agentId, skillId) {
  const agent = state.agents.find(item => item.id === agentId);
  if (!agent || !state.skills.some(skill => skill.id === skillId) || agent.rootSkills.includes(skillId)) return;
  agent.rootSkills.push(skillId);
  agent.updatedAt = new Date().toISOString();
  await persistRegistry(`Скилл назначен агенту «${agent.name}»`);
  renderAll();
}

function bindAgentDropTarget(element, agentId) {
  element.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('application/x-skillgraph-skill')) { event.preventDefault(); element.classList.add('drag-over'); } });
  element.addEventListener('dragleave', event => { if (!element.contains(event.relatedTarget)) element.classList.remove('drag-over'); });
  element.addEventListener('drop', async event => { event.preventDefault(); element.classList.remove('drag-over'); const skillId = event.dataTransfer.getData('application/x-skillgraph-skill') || event.dataTransfer.getData('text/plain'); await assignSkillToAgent(agentId, skillId); });
}

function renderAgentProfiles() {
  const agent = activeAgent();
  if (!agent) {
    $('#agentContent').innerHTML = '<div class="empty-state inline"><h2>Агентов пока нет</h2><p>Создайте агента, задайте его роль и назначьте корневые скиллы.</p><button class="primary-button" id="emptyAddAgent" type="button">Создать агента</button></div>';
    $('#emptyAddAgent').addEventListener('click', () => openAgentDialog());
    return;
  }
  const resolved = resolveAgent(agent);
  const projects = state.projects.filter(project => (project.agentIds || []).includes(agent.id));
  const permissionRows = Object.entries(agent.permissions).filter(([, enabled]) => enabled).map(([key]) => ({ read: 'чтение', create: 'создание', edit: 'изменение', relations: 'связи', delete: 'удаление' }[key])).join(' · ') || 'нет разрешений';
  const rootRows = agent.rootSkills.map(id => {
    const skill = state.skills.find(item => item.id === id);
    return `<article class="agent-root-skill"><button data-skill="${escapeHtml(id)}" type="button"><span class="skill-icon purple">${escapeHtml(skill ? skillIcon(skill) : '?')}</span><span><strong>${escapeHtml(skill ? skillName(skill) : id)}</strong><small>${escapeHtml(skill ? `${skill.namespace}.${skill.id} · ${skill.version}` : 'Скилл не найден')}</small></span></button><button class="mini-button remove-agent-skill" data-agent-skill="${escapeHtml(id)}" type="button" title="Отключить"><svg><use href="#i-x"/></svg></button></article>`;
  }).join('');
  $('#agentContent').innerHTML = `<section class="agent-profile-card" style="--agent-color:${escapeHtml(agent.color)}"><header><span class="agent-avatar"><svg><use href="#i-agent"/></svg></span><div><strong>${escapeHtml(agent.name)}</strong><span>${escapeHtml(agent.role)}</span></div><span class="agent-status ${escapeHtml(agent.status)}">${escapeHtml(agentStatusLabels[agent.status] || agent.status)}</span><div class="agent-profile-actions"><button class="secondary-button" id="editAgent" type="button"><svg><use href="#i-pencil"/></svg> Редактировать</button><button class="secondary-button danger-action" id="deleteAgent" type="button"><svg><use href="#i-trash"/></svg></button></div></header><p>${escapeHtml(agent.description || 'Описание пока не добавлено.')}</p><div class="agent-facts"><span><b>Назначенный провайдер</b>${escapeHtml(providerLabels[agent.provider] || agent.provider)}</span><span><b>В цепочке</b>${resolved.order.length} скиллов</span><span><b>Проекты</b>${projects.length}</span><span><b>Режим версий</b>следовать реестру</span></div><footer><span>Разрешения: ${escapeHtml(permissionRows)}</span>${resolved.conflicts.length ? `<span class="danger-text">Проблем: ${resolved.conflicts.length}</span>` : '<span class="valid-label">✓ Цепочка валидна</span>'}</footer></section><section class="content-section agent-skills-section" id="agentSkillDrop"><div class="section-heading"><div><strong>Корневые скиллы</strong><span>Перетащите скилл из навигатора или выберите вручную</span></div><button class="secondary-button" id="configureAgentSkills" type="button">+ Назначить</button></div>${rootRows || '<div class="section-empty">Скиллы не назначены.</div>'}</section><section class="content-section"><div class="section-heading"><div><strong>Проекты агента</strong><span>Назначения не создают копии скиллов</span></div></div><div class="agent-project-tags">${projects.map(project => `<button data-project="${escapeHtml(project.id)}" type="button" style="--project-color:${escapeHtml(project.color)}"><i></i><span>${escapeHtml(project.name)}</span></button>`).join('') || '<span class="section-empty">Агент пока не подключён к проектам.</span>'}</div></section>`;
  $('#editAgent').addEventListener('click', () => openAgentDialog(agent.id));
  $('#deleteAgent').addEventListener('click', () => removeAgent(agent.id));
  $('#configureAgentSkills').addEventListener('click', () => openAgentSkillsDialog(agent.id));
  bindAgentDropTarget($('#agentSkillDrop'), agent.id);
  $$('.agent-root-skill [data-skill]').forEach(button => button.addEventListener('click', () => { if (openSkill(button.dataset.skill)) switchView('workspace'); }));
  $$('.remove-agent-skill').forEach(button => button.addEventListener('click', async () => { agent.rootSkills = agent.rootSkills.filter(id => id !== button.dataset.agentSkill); agent.updatedAt = new Date().toISOString(); await persistRegistry('Назначение скилла удалено'); renderAll(); }));
  $$('.agent-project-tags [data-project]').forEach(button => button.addEventListener('click', () => { activeProjectId = button.dataset.project; registryScope = 'project'; renderAll(); switchView('projects'); }));
}

function renderAgentRoute() {
  const project = activeProject();
  if (!project) {
    $('#agentContent').innerHTML = '<div class="empty-state inline"><h2>Нет проекта для маршрута</h2><p>Создайте или выберите проект в верхней панели.</p></div>';
    return;
  }
  const agents = (project.agentIds || []).map(id => state.agents.find(agent => agent.id === id)).filter(Boolean);
  if (!agents.length) {
    $('#agentContent').innerHTML = `<div class="empty-state inline"><h2>Агенты не назначены</h2><p>Подключите агентов к проекту «${escapeHtml(project.name)}», чтобы построить горизонтальный маршрут.</p><button class="primary-button" id="emptyAssignProjectAgents" type="button">Назначить агентов</button></div>`;
    $('#emptyAssignProjectAgents').addEventListener('click', () => openProjectAgentsDialog(project.id));
    return;
  }
  const lanes = agents.map(agent => {
    const resolved = resolveAgentContext(agent, project, routingTask);
    const nodes = resolved.order.map((skill, index) => `<button class="route-skill-node ${agent.rootSkills.includes(skill.id) ? 'root' : ''}" data-skill="${escapeHtml(skill.id)}" type="button" style="--agent-color:${escapeHtml(agent.color)}"><span>${index + 1}</span><strong>${escapeHtml(skillName(skill))}</strong><small>${escapeHtml(skill.version)}</small></button>`).join('');
    return `<section class="agent-route-lane" style="--agent-color:${escapeHtml(agent.color)}"><header><span class="agent-avatar"><svg><use href="#i-agent"/></svg></span><div><strong>${escapeHtml(agent.name)}</strong><span>${escapeHtml(agent.role)}</span></div><small>${resolved.order.length} скиллов</small></header><div class="route-track"><span class="route-endpoint start">Задача</span>${nodes || '<span class="route-empty">Нет назначенных скиллов</span>'}<span class="route-endpoint finish">Результат</span></div>${resolved.conflicts.length ? `<div class="route-conflicts">${resolved.conflicts.map(item => escapeHtml(item)).join(' · ')}</div>` : ''}</section>`;
  }).join('');
  $('#agentContent').innerHTML = `<div class="agent-route-board"><header><div><strong>Маршрут проекта «${escapeHtml(project.name)}»</strong><span>Скиллы идут слева направо; каждая дорожка принадлежит отдельному агенту</span></div><button class="secondary-button" id="configureProjectAgents" type="button">Настроить агентов</button></header><div class="route-lanes">${lanes}</div></div>`;
  $('#configureProjectAgents').addEventListener('click', () => openProjectAgentsDialog(project.id));
  $$('.route-skill-node').forEach(button => button.addEventListener('click', () => { if (openSkill(button.dataset.skill)) switchView('workspace'); }));
}

function renderAgentRouting() {
  const project = activeProject();
  if (!project) return void ($('#agentContent').innerHTML = '<div class="empty-state inline"><h2>Выберите проект</h2><p>Маршрутизация работает только среди агентов выбранного проекта.</p></div>');
  const results = routingTask.trim() ? routeTask(routingTask, project) : [];
  $('#agentContent').innerHTML = `<section class="agent-planner"><header><div><strong>Маршрутизация задачи</strong><span>Рекомендация по роли, ключевым словам и графу скиллов — без автоматического запуска агента</span></div></header><label>Текст задачи<textarea id="routingTaskInput" rows="4" placeholder="Опишите задачу для проекта">${escapeHtml(routingTask)}</textarea></label><div class="planner-actions"><button class="primary-button" id="routeTaskButton" type="button">Подобрать агента</button><span>${escapeHtml(project.name)}</span></div><div class="routing-results">${results.map((item, index) => `<article class="routing-result ${index === 0 ? 'recommended' : ''}" style="--agent-color:${escapeHtml(item.agent.color)}"><span class="route-rank">${index + 1}</span><span class="agent-avatar"><svg><use href="#i-agent"/></svg></span><div><strong>${escapeHtml(item.agent.name)}</strong><span>${escapeHtml(item.reasons.join(' · ') || 'общий приоритет')}</span><small>${item.resolved.order.length} скиллов · ${item.resolved.conflicts.length} проблем</small></div><b>${item.confidence}%</b><button class="secondary-button use-route-agent" data-agent="${escapeHtml(item.agent.id)}" type="button">Выбрать</button></article>`).join('') || (routingTask.trim() ? '<div class="section-empty">Нет доступных агентов. Проверьте назначения и разрешение на чтение.</div>' : '<div class="section-empty">Введите задачу, чтобы увидеть объяснимую рекомендацию.</div>')}</div></section>`;
  $('#routeTaskButton').addEventListener('click', async () => { routingTask = $('#routingTaskInput').value.trim(); const best = routeTask(routingTask, project)[0]; appendAudit('task-routed', { agentId: best?.agent.id || '', projectId: project.id, task: routingTask, skillIds: best?.resolved.order.map(skill => skill.id) || [], success: Boolean(best), detail: best ? `confidence ${best.confidence}%; recommendation only` : 'no candidate', requestedProvider: best?.agent.provider || '', phase: 'planned' }); await persistRegistry('Маршрут задачи рассчитан'); renderAgentRouting(); });
  $$('.use-route-agent').forEach(button => button.addEventListener('click', async event => { const result = results.find(item => item.agent.id === event.currentTarget.dataset.agent); if (!result) return; activeAgentId = result.agent.id; appendAudit('agent-context-previewed', { agentId: result.agent.id, projectId: project.id, task: routingTask, skillIds: result.resolved.order.map(skill => skill.id), durationMs: result.resolved.durationMs, contextChars: result.resolved.contextChars, success: !result.resolved.conflicts.length, requestedProvider: result.agent.provider, phase: 'planned', detail: 'Контекст просмотрен в SkillGraph; агент не запускался' }); await persistRegistry('Предпросмотр контекста агента записан'); agentViewMode = 'route'; renderAgents(); }));
}

function renderAgentHandoffs() {
  const project = activeProject();
  const agents = (project?.agentIds || []).map(id => state.agents.find(agent => agent.id === id)).filter(Boolean);
  const rows = (state.handoffs || []).filter(item => !project || item.projectId === project.id).slice().reverse();
  $('#agentContent').innerHTML = `<section class="handoff-board"><header><div><strong>Передача контекста</strong><span>Статус меняется автоматически, когда целевой runtime принимает контекст и записывает результат</span></div></header><form id="handoffForm" class="handoff-form"><label>От<select name="fromAgentId" required>${agents.map(agent => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name)} · ${escapeHtml(providerLabels[agent.provider] || agent.provider)}</option>`).join('')}</select></label><label>Кому<select name="toAgentId" required>${agents.map(agent => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name)} · ${escapeHtml(providerLabels[agent.provider] || agent.provider)}</option>`).join('')}</select></label><label class="wide">Задача<textarea name="task" rows="2" required></textarea></label><label class="wide">Результат и открытые вопросы<textarea name="result" rows="3"></textarea></label><button class="primary-button" type="submit" ${agents.length < 2 ? 'disabled' : ''}>Создать handoff</button></form><div class="handoff-list">${rows.map(item => { const from = state.agents.find(agent => agent.id === item.fromAgentId); const to = state.agents.find(agent => agent.id === item.toAgentId); return `<article><header><span style="--agent-color:${escapeHtml(from?.color || '#777')}">${escapeHtml(from?.name || 'Удалённый агент')} · ${escapeHtml(providerLabels[from?.provider] || from?.provider || '—')}</span><b>→</b><span style="--agent-color:${escapeHtml(to?.color || '#777')}">${escapeHtml(to?.name || 'Удалённый агент')} · ${escapeHtml(providerLabels[to?.provider] || to?.provider || '—')}</span><em>${escapeHtml(item.status)}</em></header><strong>${escapeHtml(item.task)}</strong><p>${escapeHtml(item.result || 'Результат ещё не добавлен.')}</p><small>${new Date(item.createdAt).toLocaleString('ru-RU')} · ${item.skillIds.length} скиллов</small></article>`; }).join('') || '<div class="section-empty">Передач пока нет.</div>'}</div></section>`;
  $('#handoffForm').addEventListener('submit', async event => { event.preventDefault(); const data = new FormData(event.currentTarget); if (data.get('fromAgentId') === data.get('toAgentId')) return showToast('Выберите разных агентов'); const from = state.agents.find(agent => agent.id === data.get('fromAgentId')); const to = state.agents.find(agent => agent.id === data.get('toAgentId')); const context = resolveAgentContext(from, project, data.get('task')); const handoff = normalizeHandoff({ projectId: project?.id || '', fromAgentId: data.get('fromAgentId'), toAgentId: data.get('toAgentId'), task: data.get('task'), result: data.get('result'), skillIds: context.order.map(skill => skill.id) }); state.handoffs.push(handoff); appendAudit('handoff-created', { agentId: from.id, projectId: project?.id, task: handoff.task, skillIds: handoff.skillIds, detail: `to ${handoff.toAgentId}; ${from.provider} -> ${to?.provider || 'unknown'}`, requestedProvider: to?.provider || '', phase: 'queued' }); await persistRegistry('Handoff создан'); renderAgentHandoffs(); });
}

function renderAgentAudit() {
  const project = activeProject();
  const rows = (state.auditLog || []).filter(item => !project || item.projectId === project.id).slice().reverse();
  $('#agentContent').innerHTML = `<section class="audit-board"><header><div><strong>Автоматический журнал агентных решений</strong><span>Маршрутизация, контекст, handoff и завершение фиксируются MCP без ручного ввода; полный запрос наружу не передаётся</span></div><b>${rows.length} событий</b></header><div class="audit-table"><div class="audit-row heading"><span>Время</span><span>Событие</span><span>Агент</span><span>Провайдер</span><span>Скиллы</span><span>Метрики</span></div>${rows.map(item => { const agent = state.agents.find(candidate => candidate.id === item.agentId); const requested = item.requestedProvider || agent?.provider || ''; const providerFlow = item.actualProvider ? `${requested || '—'} → ${item.actualProvider}` : requested ? `${requested} · не запускался` : item.clientProvider || '—'; return `<div class="audit-row"><span>${new Date(item.at).toLocaleString('ru-RU')}</span><span><strong>${escapeHtml(item.action)}</strong><small>${escapeHtml(item.detail || item.task.slice(0, 80))}</small></span><span>${escapeHtml(agent?.name || '—')}</span><span><strong>${escapeHtml(providerFlow)}</strong><small>${escapeHtml(item.phase || item.clientProvider || '')}</small></span><span>${item.skillIds.length}</span><span>${item.durationMs} мс · ${item.contextChars} симв.</span></div>`; }).join('') || '<div class="section-empty">Событий пока нет.</div>'}</div></section>`;
}

function renderAgentRuntime() {
  const cards = Object.entries(agentRuntimeAdapters).map(([id, adapter]) => {
    const assigned = state.agents.filter(agent => agent.provider === id).length;
    const configured = adapter.configured();
    return `<article class="runtime-card ${configured ? 'configured' : ''}"><header><span class="runtime-provider">${escapeHtml(providerLabels[id] || id)}</span><span class="runtime-state">${configured ? 'подключён' : id === 'codex' || id === 'cursor' ? 'не подключён' : 'адаптер готов'}</span></header><p>${escapeHtml(adapter.transport)} · ${assigned} ${assigned === 1 ? 'агент' : 'агентов'}</p><div>${adapter.capabilities.map(capability => `<span>${escapeHtml(capability)}</span>`).join('')}</div></article>`;
  }).join('');
  $('#agentContent').innerHTML = `<section class="runtime-board"><header><div><strong>Провайдер-независимый runtime</strong><span>Подключение MCP даёт доступ к очереди и контексту, но не запускает приложение провайдера автоматически</span></div><button class="secondary-button" id="runtimeIntegrations" type="button">AI-подключения</button></header><div class="runtime-grid">${cards}</div><div class="runtime-contract"><strong>Контракт адаптера</strong><code>register_agent_runtime → claim_agent_run_task → resolve_agent_context → complete_agent_run_task</code><p>Каждый агент выполняется только runtime-подключением из своего поля «Провайдер». Task Manager также может работать через Codex, Cursor, Claude, Copilot, локальную или пользовательскую модель. Назначенный и фактический провайдер видны в аудите.</p></div></section>`;
  $('#runtimeIntegrations').addEventListener('click', () => { renderIntegrationStatus(); $('#integrationDialog').showModal(); });
}

function evaluationStats(rows) {
  const result = mode => { const items = rows.filter(item => item.mode === mode); return { count: items.length, success: items.length ? Math.round(items.filter(item => item.success).length / items.length * 100) : 0, usefulness: items.length ? (items.reduce((sum, item) => sum + item.usefulness, 0) / items.length).toFixed(1) : '—' }; };
  return { baseline: result('baseline'), skillgraph: result('skillgraph') };
}

function renderAgentEvaluation() {
  const project = activeProject();
  if (!project) return void ($('#agentContent').innerHTML = '<div class="empty-state inline"><h2>Выберите проект</h2><p>Оценка сравнивает результаты внутри конкретного проекта.</p></div>');
  const agents = (project.agentIds || []).map(id => state.agents.find(agent => agent.id === id)).filter(Boolean);
  const rows = (state.evaluations || []).filter(item => item.projectId === project.id).slice().reverse();
  const stats = evaluationStats(rows);
  $('#agentContent').innerHTML = `<section class="evaluation-board"><header><div><strong>Оценка качества цепочки</strong><span>Локальное сравнение результата с SkillGraph и без него; полный запрос хранить не требуется</span></div></header><div class="evaluation-summary"><article><span>Без цепочки</span><strong>${stats.baseline.success}%</strong><small>${stats.baseline.count} запусков · полезность ${stats.baseline.usefulness}/5</small></article><article><span>Со SkillGraph</span><strong>${stats.skillgraph.success}%</strong><small>${stats.skillgraph.count} запусков · полезность ${stats.skillgraph.usefulness}/5</small></article></div><form class="evaluation-form" id="evaluationForm"><label>Агент<select name="agentId" required>${agents.map(agent => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name)}</option>`).join('')}</select></label><label>Режим<select name="mode"><option value="skillgraph">Со SkillGraph</option><option value="baseline">Без цепочки</option></select></label><label class="wide">Краткое название задачи<input name="task" maxlength="140" required placeholder="Без чувствительных данных"></label><label>Полезность<select name="usefulness"><option value="5">5 — высокая</option><option value="4">4</option><option value="3" selected>3 — средняя</option><option value="2">2</option><option value="1">1 — низкая</option></select></label><label>Длительность, мс<input name="durationMs" type="number" min="0" value="0"></label><label class="check-line"><input name="success" type="checkbox" checked> Задача выполнена</label><label class="wide">Примечание<textarea name="note" rows="2" placeholder="Короткий вывод без исходного промпта"></textarea></label><button class="primary-button" type="submit" ${agents.length ? '' : 'disabled'}>Записать оценку</button></form><div class="evaluation-list">${rows.map(item => { const agent = state.agents.find(candidate => candidate.id === item.agentId); return `<article><span class="evaluation-mode ${item.mode}">${item.mode === 'skillgraph' ? 'SkillGraph' : 'baseline'}</span><div><strong>${escapeHtml(item.task)}</strong><small>${escapeHtml(agent?.name || 'Удалённый агент')} · ${new Date(item.createdAt).toLocaleString('ru-RU')}</small></div><b>${item.success ? '✓' : '×'} ${item.usefulness}/5</b><p>${escapeHtml(item.note || 'Без примечания')}</p></article>`; }).join('') || '<div class="section-empty">Оценок пока нет.</div>'}</div></section>`;
  $('#evaluationForm').addEventListener('submit', async event => { event.preventDefault(); const data = new FormData(event.currentTarget); const evaluation = normalizeEvaluation({ projectId: project.id, agentId: data.get('agentId'), task: data.get('task'), mode: data.get('mode'), usefulness: data.get('usefulness'), durationMs: data.get('durationMs'), success: data.has('success'), note: data.get('note') }); state.evaluations.push(evaluation); appendAudit('agent-evaluation', { agentId: evaluation.agentId, projectId: project.id, task: evaluation.task, durationMs: evaluation.durationMs, success: evaluation.success, detail: `${evaluation.mode}; usefulness ${evaluation.usefulness}/5` }); await persistRegistry('Оценка агента сохранена'); renderAgentEvaluation(); });
}

const runStatusLabels = { draft: 'Черновик', planning: 'Планирование', running: 'Выполняется', waiting: 'Ожидание', reviewing: 'Проверка', completed: 'Завершён', failed: 'Ошибка', cancelled: 'Отменён', paused: 'Пауза' };
const runTaskStatusLabels = { blocked: 'Заблокирована', queued: 'В очереди', claimed: 'Получена', running: 'В работе', waiting: 'Ожидание', review: 'Проверка', completed: 'Готово', failed: 'Ошибка', cancelled: 'Отменена' };
const deletableRunStatuses = new Set(['completed', 'failed', 'cancelled']);

function projectRuns(projectId) {
  return (state.agentRuns || []).filter(run => run.projectId === projectId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function runTasks(runId) {
  return (state.runTasks || []).filter(task => task.runId === runId);
}

function liveRuntimeFor(provider) {
  const now = Date.now();
  return runtimeSessions.find(session => session.provider === provider && Date.parse(session.lastSeenAt || 0) > now - 120000);
}

async function createLocalAgentRun(project, requestSummary, taskManagerAgentId) {
  const taskManager = state.agents.find(agent => agent.id === taskManagerAgentId && (project.agentIds || []).includes(agent.id));
  if (!taskManager) return showToast('Выберите управляющего агента проекта');
  try {
    const result = await window.skillGraphDesktop.createAgentRun({ projectId: project.id, taskManagerAgentId: taskManager.id, title: requestSummary.slice(0, 90), request: requestSummary, clientProvider: taskManager.provider });
    activeRunId = result.run.id; selectedRunTaskId = result.planningTask.id;
    await refreshExternalRegistry();
    $('#runtimeState').textContent = 'Цепочка поставлена в очередь';
  } catch (error) { console.error(error); showToast(error.message || 'Не удалось создать запуск'); }
}

async function setLocalRunState(run, action) {
  try {
    const provider = state.agents.find(agent => agent.id === run.taskManagerAgentId)?.provider;
    if (!provider) throw new Error('Провайдер Task Manager не найден');
    if (action === 'pause') await window.skillGraphDesktop.pauseAgentRun(run.id, provider);
    else if (action === 'resume') await window.skillGraphDesktop.resumeAgentRun(run.id, provider);
    else await window.skillGraphDesktop.cancelAgentRun(run.id, provider);
    await refreshExternalRegistry();
  } catch (error) { console.error(error); showToast(error.message || 'Не удалось изменить запуск'); }
}

async function deleteLocalAgentRun(run) {
  if (!run || !deletableRunStatuses.has(run.status)) return showToast('Сначала завершите или отмените агентную цепочку');
  if (!confirm(`Удалить цепочку «${run.title}» вместе с её задачами, артефактами и handoff? Файлы проекта удалены не будут.`)) return;
  try {
    const provider = state.agents.find(agent => agent.id === run.taskManagerAgentId)?.provider;
    if (!provider) throw new Error('Провайдер Task Manager не найден');
    await window.skillGraphDesktop.deleteAgentRun(run.id, provider);
    activeRunId = null;
    selectedRunTaskId = null;
    await refreshExternalRegistry();
    showToast('Агентная цепочка удалена');
  } catch (error) { console.error(error); showToast(error.message || 'Не удалось удалить цепочку'); }
}

function renderAgentExecution() {
  rememberAgentExecutionViewport();
  const project = activeProject();
  if (!project) return void ($('#agentContent').innerHTML = '<div class="empty-state inline"><h2>Выберите проект</h2><p>Запуски и дорожки исполнителей привязаны к проекту.</p></div>');
  const runs = projectRuns(project.id);
  if (!runs.some(run => run.id === activeRunId)) activeRunId = runs[0]?.id || null;
  const run = runs.find(item => item.id === activeRunId) || null;
  const allTasks = run ? runTasks(run.id) : [];
  const tasks = allTasks.filter(task => !task.supersededAt);
  const previousStatuses = run ? runTaskStatusesByRun.get(run.id) : null;
  const nextTask = run ? window.SkillGraphRunLayout?.nextRunTaskAfterCompletion(tasks, previousStatuses) : null;
  if (run) runTaskStatusesByRun.set(run.id, Object.fromEntries(tasks.map(task => [String(task.id), task.status])));
  if (nextTask && run) pendingRunAutoFocus = { runId: run.id, taskId: nextTask.id };
  const autoFocusTaskId = run && pendingRunAutoFocus?.runId === run.id ? pendingRunAutoFocus.taskId : null;
  if (autoFocusTaskId) selectedRunTaskId = autoFocusTaskId;
  if (run && !tasks.some(task => task.id === selectedRunTaskId)) selectedRunTaskId = tasks.find(task => ['running', 'claimed', 'queued'].includes(task.status))?.id || tasks[0]?.id || null;
  const selectedTask = tasks.find(task => task.id === selectedRunTaskId) || null;
  const selectedAgent = selectedTask ? state.agents.find(agent => agent.id === selectedTask.agentId) : null;
  const managerCandidates = (project.agentIds || []).map(id => state.agents.find(agent => agent.id === id)).filter(agent => agent?.status === 'active' && agent.permissions?.read);
  const preferredManager = managerCandidates.find(agent => agent.id === run?.taskManagerAgentId) || managerCandidates.find(agent => agent.id === 'task-agent') || managerCandidates[0];
  const progress = window.SkillGraphRunLayout?.runProgress(tasks) || { completed: 0, total: tasks.length, percent: 0 };
  let graphHtml = '<div class="run-empty"><strong>Запусков пока нет</strong><span>Выберите управляющего агента и опишите задачу. Планирование и выполнение пройдут через провайдеры, указанные в профилях агентов.</span></div>';
  if (run && tasks.length) {
    const graph = window.SkillGraphRunLayout.buildSwimlaneLayout(run, tasks, state.agents);
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const paths = graph.edges.map(edge => { const from = nodes.get(edge.from); const to = nodes.get(edge.to); if (!from || !to) return ''; const x1 = from.x + 166; const y1 = from.y + 34; const x2 = to.x; const y2 = to.y + 34; const bend = Math.max(32, (x2 - x1) / 2); return `<path d="M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}"/>`; }).join('');
    const lanes = graph.lanes.map(lane => `<div class="run-lane-label" style="top:${lane.y}px;--agent-color:${escapeHtml(lane.agent.color)}"><i></i><strong>${escapeHtml(lane.agent.name)}</strong><span>${escapeHtml(providerLabels[lane.agent.provider] || lane.agent.provider || '—')}${liveRuntimeFor(lane.agent.provider) ? ' · онлайн' : ' · ожидает runtime'}</span></div><div class="run-lane-line" style="top:${lane.y + 57}px;width:${graph.width - 18}px"></div>`).join('');
    const nodeRows = graph.nodes.map(node => { const agent = state.agents.find(item => item.id === node.agentId); return `<button class="run-task-node ${node.status} ${node.id === selectedRunTaskId ? 'selected' : ''}" data-run-task="${escapeHtml(node.id)}" type="button" style="left:${node.x}px;top:${node.y}px;--agent-color:${escapeHtml(agent?.color || '#777777')}" title="${escapeHtml(node.title)}"><span>${escapeHtml(runTaskStatusLabels[node.status] || node.status)}</span><strong>${escapeHtml(node.title)}</strong><small>${Math.round(node.progress || 0)}% · ${escapeHtml(providerLabels[node.provider] || node.provider || '—')}</small></button>`; }).join('');
    graphHtml = `<div class="run-swimlane" id="runSwimlane" data-run-id="${escapeHtml(run.id)}"><div class="run-canvas-shell" style="width:${Math.ceil(graph.width * runGraphScale)}px;height:${Math.ceil(graph.height * runGraphScale)}px"><div class="run-canvas" style="width:${graph.width}px;height:${graph.height}px;transform:scale(${runGraphScale})">${lanes}<svg class="run-edges" width="${graph.width}" height="${graph.height}" aria-hidden="true">${paths}</svg>${nodeRows}</div></div></div>`;
  }
  const dependencies = selectedTask ? selectedTask.dependsOn.map(id => allTasks.find(task => task.id === id)?.title || id) : [];
  const dependants = selectedTask ? tasks.filter(task => task.dependsOn.includes(selectedTask.id)).map(task => task.title) : [];
  const artifacts = selectedTask ? (state.runArtifacts || []).filter(item => item.taskId === selectedTask.id) : [];
  const handoffs = selectedTask ? (state.handoffs || []).filter(item => item.taskId === selectedTask.id) : [];
  const runtime = selectedTask?.leaseOwner ? runtimeSessions.find(item => item.id === selectedTask.leaseOwner) : null;
  const skillNames = (selectedAgent?.rootSkills || []).map(id => state.skills.find(skill => skill.id === id)).filter(Boolean).map(skillName);
  const assignableAgents = selectedTask ? (project.agentIds || []).map(id => state.agents.find(agent => agent.id === id)).filter(agent => agent && agent.permissions?.read && (selectedTask.workspaceMode !== 'project-write' || agent.permissions?.edit || agent.permissions?.create)) : [];
  const detail = selectedTask ? `<aside class="run-task-detail" style="--agent-color:${escapeHtml(selectedAgent?.color || '#777777')}"><header><div><strong>${escapeHtml(selectedTask.title)}</strong><span>${escapeHtml(selectedAgent?.name || selectedTask.agentId)} · ${escapeHtml(providerLabels[selectedTask.provider] || selectedTask.provider || '—')}</span></div><b>${escapeHtml(runTaskStatusLabels[selectedTask.status] || selectedTask.status)}</b></header><p>${escapeHtml(selectedTask.instructions || 'Инструкции будут добавлены Task Manager.')}</p><dl><div><dt>Рабочий режим</dt><dd>${escapeHtml(selectedTask.workspaceMode)}</dd></div><div><dt>Попытка</dt><dd>${selectedTask.attempt}/${selectedTask.maxAttempts}</dd></div><div><dt>Прогресс</dt><dd>${selectedTask.progress}%</dd></div><div><dt>Runtime</dt><dd>${escapeHtml(runtime?.clientName || selectedTask.leaseOwner || 'не занят')}</dd></div><div><dt>Создана</dt><dd>${new Date(selectedTask.createdAt).toLocaleString('ru-RU')}</dd></div><div><dt>Обновлена</dt><dd>${new Date(selectedTask.updatedAt).toLocaleString('ru-RU')}</dd></div></dl><section><b>Зависимости</b><span>${escapeHtml(dependencies.join(' · ') || 'нет')}</span><b>Следующие этапы</b><span>${escapeHtml(dependants.join(' · ') || 'нет')}</span><b>Скиллы</b><span>${escapeHtml(skillNames.join(' · ') || 'нет')}</span><b>Артефакты / handoff</b><span>${escapeHtml([...artifacts.map(item => item.path), ...handoffs.map(item => item.id)].join(' · ') || 'нет')}</span></section>${selectedTask.progressMessage ? `<small>${escapeHtml(selectedTask.progressMessage)}</small>` : ''}${selectedTask.error ? `<pre>${escapeHtml(selectedTask.error)}</pre>` : ''}${!['running','claimed','completed','cancelled'].includes(selectedTask.status) ? `<div class="run-task-actions"><select id="runTaskAgent" aria-label="Переназначить агента">${assignableAgents.map(agent => `<option value="${escapeHtml(agent.id)}" ${agent.id === selectedTask.agentId ? 'selected' : ''}>${escapeHtml(agent.name)}</option>`).join('')}</select><button class="secondary-button" id="reassignRunTask" type="button">Переназначить</button>${selectedTask.status === 'failed' && selectedTask.attempt < selectedTask.maxAttempts ? '<button class="secondary-button" id="retryRunTask" type="button">Повторить</button>' : ''}</div>` : ''}</aside>` : '<aside class="run-task-detail empty"><span>Выберите этап на графе</span></aside>';
  $('#agentContent').innerHTML = `<section class="agent-execution"><header class="run-toolbar"><div><strong>Автономное исполнение</strong><span>Управляющий агент строит план через свой провайдер; каждый исполнитель получает этап только в runtime своего провайдера</span></div><div class="run-selector"><select id="agentRunSelect" aria-label="Запуск"><option value="">Новый запуск</option>${runs.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === activeRunId ? 'selected' : ''}>${escapeHtml(item.title)} · ${escapeHtml(runStatusLabels[item.status] || item.status)}</option>`).join('')}</select>${run ? `<button class="secondary-button delete-run-button" id="deleteAgentRun" type="button" title="${deletableRunStatuses.has(run.status) ? 'Удалить цепочку' : 'Сначала завершите или отмените цепочку'}" aria-label="Удалить выбранную цепочку" ${deletableRunStatuses.has(run.status) ? '' : 'disabled'}><svg><use href="#i-trash"/></svg></button>` : ''}</div></header><form class="run-create" id="agentRunForm"><textarea id="agentRunRequest" rows="2" required placeholder="Опишите результат, который должна создать агентная цепочка"></textarea><label><span>Управляющий агент</span><select id="agentRunManager" required>${managerCandidates.map(agent => `<option value="${escapeHtml(agent.id)}" ${agent.id === preferredManager?.id ? 'selected' : ''}>${escapeHtml(agent.name)} · ${escapeHtml(providerLabels[agent.provider] || agent.provider)}</option>`).join('')}</select></label><button class="primary-button" type="submit" ${managerCandidates.length ? '' : 'disabled'}>Запустить цепочку</button></form>${run ? `<div class="run-summary"><span class="run-status ${escapeHtml(run.status)}">${escapeHtml(runStatusLabels[run.status] || run.status)}</span><div class="run-progress-copy"><strong>${progress.percent}%</strong><span>${progress.completed} из ${progress.total} этапов</span></div><progress max="100" value="${progress.percent}" aria-label="Прогресс выполнения"></progress><div class="run-summary-controls"><div class="run-zoom" role="group" aria-label="Масштаб графа"><button type="button" data-run-zoom="out" title="Уменьшить масштаб" aria-label="Уменьшить масштаб">−</button><span aria-live="polite">${Math.round(runGraphScale * 100)}%</span><button type="button" data-run-zoom="in" title="Увеличить масштаб" aria-label="Увеличить масштаб">+</button></div><button class="secondary-button" id="focusCurrentRunTask" type="button">Показать текущий этап</button>${run.status === 'paused' ? '<button class="secondary-button" data-run-action="resume" type="button">Продолжить</button>' : '<button class="secondary-button" data-run-action="pause" type="button">Пауза</button>'}<button class="secondary-button danger-action" data-run-action="cancel" type="button">Отменить</button></div></div>` : ''}<div class="run-workspace">${graphHtml}${detail}</div></section>`;
  $('#agentRunForm').addEventListener('submit', async event => { event.preventDefault(); const value = $('#agentRunRequest').value.trim(); if (value) await createLocalAgentRun(project, value, $('#agentRunManager').value); });
  $('#agentRunSelect').addEventListener('change', event => { rememberAgentExecutionViewport(); activeRunId = event.currentTarget.value || null; selectedRunTaskId = null; renderAgentExecution(); });
  $('#deleteAgentRun')?.addEventListener('click', () => deleteLocalAgentRun(run));
  $$('[data-run-task]').forEach((button, index, buttons) => { button.addEventListener('click', () => { selectedRunTaskId = button.dataset.runTask; renderAgentExecution(); }); button.addEventListener('keydown', event => { const delta = ['ArrowRight','ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft','ArrowUp'].includes(event.key) ? -1 : 0; if (!delta) return; event.preventDefault(); selectedRunTaskId = buttons[(index + delta + buttons.length) % buttons.length].dataset.runTask; renderAgentExecution(); requestAnimationFrame(() => document.querySelector(`[data-run-task="${CSS.escape(selectedRunTaskId)}"]`)?.focus()); }); });
  $$('[data-run-zoom]').forEach(button => button.addEventListener('click', () => { runGraphScale = Math.max(.55, Math.min(1.6, runGraphScale + (button.dataset.runZoom === 'in' ? .1 : -.1))); renderAgentExecution(); }));
  $$('[data-run-action]').forEach(button => button.addEventListener('click', () => run && setLocalRunState(run, button.dataset.runAction)));
  $('#focusCurrentRunTask')?.addEventListener('click', () => { const current = window.SkillGraphRunLayout?.currentRunTask(tasks); if (!current || !run) return; selectedRunTaskId = current.id; pendingRunAutoFocus = { runId: run.id, taskId: current.id }; renderAgentExecution(); });
  $('#retryRunTask')?.addEventListener('click', async () => { try { const provider = state.agents.find(agent => agent.id === run.taskManagerAgentId)?.provider; await window.skillGraphDesktop.retryAgentRunTask(selectedTask.id, provider); await refreshExternalRegistry(); } catch (error) { console.error(error); showToast(error.message || 'Не удалось повторить этап'); } });
  $('#reassignRunTask')?.addEventListener('click', async () => { const agentId = $('#runTaskAgent').value; if (!agentId || agentId === selectedTask.agentId) return; try { const provider = state.agents.find(agent => agent.id === run.taskManagerAgentId)?.provider; await window.skillGraphDesktop.reassignAgentRunTask(selectedTask.id, agentId, provider); await refreshExternalRegistry(); } catch (error) { console.error(error); showToast(error.message || 'Не удалось переназначить этап'); } });
  enhanceCustomSelects($('#agentContent'));
  restoreAgentExecutionViewport(run?.id, selectedTask?.id, autoFocusTaskId);
}

function rememberAgentExecutionViewport() {
  const content = $('#agentContent');
  if (content?.querySelector('.agent-execution')) executionDocumentScrollTop = content.scrollTop;
  const viewport = $('#runSwimlane');
  if (viewport?.dataset.runId) runViewportById.set(viewport.dataset.runId, { left: viewport.scrollLeft, top: viewport.scrollTop });
  const detail = content?.querySelector('.run-task-detail');
  if (detail && selectedRunTaskId) runDetailScrollByTaskId.set(selectedRunTaskId, detail.scrollTop);
}

function focusRunTaskNode(taskId, behavior = 'auto') {
  const viewport = $('#runSwimlane');
  const node = taskId ? document.querySelector(`[data-run-task="${CSS.escape(taskId)}"]`) : null;
  if (!viewport || !node) return;
  const viewportRect = viewport.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  const left = viewport.scrollLeft + nodeRect.left - viewportRect.left - (viewport.clientWidth - nodeRect.width) / 2;
  const top = viewport.scrollTop + nodeRect.top - viewportRect.top - (viewport.clientHeight - nodeRect.height) / 2;
  viewport.scrollTo({
    left: Math.max(0, Math.min(left, viewport.scrollWidth - viewport.clientWidth)),
    top: Math.max(0, Math.min(top, viewport.scrollHeight - viewport.clientHeight)),
    behavior
  });
  node.focus({ preventScroll: true });
}

function restoreAgentExecutionViewport(runId, taskId, autoFocusTaskId) {
  requestAnimationFrame(() => {
    const content = $('#agentContent');
    if (content) content.scrollTop = executionDocumentScrollTop;
    const viewport = $('#runSwimlane');
    const saved = runId ? runViewportById.get(runId) : null;
    if (viewport) {
      if (saved && !autoFocusTaskId) viewport.scrollTo({ left: saved.left, top: saved.top, behavior: 'auto' });
      viewport.addEventListener('scroll', () => {
        if (runId) runViewportById.set(runId, { left: viewport.scrollLeft, top: viewport.scrollTop });
      }, { passive: true });
    }
    const detail = content?.querySelector('.run-task-detail');
    if (detail && taskId) detail.scrollTop = runDetailScrollByTaskId.get(taskId) || 0;
    if (autoFocusTaskId) {
      focusRunTaskNode(autoFocusTaskId, 'smooth');
      if (pendingRunAutoFocus?.runId === runId && pendingRunAutoFocus.taskId === autoFocusTaskId) pendingRunAutoFocus = null;
    }
  });
}

function setAgentProjectMenuOpen(open) {
  const button = $('#agentProjectButton');
  const dropdown = $('#agentProjectDropdown');
  if (!button || !dropdown) return;
  const nextOpen = Boolean(open && !button.disabled);
  button.setAttribute('aria-expanded', String(nextOpen));
  dropdown.hidden = !nextOpen;
}

function renderAgents() {
  const modeTabs = $('#agentModeTabs');
  if (modeTabs) agentModeTabsScrollLeft = modeTabs.scrollLeft;
  const project = activeProject();
  $('#agentProjectLabel').textContent = project?.name || 'Нет проектов';
  $('#agentProjectButton').disabled = !state.projects.length;
  $('#agentProjectDropdown').innerHTML = state.projects.map(item => `<button type="button" role="option" data-agent-project="${escapeHtml(item.id)}" aria-selected="${item.id === activeProjectId}" style="--project-color:${escapeHtml(item.color || '#8b6de9')}"><span>${escapeHtml(item.name)}</span></button>`).join('') || '<div class="tree-empty">Нет проектов</div>';
  setAgentProjectMenuOpen(false);
  $('#agentsStats').textContent = `${state.agents.length} ${state.agents.length === 1 ? 'агент' : state.agents.length >= 2 && state.agents.length <= 4 ? 'агента' : 'агентов'}`;
  $('#agentList').innerHTML = state.agents.map(agent => `<button class="agent-list-row ${agent.id === activeAgentId ? 'active' : ''}" data-agent="${escapeHtml(agent.id)}" type="button" style="--agent-color:${escapeHtml(agent.color)}"><span class="agent-avatar"><svg><use href="#i-agent"/></svg></span><span><strong>${escapeHtml(agent.name)}</strong><small>${escapeHtml(agent.role)}</small></span><span class="count">${agent.rootSkills.length}</span></button>`).join('') || '<div class="tree-empty">Нет агентов</div>';
  $$('[data-agent-mode]').forEach(button => button.classList.toggle('active', button.dataset.agentMode === agentViewMode));
  requestAnimationFrame(() => { if (modeTabs) modeTabs.scrollLeft = agentModeTabsScrollLeft; });
  $$('[data-agent-project]').forEach(button => button.addEventListener('click', () => { activeProjectId = button.dataset.agentProject || null; setAgentProjectMenuOpen(false); renderAgents(); renderProjectsList(); renderProjectView(); }));
  $$('.agent-list-row').forEach(button => {
    button.addEventListener('click', () => { activeAgentId = button.dataset.agent; agentViewMode = 'profiles'; renderAgents(); });
    bindAgentDropTarget(button, button.dataset.agent);
  });
  if (agentViewMode === 'route') renderAgentRoute();
  else if (agentViewMode === 'routing') renderAgentRouting();
  else if (agentViewMode === 'execution') renderAgentExecution();
  else if (agentViewMode === 'handoffs') renderAgentHandoffs();
  else if (agentViewMode === 'audit') renderAgentAudit();
  else if (agentViewMode === 'runtime') renderAgentRuntime();
  else if (agentViewMode === 'evaluation') renderAgentEvaluation();
  else renderAgentProfiles();
  enhanceCustomSelects($('#agentContent'));
}

function renderLibrary() {
  const skills = visibleSkills();
  $('#libraryStats').textContent = `${skills.length} ${skills.length === 1 ? 'скилл' : 'скиллов'} · ${registryScope === 'project' ? 'проект' : 'общий реестр'}`;
  if ($('#openSources')) $('#openSources').textContent = `Источники (${state.sources.length})`;
  if (!skills.length) {
    $('#libraryGrid').innerHTML = '<div class="empty-state inline"><h2>Библиотека пуста</h2><p>Создайте скилл или импортируйте готовый Markdown/JSON.</p><div><button class="primary-button open-add" type="button">Создать</button><button class="secondary-button open-import" type="button">Импортировать</button></div></div>';
    bindOpenButtons();
    return;
  }
  $('#libraryGrid').innerHTML = skills.map(skill => `<button class="library-card" data-skill="${escapeHtml(skill.id)}" type="button"><header><span class="skill-icon purple">${escapeHtml(skillIcon(skill))}</span><div><strong>${escapeHtml(skillName(skill))}</strong><code>${escapeHtml(skill.namespace)}.${escapeHtml(skill.id)}</code></div><span class="version-pill">${escapeHtml(skill.version)}</span></header><p>${escapeHtml(skill.description || 'Без описания')}</p><footer><span>${skill.deps.length} связей</span><span>${escapeHtml(skill.status)}</span></footer></button>`).join('');
  $$('.library-card').forEach(card => card.addEventListener('click', () => { if (openSkill(card.dataset.skill)) switchView('workspace'); }));
}

function renderInspector() {
  const skill = activeSkill();
  if (!skill) { $('#inspectorContent').innerHTML = '<div class="empty-inspector">Выберите скилл, чтобы увидеть свойства.</div>'; return; }
  const used = state.projects.filter(project => project.roots.includes(skill.id));
  const images = skill.images || [];
  $('#inspectorContent').innerHTML = `
    <div class="skill-identity"><div class="large-skill-icon">${escapeHtml(skillIcon(skill))}</div><div><strong>${escapeHtml(skillName(skill))}</strong><code>${escapeHtml(skill.id)}</code></div></div>
    <div class="inspector-actions"><button class="secondary-button compact-button favorite-toggle ${skill.favorite ? 'is-favorite' : ''}" id="favoriteSkill" type="button" title="${skill.favorite ? 'Убрать из избранного' : 'Добавить в избранное'}" aria-label="${skill.favorite ? 'Убрать из избранного' : 'Добавить в избранное'}"><svg><use href="#i-star"/></svg></button><button class="secondary-button compact-button" id="renameSkill" type="button" title="Переименовать"><svg><use href="#i-pencil"/></svg></button><button class="danger-button" id="deleteSkill" type="button" title="Удалить скилл"><svg><use href="#i-trash"/></svg></button></div>
    <section class="inspector-section"><div class="inspector-heading"><strong>Описание</strong></div><div class="inspector-description">${escapeHtml(skill.description || 'Описание пока не добавлено.')}</div></section>
    <div class="metadata-list"><div><span>Версия</span><b>${escapeHtml(skill.version)}</b></div><div><span>Статус</span><b class="status published">${escapeHtml(skill.status)}</b></div><div><span>Namespace</span><b>${escapeHtml(skill.namespace)}</b></div><div><span>Изменён</span><b>${new Date(skill.updatedAt).toLocaleDateString('ru-RU')}</b></div></div>
    <section class="inspector-section"><div class="inspector-heading"><strong>Зависимости</strong><span>${skill.deps.length}</span></div>${skill.deps.map(dep => `<div class="dependency-item"><span class="dependency-type ${escapeHtml(dep.type)}"></span><div><strong>${escapeHtml(dep.id)}</strong><small>${escapeHtml(dep.type)} · ${escapeHtml(dep.range)}</small></div></div>`).join('') || '<span class="empty-note">Нет зависимостей</span>'}</section>
    <section class="inspector-section"><div class="inspector-heading"><strong>Изображения</strong><span>${images.length}</span></div><button class="secondary-button attach-image" id="attachSkillImage" type="button"><svg><use href="#i-plus"/></svg> Добавить изображение</button><div class="skill-images">${images.map(image => `<article class="skill-image-card"><button class="image-open" data-image-open="${escapeHtml(image.id)}" type="button" title="Открыть изображение"><img src="${escapeHtml(imageAssetUrl(image))}" alt="${escapeHtml(image.caption)}"></button><div><strong>${escapeHtml(image.caption || image.name)}</strong><small>расширяет · ${escapeHtml(image.name)}</small></div><button class="image-remove" data-image-remove="${escapeHtml(image.id)}" type="button" aria-label="Удалить изображение"><svg><use href="#i-trash"/></svg></button></article>`).join('') || '<span class="empty-note">Изображения не прикреплены</span>'}</div></section>
    <section class="inspector-section"><div class="inspector-heading"><strong>Корневой в проектах</strong><span>${used.length}</span></div>${used.map(project => `<div class="used-project"><span class="project-dot" style="background:${escapeHtml(project.color)}"></span><div><strong>${escapeHtml(project.name)}</strong><small>root</small></div></div>`).join('') || '<span class="empty-note">Не подключён</span>'}</section>
    <section class="inspector-section"><div class="inspector-heading"><strong>Теги</strong></div><div class="tags">${skill.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('') || '<span>без тегов</span>'}</div></section>`;
  $('#favoriteSkill').addEventListener('click', async () => { skill.favorite = !skill.favorite; await persistRegistry(); renderAll(); });
  $('#renameSkill').addEventListener('click', openRenameDialog);
  $('#deleteSkill').addEventListener('click', () => deleteSkill(skill.id));
  $('#attachSkillImage').addEventListener('click', attachImageToActiveSkill);
  $$('[data-image-open]').forEach(button => button.addEventListener('click', () => openImagePreview(button.dataset.imageOpen)));
  $$('[data-image-remove]').forEach(button => button.addEventListener('click', () => removeSkillImage(button.dataset.imageRemove)));
}

async function attachImageToActiveSkill() {
  const skill = activeSkill();
  if (!skill) return;
  if (!window.skillGraphDesktop?.pickSkillImage) return showToast('Добавление изображений доступно в настольной версии');
  const raw = await window.skillGraphDesktop.pickSkillImage();
  if (!raw) return;
  const image = normalizeImage(raw);
  image.caption = image.name.replace(/\.[^.]+$/, '');
  skill.images ||= [];
  skill.images.push(image);
  const reference = `![${image.caption}](skillgraph-asset://${image.id})`;
  if (!skill.content.includes(reference)) skill.content = `${skill.content.trimEnd()}\n\n## Изображения\n\n${reference}\n`;
  skill.updatedAt = new Date().toISOString();
  editor.value = skill.content;
  savedEditorValue = skill.content;
  updateEditor();
  await persistRegistry('Изображение добавлено');
  renderAll();
  showToast('Изображение связано со скиллом как «расширяет»');
}

async function removeSkillImage(imageId) {
  const skill = activeSkill();
  const image = skill?.images?.find(item => item.id === imageId);
  if (!skill || !image || !confirm(`Удалить изображение «${image.caption || image.name}»?`)) return;
  skill.images = skill.images.filter(item => item.id !== imageId);
  skill.content = skill.content.replace(new RegExp(`^!?\\[[^\\]]*\\]\\(skillgraph-asset:\\/\\/${escapeRegex(imageId)}\\)\\s*$`, 'gm'), '').replace(/\n{3,}/g, '\n\n');
  delete state.settings.graphPositions?.[`asset:${imageId}`];
  try { await window.skillGraphDesktop?.deleteSkillImage?.(image.relativePath); } catch (error) { console.error(error); }
  skill.updatedAt = new Date().toISOString();
  editor.value = skill.content;
  savedEditorValue = skill.content;
  updateEditor();
  await persistRegistry('Изображение удалено');
  renderAll();
}

function openImagePreview(imageId) {
  const image = findImage(imageId);
  if (!image) return;
  $('#imagePreview').src = imageAssetUrl(image);
  $('#imagePreview').alt = image.caption || image.name;
  $('#imagePreviewTitle').textContent = image.caption || image.name;
  $('#imagePreviewPath').textContent = image.path || image.relativePath;
  $('#imagePreviewDialog').showModal();
}

function openRenameDialog() {
  const skill = activeSkill();
  if (!skill) return;
  const form = $('#renameForm');
  form.elements.id.value = skill.id;
  form.elements.name.value = skillName(skill);
  form.elements.namespace.value = skill.namespace;
  form.elements.tags.value = skill.tags.join(', ');
  $('#renameDialog').showModal();
}

async function deleteSkill(id) {
  const skill = state.skills.find(item => item.id === id);
  if (!skill || !confirm(`Удалить скилл «${skillName(skill)}»? Связи с ним также будут удалены.`)) return;
  if (window.skillGraphDesktop?.deleteSkillImage) {
    await Promise.allSettled((skill.images || []).map(image => window.skillGraphDesktop.deleteSkillImage(image.relativePath)));
  }
  state.skills = state.skills.filter(item => item.id !== id);
  openSkillTabs = openSkillTabs.filter(tabId => tabId !== id);
  state.skills.forEach(item => { item.deps = item.deps.filter(dep => dep.id !== id); });
  state.projects.forEach(project => { project.roots = project.roots.filter(root => root !== id); });
  state.agents.forEach(agent => { agent.rootSkills = agent.rootSkills.filter(root => root !== id); });
  clearEditor();
  activeSkillId = openSkillTabs.find(tabId => state.skills.some(skillItem => skillItem.id === tabId)) || state.skills[0]?.id || null;
  if (activeSkillId) openSkill(activeSkillId, true);
  await persistRegistry('Скилл удалён');
  renderAll();
}

function resolveProject(project) {
  const order = [];
  const visited = new Set();
  const visiting = new Set();
  const conflicts = [];
  const visit = (id, source = null) => {
    if (visiting.has(id)) { conflicts.push(`Циклическая зависимость: ${source} → ${id}`); return; }
    if (visited.has(id)) return;
    const skill = state.skills.find(item => item.id === id);
    if (!skill) { conflicts.push(`Не найден скилл: ${id}`); return; }
    visiting.add(id);
    skill.deps.filter(dep => dep.type !== 'recommends').forEach(dep => visit(dep.id, id));
    skill.deps.filter(dep => dep.type === 'recommends').forEach(dep => visit(dep.id, id));
    visiting.delete(id);
    visited.add(id);
    order.push(skill);
  };
  project.roots.forEach(id => visit(id));
  return { order, conflicts: [...new Set(conflicts)] };
}

function providerState(provider) {
  return integrationStatus[`${provider}Status`] || {
    healthy: Boolean(integrationStatus[provider]),
    configured: Boolean(integrationStatus[provider]),
    reason: integrationStatus[provider] ? 'MCP отвечает' : 'Подключение не проверено'
  };
}

function renderIntegrationStatus() {
  const providers = supportedProviders;
  const healthy = providers.filter(provider => providerState(provider).healthy).length;
  $('#connectionSummary').textContent = `${healthy}/${providers.length}`;
  $('#connectionSummary').title = `${healthy} из ${providers.length} MCP-подключений подтверждены handshake-проверкой`;
  const icons = { codex: 'CDX', cursor: 'CUR', claude: 'CLA', copilot: 'COP', deepseek: 'DS', qwen: 'QW', local: 'LOC', custom: 'AI' };
  $('#integrationList').innerHTML = providers.map(provider => {
    const status = providerState(provider);
    const stateClass = status.healthy ? 'healthy' : (status.configured ? 'broken' : '');
    const portable = !['codex', 'cursor'].includes(provider);
    const stateText = status.healthy ? (portable ? 'MCP-профиль готов' : 'Подключено и отвечает') : (status.configured ? 'Настроено, но не работает' : 'Не подключено');
    const action = portable && status.configured ? 'Копировать конфиг' : status.healthy ? 'Переустановить' : (status.configured ? 'Исправить подключение' : portable ? 'Создать MCP-профиль' : 'Подключить');
    return `<article class="integration-row"><div class="integration-icon">${icons[provider]}</div><div class="integration-copy"><strong>${providerLabels[provider]}</strong><span class="integration-status ${stateClass}">${stateText}</span><span>${escapeHtml(status.reason || '')}</span><code title="${escapeHtml(status.connectorPath || '')}">${escapeHtml(status.connectorPath || 'Путь к MCP появится после подключения')}</code></div><button class="secondary-button integration-action" data-provider="${provider}" type="button">${action}</button></article>`;
  }).join('');
  $$('.integration-action').forEach(button => button.addEventListener('click', () => connectProvider(button.dataset.provider, button)));
}

async function refreshIntegrationStatus(showMessage = false) {
  if (!window.skillGraphDesktop) return;
  try {
    const statuses = await Promise.all(supportedProviders.map(provider => window.skillGraphDesktop.getProviderStatus(provider)));
    integrationStatus = Object.fromEntries(supportedProviders.flatMap((provider, index) => [[provider, Boolean(statuses[index].healthy)], [`${provider}Status`, statuses[index]]]));
    renderIntegrationStatus();
    renderProjectView();
    if (showMessage) showToast('Состояние MCP проверено');
  } catch (error) {
    console.error(error);
    if (showMessage) showToast(`Проверка MCP не удалась: ${error.message}`);
  }
}

async function connectProvider(provider, button) {
  const method = window.skillGraphDesktop?.connectProvider;
  if (!method) return showToast('Подключение доступно в настольной версии');
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = 'Проверка…';
  try {
    const result = await method(provider);
    integrationStatus[`${provider}Status`] = result;
    integrationStatus[provider] = Boolean(result.healthy ?? result[provider]);
    renderIntegrationStatus();
    renderProjectView();
    if (result.configJson && window.skillGraphDesktop?.copyText) await window.skillGraphDesktop.copyText(result.configJson);
    showToast(result.healthy ? `${providerLabels[provider]}: ${result.portable ? 'MCP-профиль создан и скопирован' : 'подключение настроено, MCP отвечает'}` : (result.reason || 'Конфигурация записана, но MCP не ответил'));
  } catch (error) {
    button.textContent = previous;
    button.disabled = false;
    showToast(`Не удалось подключить: ${error.message}`);
  }
}

function renderProjectView() {
  const project = activeProject();
  setProjectActionsOpen(false);
  $('#projectActions').hidden = !project;
  $('#resolveButton').disabled = !project;
  renderIntegrationStatus();
  $('#activeProjectStatus').textContent = project?.name || 'Нет активного проекта';
  if (!project) {
    $('#projectTitle').textContent = 'Проекты';
    $('#projectSubtitle').textContent = 'Связывайте проекты с цепочками скиллов';
    $('#projectContent').innerHTML = '<div class="empty-state inline"><h2>Проектов пока нет</h2><p>Добавьте проект, а затем подключите к нему корневые скиллы.</p><button class="primary-button" id="emptyAddProject" type="button">Добавить проект</button></div>';
    $('#emptyAddProject').addEventListener('click', openProjectDialog);
    return;
  }
  const resolved = resolveProject(project);
  $('#projectTitle').textContent = project.name;
  $('#projectSubtitle').textContent = project.location || 'Локальная связь';
  const renderBranch = (id, trail = new Set()) => {
    if (trail.has(id)) return `<li class="nested-cycle">↻ ${escapeHtml(id)}</li>`;
    const skill = state.skills.find(item => item.id === id);
    if (!skill) return `<li class="nested-missing">${escapeHtml(id)} — не найден</li>`;
    const nextTrail = new Set(trail); nextTrail.add(id);
    const children = skill.deps.map(dep => renderBranch(dep.id, nextTrail)).join('');
    return `<li><span class="dependency-type ${escapeHtml(skill.deps[0]?.type || 'requires')}"></span><button class="nested-skill-link" data-skill="${escapeHtml(skill.id)}" type="button">${escapeHtml(skillName(skill))}</button><code>${escapeHtml(skill.version)}</code>${children ? `<ul>${children}</ul>` : ''}</li>`;
  };
  const rootRows = project.roots.map(id => {
    const skill = state.skills.find(item => item.id === id);
    const descendants = skill ? resolveProject({ roots: [id] }).order.filter(item => item.id !== id) : [];
    const nested = skill?.deps.map(dep => renderBranch(dep.id, new Set([id]))).join('') || '';
    return `<article class="root-skill-card"><header><span class="skill-icon purple">${escapeHtml(skill ? skillIcon(skill) : '?')}</span><div><strong>${escapeHtml(skill ? skillName(skill) : id)}</strong><span>${escapeHtml(skill ? `${skill.namespace}.${skill.id}` : 'Скилл не найден')}</span></div><span class="version-pill">${escapeHtml(skill?.version || 'missing')}</span><button class="mini-button remove-root" data-root="${escapeHtml(id)}" type="button" title="Отключить"><svg><use href="#i-x"/></svg></button></header>${nested ? `<details><summary>${descendants.length} вложенных скиллов</summary><ul class="nested-skill-tree">${nested}</ul></details>` : '<div class="root-no-deps">Нет вложенных скиллов</div>'}</article>`;
  }).join('');
  const chainRows = resolved.order.map((skill, index) => `<li class="${project.roots.includes(skill.id) ? 'current' : ''}"><span>${index + 1}</span><div><strong>${escapeHtml(skill.id)}</strong><small>${project.roots.includes(skill.id) ? 'root' : 'dependency'} · ${escapeHtml(skill.version)}</small></div></li>`).join('');
  $('#projectContent').innerHTML = `<div class="project-summary"><div><span>Главные скиллы</span><strong>${project.roots.length}</strong></div><div><span>В цепочке</span><strong>${resolved.order.length}</strong></div><div><span>Проблемы</span><strong class="${resolved.conflicts.length ? 'danger-text' : 'success'}">${resolved.conflicts.length}</strong></div><div><span>Версии</span><strong class="summary-text">синхронизированы</strong></div></div><section class="content-section reference-mode-card"><div><strong>Ссылочное подключение</strong><span>Проект хранит только ID скиллов. Имя, содержимое, связи и версия всегда берутся из общего реестра и обновляются автоматически.</span></div><span class="connector-status write-enabled">единый источник</span></section><section class="content-section ai-connector-card"><div class="ai-connector-icon"><svg><use href="#i-link"/></svg></div><div><strong>AI-доступ через MCP</strong><span>Codex может читать граф, маршрутизировать задачи между агентами, передавать контекст и фиксировать результат. Для других AI-клиентов используется тот же MCP-контракт.</span><code>resolve_agent_context · route_agent_task · create_agent_handoff · record_agent_outcome</code></div><span class="connector-status write-enabled">read/write</span></section><section class="content-section"><div class="section-heading"><div><strong>Главные скиллы</strong><span>Связанные скиллы находятся внутри главного как вложения</span></div><button class="secondary-button" id="addRootSkill" type="button" ${state.skills.length ? '' : 'disabled'}>+ Подключить</button></div>${rootRows || '<div class="section-empty">Главные скиллы не подключены.</div>'}</section><section class="content-section"><div class="section-heading"><div><strong>Разрешённая цепочка</strong><span>Сводка порядка с учётом зависимостей</span></div><span class="${resolved.conflicts.length ? 'invalid-label' : 'valid-label'}">${resolved.conflicts.length ? '⚠ Требуется внимание' : '✓ Граф валиден'}</span></div>${resolved.conflicts.length ? `<div class="conflict-list">${resolved.conflicts.map(item => `<p>${escapeHtml(item)}</p>`).join('')}</div>` : ''}${chainRows ? `<details class="chain-details"><summary>Показать порядок применения (${resolved.order.length})</summary><ol class="resolution-list" tabindex="0" aria-label="Порядок применения скиллов">${chainRows}</ol></details>` : '<div class="section-empty">Цепочка пуста.</div>'}</section>`;
  $('.project-summary', $('#projectContent')).insertAdjacentHTML('afterend', `<section class="content-section project-description"><div class="section-heading"><div><strong>Описание проекта</strong></div></div><p>${escapeHtml(project.description || 'Описание пока не добавлено.')}</p></section>`);
  const assignedAgents = (project.agentIds || []).map(id => state.agents.find(agent => agent.id === id)).filter(Boolean);
  $('.project-description', $('#projectContent')).insertAdjacentHTML('afterend', `<section class="content-section project-agents-section"><div class="section-heading"><div><strong>Агенты проекта</strong><span>Каждый агент получает собственную ссылочную цепочку скиллов</span></div><button class="secondary-button" id="assignProjectAgents" type="button">+ Назначить</button></div><div class="project-agent-list">${assignedAgents.map(agent => { const resolvedAgent = resolveAgent(agent); return `<article style="--agent-color:${escapeHtml(agent.color)}"><span class="agent-avatar"><svg><use href="#i-agent"/></svg></span><button data-agent="${escapeHtml(agent.id)}" type="button"><strong>${escapeHtml(agent.name)}</strong><small>${escapeHtml(agent.role)} · ${resolvedAgent.order.length} скиллов</small></button><span class="agent-status ${escapeHtml(agent.status)}">${escapeHtml(agentStatusLabels[agent.status] || agent.status)}</span><button class="mini-button remove-project-agent" data-agent="${escapeHtml(agent.id)}" type="button" title="Отключить агента"><svg><use href="#i-x"/></svg></button></article>`; }).join('') || '<div class="section-empty">Агенты не назначены.</div>'}</div></section>`);
  $('#addRootSkill').addEventListener('click', openBindingDialog);
  $('#assignProjectAgents').addEventListener('click', () => openProjectAgentsDialog(project.id));
  $$('.remove-root').forEach(button => button.addEventListener('click', async () => { project.roots = project.roots.filter(id => id !== button.dataset.root); await persistRegistry(); renderAll(); }));
  $$('.project-agent-list [data-agent]:not(.remove-project-agent)').forEach(button => button.addEventListener('click', () => { activeAgentId = button.dataset.agent; agentViewMode = 'profiles'; renderAll(); switchView('agents'); }));
  $$('.remove-project-agent').forEach(button => button.addEventListener('click', async () => { project.agentIds = project.agentIds.filter(id => id !== button.dataset.agent); await persistRegistry('Агент отключён от проекта'); renderAll(); }));
  $$('.nested-skill-link').forEach(button => button.addEventListener('click', () => { if (openSkill(button.dataset.skill)) switchView('workspace'); }));
}

function renderHistory() {
  const skill = activeSkill();
  $('#historySkillName').textContent = skill?.id || 'Скилл не выбран';
  $('#compareVersions').disabled = !skill || skill.history.length < 1;
  if (!skill) { $('#timeline').innerHTML = '<div class="empty-state inline"><h2>История пуста</h2><p>Выберите скилл и сохраните изменения.</p></div>'; return; }
  const entries = [{ savedAt: skill.updatedAt, version: skill.version, content: skill.content, current: true }, ...skill.history];
  $('#timeline').innerHTML = entries.map((entry, index) => `<article class="release ${entry.current ? 'current' : ''}"><div class="release-dot"></div><div class="release-card"><div><strong>${escapeHtml(entry.version)}</strong><span class="status ${entry.current ? 'published' : 'deprecated'}">${entry.current ? 'current' : 'saved'}</span><time>${new Date(entry.savedAt).toLocaleString('ru-RU')}</time></div><p>${index === 0 ? 'Текущая сохранённая версия.' : 'Снимок перед следующим сохранением.'}</p><footer><span>${entry.content.split('\n').length} строк</span><code>${simpleHash(entry.content)}</code></footer></div></article>`).join('');
}

function simpleHash(text) { let hash = 0; for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0; return `rev:${Math.abs(hash).toString(16)}`; }

function buildLineDiff(previousContent, currentContent) {
  const left = String(previousContent).split('\n');
  const right = String(currentContent).split('\n');
  const rows = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      rows[i][j] = left[i - 1] === right[j - 1] ? rows[i - 1][j - 1] + 1 : Math.max(rows[i - 1][j], rows[i][j - 1]);
    }
  }
  const diff = [];
  let i = left.length; let j = right.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && left[i - 1] === right[j - 1]) {
      diff.push({ type: 'context', left: i, right: j, text: left[i - 1] }); i -= 1; j -= 1;
    } else if (j > 0 && (i === 0 || rows[i][j - 1] >= rows[i - 1][j])) {
      diff.push({ type: 'added', left: null, right: j, text: right[j - 1] }); j -= 1;
    } else {
      diff.push({ type: 'removed', left: i, right: null, text: left[i - 1] }); i -= 1;
    }
  }
  return diff.reverse();
}

function openLatestDiff() {
  const skill = activeSkill();
  const previous = skill?.history?.[0];
  if (!skill || !previous) return showToast('Для сравнения нужно хотя бы одно предыдущее сохранение');
  const diff = buildLineDiff(previous.content, skill.content);
  const added = diff.filter(row => row.type === 'added').length;
  const removed = diff.filter(row => row.type === 'removed').length;
  $('#diffSubtitle').textContent = `${previous.version} → ${skill.version} · ${skillName(skill)}`;
  $('#diffSummary').innerHTML = `<span class="diff-stat added">+${added} строк</span><span class="diff-stat removed">−${removed} строк</span><span class="diff-stat">${diff.filter(row => row.type === 'context').length} без изменений</span>`;
  $('#diffTable').innerHTML = diff.map(row => `<div class="diff-row ${row.type}" role="row"><span class="diff-line-number" role="cell">${row.left ?? ''}</span><span class="diff-line-number" role="cell">${row.right ?? ''}</span><span class="diff-marker" role="cell">${row.type === 'added' ? '+' : row.type === 'removed' ? '−' : ''}</span><span class="diff-code" role="cell">${escapeHtml(row.text) || ' '}</span></div>`).join('');
  $('#diffDialog').showModal();
}

function updateLinkModeUi() {
  const button = $('#startLinkButton');
  button.classList.toggle('active-link-mode', linkMode.active);
  button.innerHTML = linkMode.active
    ? '<svg><use href="#i-x"/></svg> Отменить связь'
    : '<svg><use href="#i-link"/></svg> Создать связь';
  button.disabled = visibleSkills().length < 2;
  if (!visibleSkills().length) return;
  $('#graphHint').textContent = linkMode.active
    ? (linkMode.source ? `Источник: ${linkMode.source}. Выберите целевой скилл.` : 'Выберите исходный скилл для новой связи.')
    : 'Узлы можно уносить далеко за экран · тяните фон для перемещения · нажмите процент, чтобы показать всё';
}

function cancelLinkMode() {
  linkMode = { active: false, source: null };
  updateLinkModeUi();
  renderGraph();
}

function startLinkMode(source = null) {
  if (dirty) return showToast('Сначала сохраните изменения текущего скилла');
  if (visibleSkills().length < 2) return showToast('Для связи нужны минимум два скилла в текущем реестре');
  linkMode = { active: true, source };
  $('#graphContextMenu').hidden = true;
  renderGraph();
}

function openRelationDialog(sourceId, targetId) {
  const source = state.skills.find(skill => skill.id === sourceId);
  const target = state.skills.find(skill => skill.id === targetId);
  if (!source || !target || source === target) return;
  const form = $('#relationForm');
  form.elements.source.value = source.id;
  form.elements.target.value = target.id;
  form.elements.type.value = 'requires';
  form.elements.range.value = '*';
  $('#relationSummary').textContent = `${source.id} → ${target.id}`;
  $('#relationDialog').showModal();
}

function handleGraphNodeSelection(id) {
  if (!linkMode.active) {
    openSkill(id);
    return;
  }
  if (!linkMode.source) {
    linkMode.source = id;
    renderGraph();
    showToast(`Источник связи: ${id}`);
    return;
  }
  if (linkMode.source === id) return showToast('Выберите другой скилл как цель');
  openRelationDialog(linkMode.source, id);
}

function openGraphContextMenu(event, id) {
  event.preventDefault();
  event.stopPropagation();
  if (!openSkill(id)) return;
  graphContextSkillId = id;
  const menu = $('#graphContextMenu');
  const canvasRect = $('#graphCanvas').getBoundingClientRect();
  $('#graphContextTitle').textContent = activeSkill() ? skillName(activeSkill()) : id;
  $('#graphContextId').textContent = id;
  menu.style.left = `${Math.min(event.clientX - canvasRect.left, canvasRect.width - 210)}px`;
  menu.style.top = `${Math.min(event.clientY - canvasRect.top, canvasRect.height - 145)}px`;
  menu.hidden = false;
}

function ensureGraphPositions(nodes) {
  state.settings.graphPositions ||= {};
  const center = { x: 600, y: 400 };
  nodes.forEach((node, index) => {
    if (state.settings.graphPositions[node.id]) return;
    if (node.kind === 'image' && state.settings.graphPositions[node.ownerId]) {
      const owner = state.settings.graphPositions[node.ownerId];
      const siblingIndex = nodes.filter(item => item.kind === 'image' && item.ownerId === node.ownerId).findIndex(item => item.id === node.id);
      const angle = Math.PI / 5 + siblingIndex * .75;
      state.settings.graphPositions[node.id] = { x: owner.x + Math.cos(angle) * 180, y: owner.y + Math.sin(angle) * 180 };
      return;
    }
    const angle = nodes.length === 1 ? 0 : (Math.PI * 2 * index / nodes.length) - Math.PI / 2;
    const ring = nodes.length === 1 ? 0 : (nodes.length > 12 ? 260 + (index % 2) * 95 : 300);
    state.settings.graphPositions[node.id] = {
      x: center.x + Math.cos(angle) * ring,
      y: center.y + Math.sin(angle) * ring * .72
    };
  });
  const validIds = new Set([...state.skills.map(skill => skill.id), ...allImages().map(image => `asset:${image.id}`)]);
  Object.keys(state.settings.graphPositions).forEach(id => {
    if (!validIds.has(id)) delete state.settings.graphPositions[id];
  });
  return state.settings.graphPositions;
}

function updateGraphGeometry() {
  const positions = state.settings.graphPositions || {};
  $$('.graph-node').forEach(node => {
    const point = positions[node.dataset.nodeId];
    if (point) node.setAttribute('transform', `translate(${point.x} ${point.y})`);
  });
  $$('#graphLinks .link').forEach(path => {
    const from = positions[path.dataset.source];
    const to = positions[path.dataset.target];
    if (from && to) path.setAttribute('d', `M${from.x} ${from.y} L${to.x} ${to.y}`);
  });
}

function renderGraph() {
  const skills = visibleSkills();
  const skillNodes = skills.map(skill => ({ id: skill.id, kind: 'skill', skill }));
  const imageNodes = skills.flatMap(skill => (skill.images || []).map(image => ({ id: `asset:${image.id}`, kind: 'image', image, ownerId: skill.id, skill })));
  const nodes = [...skillNodes, ...imageNodes];
  const dependencyLinks = skills.flatMap(skill => skill.deps.map(dep => ({ source: skill.id, target: dep.id, type: dep.type })).filter(link => skills.some(item => item.id === link.target)));
  const assetLinks = imageNodes.map(node => ({ source: node.ownerId, target: node.id, type: 'extends', asset: true }));
  const links = [...dependencyLinks, ...assetLinks];
  $('#graphStatsPrimary').textContent = `${skills.length} скиллов · ${imageNodes.length} изображений`;
  $('#graphStatsSecondary').textContent = `${links.length} связей · ${registryScope === 'project' ? 'проект' : 'общий'}`;
  $('#graphEmpty').hidden = nodes.length > 0;
  $('#graphHint').hidden = nodes.length === 0;
  updateLinkModeUi();
  const positions = ensureGraphPositions(nodes);
  const neighbors = new Map(nodes.map(node => [node.id, new Set()]));
  links.forEach(link => { neighbors.get(link.source)?.add(link.target); neighbors.get(link.target)?.add(link.source); });
  $('#graphLinks').innerHTML = links.map(link => {
    const from = positions[link.source]; const to = positions[link.target];
    return `<path class="link ${escapeHtml(link.type)} ${link.asset ? 'asset-link' : ''}" data-source="${escapeHtml(link.source)}" data-target="${escapeHtml(link.target)}" d="M${from.x} ${from.y} L${to.x} ${to.y}"/>`;
  }).join('');
  $('#graphNodes').innerHTML = nodes.map(node => {
    const point = positions[node.id];
    const connected = [...(neighbors.get(node.id) || [])];
    if (node.kind === 'image') {
      const label = node.image.caption || node.image.name;
      return `<g class="graph-node graph-image-node" data-node-id="${escapeHtml(node.id)}" data-image-id="${escapeHtml(node.image.id)}" transform="translate(${point.x} ${point.y})" role="button" tabindex="0" aria-label="Изображение ${escapeHtml(label)}. Расширяет ${escapeHtml(skillName(node.skill))}" data-connections="${escapeHtml(connected.join(','))}"><circle r="53"/><image href="${escapeHtml(imageAssetUrl(node.image))}" x="-35" y="-39" width="70" height="70" preserveAspectRatio="xMidYMid slice"/><text class="node-sub" y="43">${escapeHtml(label.length > 17 ? `${label.slice(0, 15)}…` : label)}</text><text class="node-connections" y="56">расширяет</text><title>${escapeHtml(label)} → ${escapeHtml(skillName(node.skill))}</title></g>`;
    }
    const skill = node.skill;
    const selected = skill.id === activeSkillId ? 'selected' : '';
    const source = linkMode.active && linkMode.source === skill.id ? 'link-source' : '';
    const connectedNames = connected.map(id => id.startsWith('asset:') ? (findImage(id.slice(6))?.caption || 'изображение') : skillName(skills.find(item => item.id === id) || { id })).join(', ');
    const compactConnections = connectedNames.length > 19 ? `${connectedNames.slice(0, 17)}…` : (connectedNames || 'нет связей');
    const hub = connected.length > 3 ? 'graph-hub' : '';
    return `<g class="graph-node ${selected} ${source} ${hub}" data-node-id="${escapeHtml(skill.id)}" data-skill-id="${escapeHtml(skill.id)}" transform="translate(${point.x} ${point.y})" role="button" tabindex="0" aria-label="${escapeHtml(skillName(skill))}. Связано: ${escapeHtml(connectedNames || 'нет')}" data-connections="${escapeHtml(connected.join(','))}"><circle r="53"/><text class="node-icon" y="-17">${escapeHtml(skillIcon(skill))}</text><text class="node-sub" y="3">${escapeHtml(skillName(skill).length > 17 ? `${skillName(skill).slice(0, 15)}…` : skillName(skill))}</text><text class="node-connections" y="21">${escapeHtml(compactConnections)}</text><text class="node-degree" y="37">${escapeHtml(connectionCountLabel(connected.length))}</text><title>${escapeHtml(skillName(skill))}: ${escapeHtml(connectedNames || 'нет подключённых узлов')}</title></g>`;
  }).join('');
  $$('.graph-node').forEach(node => {
    const nodeId = node.dataset.nodeId;
    const openNode = () => node.dataset.imageId ? openImagePreview(node.dataset.imageId) : (openSkill(node.dataset.skillId) && switchView('workspace'));
    node.addEventListener('pointerdown', event => {
      event.stopPropagation();
      if (linkMode.active || event.button !== 0) return;
      const now = performance.now();
      if (lastGraphPointer.id === nodeId && now - lastGraphPointer.at < 500) {
        clearTimeout(graphClickTimer);
        graphClickTimer = null;
        lastGraphPointer = { id: null, at: 0 };
        event.preventDefault();
        openNode();
        return;
      }
      lastGraphPointer = { id: nodeId, at: now };
      const related = new Set((node.dataset.connections || '').split(',').filter(Boolean));
      nodeDragging = {
        id: nodeId,
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        moved: false,
        related,
        initial: Object.fromEntries(Object.entries(positions).map(([id, point]) => [id, { ...point }]))
      };
      node.setPointerCapture(event.pointerId);
    });
    node.addEventListener('pointermove', event => {
      if (!nodeDragging || nodeDragging.pointerId !== event.pointerId) return;
      const svg = $('#graphSvg').getBoundingClientRect();
      const dx = (event.clientX - nodeDragging.clientX) * (GRAPH_VIEW_WIDTH / Math.max(1, svg.width)) / graphTransform.scale;
      const dy = (event.clientY - nodeDragging.clientY) * (GRAPH_VIEW_HEIGHT / Math.max(1, svg.height)) / graphTransform.scale;
      nodeDragging.moved ||= Math.abs(dx) + Math.abs(dy) > 4;
      const origin = nodeDragging.initial[nodeDragging.id];
      positions[nodeDragging.id] = {
        x: Math.max(-GRAPH_WORKSPACE_MARGIN, Math.min(GRAPH_VIEW_WIDTH + GRAPH_WORKSPACE_MARGIN, origin.x + dx)),
        y: Math.max(-GRAPH_WORKSPACE_MARGIN, Math.min(GRAPH_VIEW_HEIGHT + GRAPH_WORKSPACE_MARGIN, origin.y + dy))
      };
      nodeDragging.related.forEach(id => {
        const relatedOrigin = nodeDragging.initial[id];
        if (relatedOrigin) positions[id] = {
          x: Math.max(-GRAPH_WORKSPACE_MARGIN, Math.min(GRAPH_VIEW_WIDTH + GRAPH_WORKSPACE_MARGIN, relatedOrigin.x + dx * .16)),
          y: Math.max(-GRAPH_WORKSPACE_MARGIN, Math.min(GRAPH_VIEW_HEIGHT + GRAPH_WORKSPACE_MARGIN, relatedOrigin.y + dy * .16))
        };
      });
      updateGraphGeometry();
    });
    node.addEventListener('pointerup', event => {
      if (!nodeDragging || nodeDragging.pointerId !== event.pointerId) return;
      if (nodeDragging.moved) {
        graphNodeMovedUntil = performance.now() + 250;
        persistRegistry('Положение графа сохранено');
      }
      nodeDragging = null;
    });
    node.addEventListener('pointercancel', () => { nodeDragging = null; });
    node.addEventListener('click', event => {
      if (graphDragging?.moved || performance.now() < graphNodeMovedUntil) return;
      event.stopPropagation();
      if (linkMode.active) return node.dataset.skillId ? handleGraphNodeSelection(node.dataset.skillId) : showToast('Связи между скиллсами создаются через узлы скиллов');
      clearTimeout(graphClickTimer);
      if (event.detail >= 2) {
        graphClickTimer = null;
        openNode();
        return;
      }
      graphClickTimer = setTimeout(() => node.dataset.imageId ? openImagePreview(node.dataset.imageId) : handleGraphNodeSelection(node.dataset.skillId), 230);
    });
    node.addEventListener('dblclick', event => {
      clearTimeout(graphClickTimer);
      graphClickTimer = null;
      openNode();
      event.preventDefault();
      event.stopPropagation();
    });
    node.addEventListener('contextmenu', event => node.dataset.skillId ? openGraphContextMenu(event, node.dataset.skillId) : (event.preventDefault(), openImagePreview(node.dataset.imageId)));
    node.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (node.dataset.imageId) openImagePreview(node.dataset.imageId); else handleGraphNodeSelection(node.dataset.skillId);
    });
  });
  updateGraphGeometry();
  applyGraphTransform();
}

function applyGraphTransform() {
  $('#graphViewport').setAttribute('transform', `translate(${graphTransform.x} ${graphTransform.y}) scale(${graphTransform.scale})`);
  $('#zoomLabel').textContent = `${Math.round(graphTransform.scale * 100)}%`;
}
function setZoom(next) { graphTransform.scale = Math.max(.12, Math.min(2.8, next)); applyGraphTransform(); }
function fitGraph() {
  const points = Object.values(state.settings.graphPositions || {});
  if (!points.length) {
    graphTransform = { scale: 1, x: 0, y: 0 };
    applyGraphTransform();
    return;
  }
  const minX = Math.min(...points.map(point => point.x)) - 85;
  const maxX = Math.max(...points.map(point => point.x)) + 85;
  const minY = Math.min(...points.map(point => point.y)) - 85;
  const maxY = Math.max(...points.map(point => point.y)) + 85;
  const width = Math.max(260, maxX - minX);
  const height = Math.max(200, maxY - minY);
  const scale = Math.max(.12, Math.min(1.65, (GRAPH_VIEW_WIDTH / width) * .92, (GRAPH_VIEW_HEIGHT / height) * .92));
  graphTransform = {
    scale,
    x: GRAPH_VIEW_WIDTH / 2 - ((minX + maxX) / 2) * scale,
    y: GRAPH_VIEW_HEIGHT / 2 - ((minY + maxY) / 2) * scale
  };
  applyGraphTransform();
}

function renderAll() {
  renderSkillTabs(); renderSkillLists(); renderProjectsList(); renderLibrary(); renderInspector(); renderProjectView(); renderHistory(); renderGraph(); renderAgents();
}

function switchView(name) {
  currentView = name;
  $$('.view').forEach(view => view.classList.toggle('active', view.id === `view-${name}`));
  renderSkillTabs();
  $$('.ribbon-button[data-nav]').forEach(button => button.classList.toggle('active', button.dataset.nav === name));
  if (name === 'graph') renderGraph();
  if (name === 'agents') renderAgents();
  if (window.innerWidth <= 760) setMobileExplorerOpen(false);
}

function setMobileExplorerOpen(open) {
  const enabled = window.innerWidth <= 760 && Boolean(open);
  shell.classList.toggle('mobile-explorer', enabled);
  const toggle = $('#explorerToggle');
  if (!toggle) return;
  toggle.setAttribute('aria-expanded', String(enabled));
  toggle.title = enabled ? 'Скрыть навигатор' : 'Показать навигатор';
  toggle.setAttribute('aria-label', toggle.title);
}

function showToast(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600); }
function bindOpenButtons() { $$('.open-add').forEach(button => button.onclick = () => $('#addDialog').showModal()); $$('.open-import').forEach(button => button.onclick = () => $('#importInput').click()); }
function normalizeProjectColor(value, fallback = '') {
  const color = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : fallback;
}

function setProjectColorControl(form, value) {
  const picker = form.elements.color;
  const text = form.querySelector('[data-color-value]');
  const color = normalizeProjectColor(value, '#8B6DDE');
  picker.value = color.toLowerCase();
  text.value = color;
}

async function copyProjectColor(value) {
  const color = normalizeProjectColor(value);
  if (!color) return showToast('Введите цвет в формате #RRGGBB');
  try {
    if (window.skillGraphDesktop?.copyText) await window.skillGraphDesktop.copyText(color);
    else await navigator.clipboard.writeText(color);
  } catch {
    const temporary = document.createElement('textarea');
    temporary.value = color;
    temporary.style.position = 'fixed';
    temporary.style.opacity = '0';
    document.body.append(temporary);
    temporary.select();
    document.execCommand('copy');
    temporary.remove();
  }
  showToast(`Цвет ${color} скопирован`);
}

function bindProjectColorControls() {
  $$('.project-color-control').forEach(control => {
    const picker = control.querySelector('input[type="color"]');
    const text = control.querySelector('[data-color-value]');
    const copy = control.querySelector('[data-copy-color]');
    picker.addEventListener('input', () => { text.value = picker.value.toUpperCase(); });
    text.addEventListener('input', () => {
      const color = normalizeProjectColor(text.value);
      if (color) picker.value = color.toLowerCase();
    });
    text.addEventListener('blur', () => { text.value = normalizeProjectColor(text.value, picker.value.toUpperCase()); });
    copy.addEventListener('click', () => copyProjectColor(text.value));
  });
}

function openProjectDialog() {
  const form = $('#projectForm');
  form.reset();
  $('#projectLocation').value = '';
  setProjectColorControl(form, '#8B6DDE');
  $('#projectDialog').showModal();
}

function openProjectEditDialog() {
  const project = activeProject();
  if (!project) return;
  const form = $('#projectEditForm');
  form.elements.name.value = project.name;
  form.elements.location.value = project.location;
  form.elements.description.value = project.description || '';
  setProjectColorControl(form, project.color || '#8B6DDE');
  $('#projectEditDialog').showModal();
}

function openSkillGroupDialog(groupId = null) {
  const group = state.groups.find(item => item.id === groupId) || null;
  editingSkillGroupId = group?.id || null;
  const form = $('#skillGroupForm');
  form.reset();
  form.elements.id.value = group?.id || '';
  form.elements.name.value = group?.name || '';
  $('#skillGroupDialogTitle').textContent = group ? 'Редактировать группу' : 'Новая группа';
  $('#deleteSkillGroup').hidden = !group;
  $('#skillGroupDialog').showModal();
  setTimeout(() => form.elements.name.focus(), 20);
}

async function deleteCurrentSkillGroup() {
  const group = state.groups.find(item => item.id === editingSkillGroupId);
  if (!group || !confirm(`Удалить группу «${group.name}»? Скиллы вернутся в раздел «Все скиллы».`)) return;
  state.skills.forEach(skill => { if (skill.groupId === group.id) skill.groupId = ''; });
  state.groups = state.groups.filter(item => item.id !== group.id);
  editingSkillGroupId = null;
  $('#skillGroupDialog').close();
  await persistRegistry('Группа удалена');
  renderAll();
}

async function chooseProjectFolder() {
  if (window.skillGraphDesktop?.pickProjectFolder) {
    const selected = await window.skillGraphDesktop.pickProjectFolder();
    if (!selected) return;
    $('#projectLocation').value = selected;
    const nameField = $('#projectForm').elements.name;
    if (!nameField.value) nameField.value = selected.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1);
    return;
  }
  $('#projectDirectoryInput').click();
}

function openBindingDialog() {
  const project = activeProject(); if (!project) return;
  bindingCandidates = state.skills.filter(skill => !project.roots.includes(skill.id));
  if (!bindingCandidates.length) return showToast('Все скиллы уже подключены');
  $('#bindingSkillSearch').value = '';
  renderBindingCandidates();
  $('#bindingDialog').showModal();
  $('#bindingSkill').scrollTop = 0;
  setTimeout(() => $('#bindingSkillSearch').focus(), 20);
}

function renderBindingCandidates(query = '') {
  const terms = String(query).toLowerCase().trim().split(/\s+/).filter(Boolean);
  const available = bindingCandidates.filter(skill => {
    const haystack = `${skillName(skill)} ${skill.title || ''} ${skill.id} ${skill.description || ''} ${(skill.tags || []).join(' ')}`.toLowerCase();
    return terms.every(term => haystack.includes(term));
  });
  const previousSelection = $('#bindingSkillValue').value;
  $('#bindingSkill').innerHTML = available.map(skill => `<button class="binding-skill-option" data-binding-skill="${escapeHtml(skill.id)}" role="option" aria-selected="false" type="button"><span>${escapeHtml(skillName(skill))}</span><code>${escapeHtml(skill.id)}</code></button>`).join('') || '<div class="tree-empty">Скиллы по запросу не найдены</div>';
  $$('[data-binding-skill]', $('#bindingSkill')).forEach(button => button.addEventListener('click', () => {
    $$('[data-binding-skill]', $('#bindingSkill')).forEach(item => item.setAttribute('aria-selected', String(item === button)));
    $('#bindingSkillValue').value = button.dataset.bindingSkill;
  }));
  const selectedOption = available.some(skill => skill.id === previousSelection) ? $(`[data-binding-skill="${CSS.escape(previousSelection)}"]`, $('#bindingSkill')) : null;
  const firstOption = selectedOption || $('[data-binding-skill]', $('#bindingSkill'));
  $('#bindingSkillValue').value = '';
  if (firstOption) { firstOption.setAttribute('aria-selected', 'true'); $('#bindingSkillValue').value = firstOption.dataset.bindingSkill; }
  $('#bindingSkill').scrollTop = 0;
}

function renderRemoteSources() {
  const container = $('#remoteSourceList');
  if (!container) return;
  container.innerHTML = state.sources.map(source => {
    const details = [source.provider?.toUpperCase(), source.branch, source.path, `${source.skillIds?.length || 0} скиллов`].filter(Boolean).join(' · ');
    const status = source.lastError ? `Ошибка: ${source.lastError}` : (source.lastSyncAt ? `Обновлён ${new Date(source.lastSyncAt).toLocaleString('ru-RU')}` : 'Готов к чтению');
    return `<div class="remote-source-row" data-source-id="${escapeHtml(source.id)}"><div><strong>${escapeHtml(source.name)}</strong><span title="${escapeHtml(source.endpoint)}">${escapeHtml(details || source.endpoint)}</span><span class="source-status">${escapeHtml(status)}</span></div><button class="secondary-button" data-source-sync type="button">Обновить</button><button class="secondary-button danger-action" data-source-delete type="button" aria-label="Удалить источник">Удалить</button></div>`;
  }).join('');
  $$('[data-source-sync]', container).forEach(button => button.addEventListener('click', async () => {
    const source = state.sources.find(item => item.id === button.closest('[data-source-id]')?.dataset.sourceId);
    if (!source || remoteSourceSyncing) return;
    const token = prompt('Access token для приватного репозитория (для публичного оставьте пустым):', '') ?? '';
    await syncRemoteSource(source, token);
  }));
  $$('[data-source-delete]', container).forEach(button => button.addEventListener('click', async () => {
    const id = button.closest('[data-source-id]')?.dataset.sourceId;
    const source = state.sources.find(item => item.id === id);
    if (!source || !confirm(`Удалить подключение «${source.name}»? Уже прочитанные скиллы останутся в общем реестре.`)) return;
    state.sources = state.sources.filter(item => item.id !== id);
    await persistRegistry('Удалённый источник отключён');
    renderRemoteSources(); renderAll();
  }));
}

function skillsFromRemoteItems(items, source) {
  const skills = [];
  for (const file of items || []) {
    const text = String(file.content ?? '');
    try {
      if (String(file.name).toLowerCase().endsWith('.json')) {
        const data = JSON.parse(text);
        const candidates = Array.isArray(data) ? data : (Array.isArray(data?.skills) ? data.skills : [data]);
        candidates.forEach(candidate => {
          if (!candidate || typeof candidate !== 'object') return;
          const skill = normalizeSkill(candidate, slugify(file.name));
          skill.origin = { sourceId: source.id, provider: source.provider, repository: source.endpoint, path: file.source || file.name, remote: true };
          skills.push(skill);
        });
      } else {
        const parsed = parseFrontmatter(text);
        const fallback = slugify(String(file.name).replace(/\.(md|markdown)$/i, ''));
        const skill = normalizeSkill({ ...parsed, id: parsed.id || fallback, content: text }, fallback);
        skill.origin = { sourceId: source.id, provider: source.provider, repository: source.endpoint, path: file.source || file.name, remote: true };
        skills.push(skill);
      }
    } catch (error) {
      console.warn(`Remote skill skipped: ${file.source || file.name}`, error);
    }
  }
  return skills;
}

async function syncRemoteSource(source, token = '') {
  if (!window.skillGraphDesktop?.readRemoteSkills) return showToast('Удалённые реестры доступны только в настольной версии');
  remoteSourceSyncing = true;
  source.lastError = '';
  renderRemoteSources();
  try {
    const result = await window.skillGraphDesktop.readRemoteSkills({ type: source.type, endpoint: source.endpoint, branch: source.branch, path: source.path, token });
    source.provider = result.provider;
    source.branch = result.branch;
    const remoteSkills = skillsFromRemoteItems(result.items, source);
    if (!remoteSkills.length) throw new Error('В репозитории не найдены SKILL.md или реестр SkillGraph');
    remoteSkills.forEach(skill => {
      const index = state.skills.findIndex(item => item.id === skill.id);
      if (index < 0) state.skills.push(skill);
      else {
        const previous = state.skills[index];
        state.skills[index] = { ...previous, ...skill, favorite: previous.favorite, history: previous.history || [], images: skill.images?.length ? skill.images : (previous.images || []) };
      }
    });
    source.skillIds = [...new Set(remoteSkills.map(skill => skill.id))];
    source.status = 'connected';
    source.lastSyncAt = new Date().toISOString();
    source.lastError = '';
    activeSkillId ||= remoteSkills[0].id;
    await persistRegistry(`Удалённый реестр прочитан: ${remoteSkills.length} скиллов`);
    renderAll(); renderRemoteSources();
    showToast(`${source.provider}: прочитано скиллов — ${remoteSkills.length}`);
    return true;
  } catch (error) {
    source.status = 'error';
    source.lastError = error.message || 'Не удалось прочитать репозиторий';
    await persistRegistry('Ошибка чтения удалённого источника');
    renderRemoteSources();
    showToast(source.lastError);
    console.error(error);
    return false;
  } finally {
    remoteSourceSyncing = false;
  }
}

async function importFiles(files) {
  let imported = 0;
  for (const file of files) {
    try {
      const text = typeof file.text === 'function' ? await file.text() : String(file.content ?? '');
      let candidates = [];
      if (file.name.toLowerCase().endsWith('.json')) {
        const data = JSON.parse(text);
        if (data?.schema === 'skillgraph/registry-v1' || data?.schema === 'skillgraph/registry-v2') {
          await prepareRegistryImport(file, data);
          continue;
        }
        candidates = Array.isArray(data) ? data : (Array.isArray(data.skills) ? data.skills : [data]);
      } else {
        const parsed = parseFrontmatter(text);
        candidates = [{ ...parsed, id: parsed.id || slugify(file.name.replace(/\.(md|markdown)$/i, '')), content: text }];
      }
      for (const candidate of candidates) {
        const skill = normalizeSkill(candidate, slugify(file.name));
        const conflictIndex = state.skills.findIndex(item => item.id === skill.id);
        if (conflictIndex >= 0) {
          state.skills.splice(conflictIndex, 1, skill);
          showToast(`Скилл ${skill.id} заменён импортированным файлом`);
        } else state.skills.push(skill);
        imported += 1; activeSkillId = skill.id;
      }
    } catch (error) { showToast(`Не удалось импортировать ${file.name}`); console.error(error); }
  }
  if (imported) { await persistRegistry(`Импортировано: ${imported}`); openSkill(activeSkillId, true); renderAll(); showToast(`Импортировано скиллов: ${imported}`); }
  $('#importInput').value = '';
  $('#skillFolderInput').value = '';
}

async function importSkillFolder() {
  if (window.skillGraphDesktop?.pickSkillFolder) {
    const items = await window.skillGraphDesktop.pickSkillFolder();
    if (items?.length) await importFiles(items);
    return;
  }
  $('#skillFolderInput').click();
}

async function importSkillArchive() {
  if (!window.skillGraphDesktop?.pickSkillArchives) return showToast('Импорт ZIP доступен в настольной версии');
  const items = await window.skillGraphDesktop.pickSkillArchives();
  if (items?.length) await importFiles(items);
}

function exportRegistry() {
  const blob = new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `skillgraph-registry-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url);
  showToast('Экспорт реестра подготовлен');
}

async function prepareRegistryImport(file, parsed = null) {
  try {
    const raw = parsed || JSON.parse(await file.text());
    if (!raw || !['skillgraph/registry-v1', 'skillgraph/registry-v2'].includes(raw.schema)) throw new Error('Файл не является реестром SkillGraph');
    const registry = normalizeRegistry(raw);
    pendingRegistryImport = { fileName: file.name, registry };
    $('#registryImportSummary').innerHTML = `<strong>${escapeHtml(file.name)}</strong><br>${registry.skills.length} скиллов · ${registry.projects.length} проектов · ${registry.agents.length} агентов · ${registry.handoffs.length} handoff · ${registry.evaluations.length} оценок · ${registry.sources.length} источников`;
    $('#registryImportForm').elements.mode.value = 'merge';
    if (!$('#registryImportDialog').open) $('#registryImportDialog').showModal();
  } catch (error) {
    pendingRegistryImport = null;
    showToast(`Не удалось прочитать реестр ${file.name}`);
    console.error(error);
  } finally {
    $('#registryImportInput').value = '';
  }
}

function mergeRegistryRecords(current, incoming) {
  const merged = new Map(current.map(item => [item.id, item]));
  incoming.forEach(item => merged.set(item.id, item));
  return [...merged.values()];
}

async function applyPendingRegistryImport(mode) {
  if (!pendingRegistryImport) return;
  const incoming = pendingRegistryImport.registry;
  const previousSkill = activeSkillId;
  const previousProject = activeProjectId;
  const previousAgent = activeAgentId;
  if (mode === 'replace') {
    state = normalizeRegistry(cloneRegistry(incoming));
  } else {
    state = normalizeRegistry({
      ...state,
      skills: mergeRegistryRecords(state.skills, incoming.skills),
      projects: mergeRegistryRecords(state.projects, incoming.projects),
      agents: mergeRegistryRecords(state.agents, incoming.agents),
      handoffs: mergeRegistryRecords(state.handoffs || [], incoming.handoffs || []),
      agentRuns: mergeRegistryRecords(state.agentRuns || [], incoming.agentRuns || []),
      runTasks: mergeRegistryRecords(state.runTasks || [], incoming.runTasks || []),
      runArtifacts: mergeRegistryRecords(state.runArtifacts || [], incoming.runArtifacts || []),
      auditLog: mergeRegistryRecords(state.auditLog || [], incoming.auditLog || []),
      evaluations: mergeRegistryRecords(state.evaluations || [], incoming.evaluations || []),
      sources: mergeRegistryRecords(state.sources, incoming.sources),
      settings: {
        ...(incoming.settings || {}),
        ...(state.settings || {}),
        graphPositions: { ...(state.settings?.graphPositions || {}), ...(incoming.settings?.graphPositions || {}) }
      }
    });
  }
  registryScope = 'global';
  activeSkillId = state.skills.some(skill => skill.id === previousSkill) ? previousSkill : (state.skills[0]?.id ?? null);
  activeProjectId = state.projects.some(project => project.id === previousProject) ? previousProject : (state.projects[0]?.id ?? null);
  activeAgentId = state.agents.some(agent => agent.id === previousAgent) ? previousAgent : (state.agents[0]?.id ?? null);
  openSkillTabs = openSkillTabs.filter(id => state.skills.some(skill => skill.id === id));
  if (activeSkillId) openSkill(activeSkillId, true); else clearEditor();
  const fileName = pendingRegistryImport.fileName;
  pendingRegistryImport = null;
  $('#registryImportDialog').close();
  await persistRegistry(mode === 'replace' ? 'Общий реестр восстановлен из JSON' : 'Данные реестра объединены');
  renderAll();
  showToast(`${mode === 'replace' ? 'Реестр заменён' : 'Реестры объединены'}: ${fileName}`);
}

function renderCommands(query = '') {
  const commands = [
    { id: 'add', title: 'Создать новый скилл', detail: 'Ctrl+N', icon: 'i-plus' },
    { id: 'import', title: 'Импортировать скилл', detail: 'Ctrl+O · Markdown или JSON', icon: 'i-import' },
    { id: 'registry-import', title: 'Импортировать реестр', detail: 'JSON · объединить или заменить', icon: 'i-library' },
    { id: 'project-add', title: 'Добавить проект', detail: 'Создать внешнюю связь', icon: 'i-project' },
    { id: 'agent-add', title: 'Добавить агента', detail: 'Создать роль и назначить скиллы', icon: 'i-agent' },
    { id: 'agents', title: 'Открыть агентов', detail: 'Профили и маршрут проекта', icon: 'i-agent' },
    { id: 'graph', title: 'Открыть граф', detail: 'Ctrl+G · Просмотреть зависимости', icon: 'i-graph' },
    { id: 'library', title: 'Открыть общий реестр', detail: 'Ctrl+L', icon: 'i-library' },
    { id: 'undo', title: 'Отменить действие', detail: 'Ctrl+Z', icon: 'i-history' },
    { id: 'redo', title: 'Повторить действие', detail: 'Ctrl+Y / Ctrl+Shift+Z', icon: 'i-history' },
    ...state.skills.map(skill => ({ id: `skill:${skill.id}`, title: skillName(skill), detail: skill.id, icon: 'i-file' }))
  ].filter(item => `${item.title} ${item.detail}`.toLowerCase().includes(query.toLowerCase()));
  $('#commandResults').innerHTML = commands.map(item => `<button data-command="${escapeHtml(item.id)}" type="button"><svg><use href="#${item.icon}"/></svg><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}</small></span></button>`).join('') || '<div class="command-empty">Ничего не найдено</div>';
  $$('[data-command]').forEach(button => button.addEventListener('click', () => executeCommand(button.dataset.command)));
}

function executeCommand(command) {
  $('#commandDialog').close();
  if (command === 'add') $('#addDialog').showModal();
  else if (command === 'import') $('#importInput').click();
  else if (command === 'registry-import') $('#registryImportInput').click();
  else if (command === 'project-add') openProjectDialog();
  else if (command === 'agent-add') openAgentDialog();
  else if (command === 'agents') switchView('agents');
  else if (command === 'graph') switchView('graph');
  else if (command === 'library') { registryScope = 'global'; renderAll(); switchView('library'); }
  else if (command === 'undo') undoRegistry();
  else if (command === 'redo') redoRegistry();
  else if (command.startsWith('skill:')) { if (openSkill(command.slice(6))) switchView('workspace'); }
}

function bindPaneResizer(element, side) {
  element.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    element.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const pane = side === 'explorer' ? $('.explorer') : $('.inspector');
    const startWidth = pane?.getBoundingClientRect().width || (side === 'explorer' ? 248 : 286);
    const move = moveEvent => {
      const delta = (moveEvent.clientX - startX) * (side === 'explorer' ? 1 : -1);
      const viewportLimit = window.innerWidth * (side === 'explorer' ? .24 : .28);
      const width = Math.max(190, Math.min(430, viewportLimit, startWidth + delta));
      shell.style.setProperty(side === 'explorer' ? '--explorer-width' : '--inspector-width', `${width}px`);
      state.settings.panelWidths ||= {};
      state.settings.panelWidths[side] = Math.round(width);
    };
    const finish = async () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', finish);
      element.removeEventListener('pointercancel', finish);
      await persistRegistry('Размер панелей сохранён');
      applyGraphTransform();
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', finish);
    element.addEventListener('pointercancel', finish);
  });
}

function bindDialogBackdropDismissal() {
  $$('dialog').forEach(dialog => dialog.addEventListener('pointerdown', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    const insideDialog = event.clientX >= bounds.left && event.clientX <= bounds.right
      && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
    if (!insideDialog) dialog.close('cancel');
  }));
}

function setProjectActionsOpen(open) {
  const container = $('#projectActions');
  const button = $('#projectActionsButton');
  const dropdown = $('#projectActionsDropdown');
  if (!container || !button || !dropdown) return;
  const nextOpen = Boolean(open) && !container.hidden;
  dropdown.hidden = !nextOpen;
  button.setAttribute('aria-expanded', String(nextOpen));
}

function setGraphInfoOpen(open) {
  const button = $('#graphInfoButton');
  const popover = $('#graphInfoPopover');
  if (!button || !popover) return;
  const nextOpen = Boolean(open);
  popover.hidden = !nextOpen;
  button.setAttribute('aria-expanded', String(nextOpen));
}

function graphSearchMatches(query = '') {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return visibleSkills().slice(0, 8);
  return visibleSkills().filter(skill => `${skillName(skill)} ${skill.id} ${skill.namespace} ${(skill.tags || []).join(' ')} ${skill.description || ''}`.toLowerCase().includes(normalized)).slice(0, 12);
}

function renderGraphSearchResults(query = '') {
  const results = graphSearchMatches(query);
  $('#graphSearchResults').innerHTML = results.map((skill, index) => `<button type="button" role="option" data-graph-search-skill="${escapeHtml(skill.id)}" aria-selected="${index === 0}"><span class="skill-icon purple">${escapeHtml(skillIcon(skill))}</span><span><strong>${escapeHtml(skillName(skill))}</strong><small>${escapeHtml(skill.id)}</small></span></button>`).join('') || '<div class="graph-search-empty">Скиллы не найдены</div>';
}

function setGraphSearchOpen(open) {
  const button = $('#graphSearchButton');
  const popover = $('#graphSearchPopover');
  if (!button || !popover) return;
  const nextOpen = Boolean(open);
  popover.hidden = !nextOpen;
  button.setAttribute('aria-expanded', String(nextOpen));
  if (nextOpen) {
    renderGraphSearchResults($('#graphSearchInput').value);
    requestAnimationFrame(() => $('#graphSearchInput').focus());
  }
}

function focusGraphSkill(id) {
  const point = state.settings.graphPositions?.[id];
  const node = $(`.graph-node[data-skill-id="${CSS.escape(id)}"]`);
  if (!point || !node) return showToast('Этот скилл не отображается в текущем графе');
  const scale = Math.max(1.45, Math.min(2.1, graphTransform.scale));
  graphTransform = { scale, x: GRAPH_VIEW_WIDTH / 2 - point.x * scale, y: GRAPH_VIEW_HEIGHT / 2 - point.y * scale };
  applyGraphTransform();
  $$('.graph-node.graph-search-target').forEach(item => item.classList.remove('graph-search-target'));
  node.classList.add('graph-search-target');
  node.focus({ preventScroll: true });
  setTimeout(() => node.classList.remove('graph-search-target'), 1800);
  setGraphSearchOpen(false);
}

function closeCustomSelects(except = null) {
  $$('.custom-select.open').forEach(control => {
    if (control === except) return;
    control.classList.remove('open');
    control.querySelector('.custom-select-trigger')?.setAttribute('aria-expanded', 'false');
    const menu = control.querySelector('.custom-select-menu');
    if (menu) menu.hidden = true;
  });
}

function syncCustomSelect(select) {
  if (!select?.dataset.customSelect) return;
  const control = select.nextElementSibling;
  const selected = select.options[select.selectedIndex];
  const label = control?.querySelector('.custom-select-value');
  if (label) label.textContent = selected?.textContent || 'Выберите значение';
  control?.querySelectorAll('[data-select-value]').forEach(option => option.setAttribute('aria-selected', String(option.dataset.selectValue === select.value)));
}

function enhanceCustomSelects(root = document) {
  root.querySelectorAll('select:not([data-custom-select])').forEach(select => {
    select.dataset.customSelect = 'true';
    select.classList.add('native-select-hidden');
    const control = document.createElement('div');
    control.className = 'custom-select';
    control.innerHTML = `<button class="custom-select-trigger" type="button" aria-haspopup="listbox" aria-expanded="false"><span class="custom-select-value"></span><i aria-hidden="true"></i></button><div class="custom-select-menu" role="listbox" hidden>${[...select.options].map(option => `<button type="button" role="option" data-select-value="${escapeHtml(option.value)}"><span>${escapeHtml(option.textContent)}</span></button>`).join('')}</div>`;
    select.insertAdjacentElement('afterend', control);
    const trigger = control.querySelector('.custom-select-trigger');
    const menu = control.querySelector('.custom-select-menu');
    trigger.disabled = select.disabled;
    trigger.addEventListener('click', event => {
      event.stopPropagation();
      const willOpen = !control.classList.contains('open');
      closeCustomSelects(control);
      control.classList.toggle('open', willOpen);
      trigger.setAttribute('aria-expanded', String(willOpen));
      menu.hidden = !willOpen;
      if (willOpen) menu.querySelector('[aria-selected="true"]')?.focus();
    });
    menu.addEventListener('click', event => {
      const option = event.target.closest('[data-select-value]');
      if (!option) return;
      select.value = option.dataset.selectValue;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      syncCustomSelect(select);
      closeCustomSelects();
      trigger.focus();
    });
    control.addEventListener('keydown', event => {
      if (event.key === 'Escape') { closeCustomSelects(); trigger.focus(); return; }
      const options = [...menu.querySelectorAll('[data-select-value]')];
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      if (menu.hidden) { trigger.click(); return; }
      const index = options.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      options[next]?.focus();
    });
    select.addEventListener('change', () => syncCustomSelect(select));
    select.form?.addEventListener('reset', () => setTimeout(() => syncCustomSelect(select), 0));
    syncCustomSelect(select);
  });
}

function bindEvents() {
  bindDialogBackdropDismissal();
  bindProjectColorControls();
  enhanceCustomSelects();
  editor.addEventListener('input', () => { updateEditor(); setDirty(editor.value !== savedEditorValue); });
  editor.addEventListener('keyup', () => { const before = editor.value.slice(0, editor.selectionStart).split('\n'); $('#cursorPosition').textContent = `Ln ${before.length}, Col ${before.at(-1).length + 1}`; });
  editor.addEventListener('scroll', () => { gutter.scrollTop = editor.scrollTop; });
  $('#saveSkill').addEventListener('click', saveActiveSkill);
  $('#skillSearch').addEventListener('input', renderSkillLists);
  const updateSourceFormMode = () => {
    const form = $('#sourceForm');
    const serverMode = form.elements.type.value === 'http-json';
    $('#gitSourceOptions').hidden = serverMode;
    $('#sourceEndpointLabel').firstChild.textContent = serverMode ? 'Адрес сервера' : 'Ссылка на репозиторий';
    form.elements.endpoint.placeholder = serverMode ? 'https://skills.example.com/api/registry' : 'https://github.com/owner/skills';
    $('#sourceTokenHint').textContent = serverMode ? 'Bearer token только для этого запроса' : 'только для этого запроса';
    $('#sourceDialogNote').textContent = serverMode
      ? 'Сервер должен вернуть реестр SkillGraph, массив скиллов, список items с content либо один Markdown-скилл. Bearer token не сохраняется.'
      : 'Поддерживаются публичные и приватные репозитории GitHub/GitLab. Токен передаётся только API провайдера и не сохраняется. Репозиторий не клонируется.';
  };
  $('#sourceType').addEventListener('change', updateSourceFormMode);
  updateSourceFormMode();
  bindSkillDropSection($('#favoriteSection'), { favorite: true, groupId: '' });
  bindSkillDropSection($('#allSkillsSection'), { favorite: false, groupId: '' });
  $('#bindingSkillSearch').addEventListener('input', event => renderBindingCandidates(event.target.value));
  $$('[data-registry-scope]').forEach(button => button.addEventListener('click', async () => {
    if (button.dataset.registryScope === 'project' && !activeProject()) return showToast('Сначала добавьте или выберите проект');
    registryScope = button.dataset.registryScope;
    renderAll();
    $('#runtimeState').textContent = registryScope === 'project' ? 'Открыто представление проекта' : 'Открыт общий реестр';
  }));
  $('#addSkill').addEventListener('click', () => $('#addDialog').showModal());
  $('#quickAdd').addEventListener('click', () => $('#addDialog').showModal());
  $('#importSkill').addEventListener('click', () => $('#importInput').click());
  $('#importSkillFolder').addEventListener('click', importSkillFolder);
  $('#importSkillArchive').addEventListener('click', importSkillArchive);
  $('#openSources').addEventListener('click', () => { renderRemoteSources(); $('#sourceDialog').showModal(); });
  $('#exportRegistry').addEventListener('click', exportRegistry);
  $('#addProject').addEventListener('click', openProjectDialog);
  $('#addAgent').addEventListener('click', () => openAgentDialog());
  $$('[data-agent-mode]').forEach(button => button.addEventListener('click', () => { rememberAgentExecutionViewport(); agentViewMode = button.dataset.agentMode; renderAgents(); }));
  $('#agentProjectButton').addEventListener('click', event => { event.stopPropagation(); setAgentProjectMenuOpen($('#agentProjectButton').getAttribute('aria-expanded') !== 'true'); });
  $('#agentProjectButton').addEventListener('keydown', event => { if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return; event.preventDefault(); setAgentProjectMenuOpen(true); const options = $$('[data-agent-project]', $('#agentProjectDropdown')); (event.key === 'ArrowUp' ? options.at(-1) : options[0])?.focus(); });
  $('#agentProjectDropdown').addEventListener('click', event => event.stopPropagation());
  $('#agentProjectDropdown').addEventListener('keydown', event => { const options = $$('[data-agent-project]', event.currentTarget); const index = options.indexOf(document.activeElement); if (event.key === 'Escape') { event.preventDefault(); setAgentProjectMenuOpen(false); $('#agentProjectButton').focus(); return; } if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length; options[next]?.focus(); });
  $('#agentModeTabs').addEventListener('wheel', event => { const tabs = event.currentTarget; if (tabs.scrollWidth <= tabs.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return; event.preventDefault(); tabs.scrollLeft += event.deltaY; }, { passive: false });
  $('#agentModeTabs').addEventListener('scroll', event => { agentModeTabsScrollLeft = event.currentTarget.scrollLeft; }, { passive: true });
  $('#agentSkillSearch').addEventListener('input', event => renderAgentSkillChoices(event.target.value));
  $('#addSkillGroup').addEventListener('click', () => openSkillGroupDialog());
  $('#deleteSkillGroup').addEventListener('click', deleteCurrentSkillGroup);
  $('#projectActionsButton').addEventListener('click', event => {
    event.stopPropagation();
    setProjectActionsOpen($('#projectActionsButton').getAttribute('aria-expanded') !== 'true');
  });
  $('#projectActionsDropdown').addEventListener('click', event => event.stopPropagation());
  $('#graphInfo').addEventListener('pointerenter', () => setGraphInfoOpen(true));
  $('#graphInfo').addEventListener('pointerleave', () => setGraphInfoOpen(false));
  $('#graphInfo').addEventListener('focusin', () => setGraphInfoOpen(true));
  $('#graphInfo').addEventListener('focusout', event => { if (!event.currentTarget.contains(event.relatedTarget)) setGraphInfoOpen(false); });
  $('#graphInfoPopover').addEventListener('pointerdown', event => event.stopPropagation());
  $('#graphSearchButton').addEventListener('click', event => { event.stopPropagation(); setGraphSearchOpen($('#graphSearchButton').getAttribute('aria-expanded') !== 'true'); });
  $('#graphSearchPopover').addEventListener('pointerdown', event => event.stopPropagation());
  $('#graphSearchInput').addEventListener('input', event => renderGraphSearchResults(event.target.value));
  $('#graphSearchInput').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); setGraphSearchOpen(false); $('#graphSearchButton').focus(); }
    if (event.key === 'Enter') { event.preventDefault(); const first = graphSearchMatches(event.currentTarget.value)[0]; if (first) focusGraphSkill(first.id); else showToast('Скилл не найден'); }
  });
  $('#graphSearchResults').addEventListener('click', event => { const option = event.target.closest('[data-graph-search-skill]'); if (option) focusGraphSkill(option.dataset.graphSearchSkill); });
  document.addEventListener('pointerdown', event => {
    if (shell.classList.contains('mobile-explorer') && !event.target.closest('.explorer,#explorerToggle')) setMobileExplorerOpen(false);
    if (!event.target.closest('#projectActions')) setProjectActionsOpen(false);
    if (!event.target.closest('#agentProjectMenu')) setAgentProjectMenuOpen(false);
    if (!event.target.closest('#graphInfo')) setGraphInfoOpen(false);
    if (!event.target.closest('#graphSearch')) setGraphSearchOpen(false);
    if (!event.target.closest('.custom-select')) closeCustomSelects();
  });
  $('#editProject').addEventListener('click', () => { setProjectActionsOpen(false); openProjectEditDialog(); });
  $('#chooseProjectLocation').addEventListener('click', chooseProjectFolder);
  $('#projectDirectoryInput').addEventListener('change', event => {
    const first = event.target.files?.[0];
    if (!first) return;
    const folder = first.webkitRelativePath?.split('/')[0] || first.name;
    $('#projectLocation').value = folder;
    if (!$('#projectForm').elements.name.value) $('#projectForm').elements.name.value = folder;
  });
  $('#importInput').addEventListener('change', event => importFiles([...event.target.files]));
  $('#registryImportInput').addEventListener('change', event => {
    const file = event.target.files?.[0];
    if (file) prepareRegistryImport(file);
  });
  $('#skillFolderInput').addEventListener('change', event => importFiles([...event.target.files].filter(file => /\.(md|markdown|json)$/i.test(file.name))));
  bindOpenButtons();

  $$('[data-editor-mode]').forEach(button => button.addEventListener('click', () => {
    $$('[data-editor-mode]').forEach(item => item.classList.toggle('active', item === button));
    const isPreview = button.dataset.editorMode === 'preview'; editor.hidden = isPreview; gutter.hidden = isPreview; preview.hidden = !isPreview;
  }));
  $$('.tab[data-view]').forEach(tab => tab.addEventListener('click', () => switchView(tab.dataset.view)));
  $('#workspaceTabs').addEventListener('click', event => {
    const closeButton = event.target.closest('[data-close-skill-tab]');
    if (closeButton) { event.stopPropagation(); closeSkillTab(closeButton.dataset.closeSkillTab); return; }
    const skillTab = event.target.closest('[data-skill-tab]');
    if (skillTab && openSkill(skillTab.dataset.skillTab)) switchView('workspace');
  });
  $('#workspaceTabs').addEventListener('keydown', event => {
    const skillTab = event.target.closest('[data-skill-tab]');
    if (skillTab && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); if (openSkill(skillTab.dataset.skillTab)) switchView('workspace'); }
  });
  $('#workspaceTabs').addEventListener('wheel', event => {
    const tabs = event.currentTarget;
    if (tabs.scrollWidth <= tabs.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    tabs.scrollLeft += event.deltaY;
  }, { passive: false });
  $('#workspaceTabs').addEventListener('scroll', event => { workspaceTabsScrollLeft = event.currentTarget.scrollLeft; }, { passive: true });
  $$('.ribbon-button[data-nav]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.nav)));
  $$('.tree-label').forEach(button => button.addEventListener('click', () => { const open = button.getAttribute('aria-expanded') === 'true'; button.setAttribute('aria-expanded', String(!open)); button.nextElementSibling.hidden = open; button.querySelector('.chevron').textContent = open ? '›' : '⌄'; }));

  $('#themeToggle').addEventListener('click', async () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; state.settings.theme = theme; syncThemeToggle(); await persistRegistry(); });
  $('#explorerToggle').addEventListener('click', () => setMobileExplorerOpen(!shell.classList.contains('mobile-explorer')));
  $('#panelToggle').addEventListener('click', () => shell.classList.toggle('inspector-hidden'));
  $('#closeInspector').addEventListener('click', () => shell.classList.add('inspector-hidden'));
  bindPaneResizer($('#explorerResizer'), 'explorer');
  bindPaneResizer($('#inspectorResizer'), 'inspector');

  const openCommandPalette = () => {
    renderCommands();
    if (!$('#commandDialog').open) $('#commandDialog').showModal();
    setTimeout(() => { $('#commandInput').focus(); $('#commandInput').select(); }, 20);
  };
  $('#commandTrigger').addEventListener('click', openCommandPalette);
  $('#commandInput').addEventListener('input', event => renderCommands(event.target.value));
  const closeCommandPalette = () => { if ($('#commandDialog').open) $('#commandDialog').close(); $('#commandInput').value = ''; };
  $('#closeCommandPalette').addEventListener('click', closeCommandPalette);
  document.addEventListener('keydown', event => {
    const key = event.key.toLowerCase();
    const editingText = Boolean(event.target.closest('textarea,input,[contenteditable="true"]'));
    if ((event.ctrlKey || event.metaKey) && key === 's') { event.preventDefault(); saveActiveSkill(); }
    if ((event.ctrlKey || event.metaKey) && key === 'k') { event.preventDefault(); openCommandPalette(); }
    if ((event.ctrlKey || event.metaKey) && key === 'f' && !event.target.closest('textarea')) { event.preventDefault(); $('#skillSearch').focus(); $('#skillSearch').select(); }
    if ((event.ctrlKey || event.metaKey) && key === 'z' && !editingText) { event.preventDefault(); if (event.shiftKey) redoRegistry(); else undoRegistry(); }
    if ((event.ctrlKey || event.metaKey) && key === 'y' && !editingText) { event.preventDefault(); redoRegistry(); }
    if ((event.ctrlKey || event.metaKey) && key === 'n') { event.preventDefault(); $('#addDialog').showModal(); }
    if ((event.ctrlKey || event.metaKey) && key === 'o') { event.preventDefault(); $('#importInput').click(); }
    if ((event.ctrlKey || event.metaKey) && key === 'g') { event.preventDefault(); switchView('graph'); }
    if ((event.ctrlKey || event.metaKey) && key === 'l' && !editingText) { event.preventDefault(); registryScope = 'global'; renderAll(); switchView('library'); $('#runtimeState').textContent = 'Открыт общий реестр'; }
    if (event.key === 'Escape' && $('#agentProjectButton').getAttribute('aria-expanded') === 'true') { event.preventDefault(); setAgentProjectMenuOpen(false); $('#agentProjectButton').focus(); }
    if (event.key === 'Escape' && $('#projectActionsButton').getAttribute('aria-expanded') === 'true') { event.preventDefault(); setProjectActionsOpen(false); $('#projectActionsButton').focus(); }
    if (event.key === 'Escape' && $('#graphInfoButton').getAttribute('aria-expanded') === 'true') { event.preventDefault(); setGraphInfoOpen(false); $('#graphInfoButton').focus(); }
    if (event.key === 'Escape' && shell.classList.contains('mobile-explorer')) { event.preventDefault(); setMobileExplorerOpen(false); $('#explorerToggle').focus(); }
    if (event.key === 'Escape' && $('#commandDialog').open) { event.preventDefault(); closeCommandPalette(); }
  });
  window.addEventListener('skillgraph:save', () => saveActiveSkill());
  window.addEventListener('skillgraph:command-palette', openCommandPalette);
  window.addEventListener('resize', () => {
    const nextCompact = window.innerWidth <= 760;
    if (compactLayoutActive && !nextCompact) {
      setMobileExplorerOpen(false);
      shell.classList.remove('navigator-docking');
      void shell.offsetWidth;
      shell.classList.add('navigator-docking');
      clearTimeout(navigatorDockTimer);
      navigatorDockTimer = setTimeout(() => shell.classList.remove('navigator-docking'), 260);
    } else if (!compactLayoutActive && nextCompact) {
      shell.classList.remove('navigator-docking');
      setMobileExplorerOpen(false);
    }
    compactLayoutActive = nextCompact;
    applyGraphTransform();
  });
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });

  $('#addForm').addEventListener('submit', async event => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault(); const form = new FormData(event.currentTarget); const id = slugify(form.get('id'));
    if (!event.currentTarget.reportValidity()) return;
    if (state.skills.some(skill => skill.id === id)) return showToast('Скилл с таким идентификатором уже существует');
    const deps = ['requires', 'extends', 'recommends'].flatMap(type => splitList(form.get(type)).map(dep => dependency(dep, type, '*')));
    const name = form.get('name').trim();
    const skill = normalizeSkill({ id, name, title: name, namespace: form.get('namespace').trim() || 'local', version: form.get('version').trim() || '0.1.0', description: form.get('description').trim(), tags: splitList(form.get('tags')), deps, status: 'draft' });
    state.skills.unshift(skill); activeSkillId = skill.id; $('#addDialog').close(); event.currentTarget.reset(); event.currentTarget.elements.namespace.value = 'local'; event.currentTarget.elements.version.value = '0.1.0';
    await persistRegistry('Новый скилл создан'); openSkill(skill.id, true); switchView('workspace'); showToast(`Скилл «${skillName(skill)}» создан`);
  });

  $('#renameForm').addEventListener('submit', async event => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault();
    const skill = activeSkill();
    if (!skill || !event.currentTarget.reportValidity()) return;
    const form = new FormData(event.currentTarget);
    const nextId = slugify(form.get('id'));
    if (state.skills.some(item => item.id === nextId && item !== skill)) return showToast(`Имя «${nextId}» уже используется`);
    const oldId = skill.id;
    skill.id = nextId;
    skill.name = form.get('name').trim();
    skill.title = skill.name;
    skill.namespace = form.get('namespace').trim() || 'local';
    skill.tags = splitList(form.get('tags'));
    skill.content = replaceFrontmatterValue(skill.content, 'id', `${skill.namespace}.${skill.id}`);
    skill.content = replaceFrontmatterValue(skill.content, 'name', skill.name);
    skill.content = replaceFrontmatterValue(skill.content, 'title', skill.name);
    skill.content = replaceFrontmatterList(skill.content, 'tags', skill.tags);
    skill.updatedAt = new Date().toISOString();
    remapSkillId(oldId, nextId);
    activeSkillId = nextId;
    editor.value = skill.content;
    savedEditorValue = skill.content;
    setDirty(false);
    $('#renameDialog').close();
    await persistRegistry(`Скилл переименован в ${nextId}`);
    renderAll();
    showToast('Скилл и все его связи переименованы');
  });

  $('#saveVersionForm').addEventListener('submit', async event => {
    event.preventDefault();
    const skill = activeSkill();
    if (!skill || !dirty) return $('#saveVersionDialog').close();
    const keepVersion = event.submitter?.value === 'keep';
    if (!keepVersion && !event.currentTarget.reportValidity()) return;
    const nextVersion = keepVersion ? skill.version : new FormData(event.currentTarget).get('version').trim();
    $('#saveVersionDialog').close();
    await commitActiveSkill(nextVersion);
  });

  $('#projectForm').addEventListener('submit', async event => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault(); const form = new FormData(event.currentTarget); if (!event.currentTarget.reportValidity()) return;
    const project = normalizeProject({ id: `project-${Date.now()}`, name: form.get('name').trim(), location: form.get('location').trim(), description: form.get('description').trim(), color: form.get('color'), roots: [] });
    state.projects.push(project); activeProjectId = project.id; $('#projectDialog').close(); event.currentTarget.reset(); await persistRegistry('Проект добавлен'); renderAll(); switchView('projects');
  });

  $('#projectEditForm').addEventListener('submit', async event => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault();
    const project = activeProject();
    if (!project || !event.currentTarget.reportValidity()) return;
    const form = new FormData(event.currentTarget);
    project.name = form.get('name').trim();
    project.description = form.get('description').trim();
    project.color = /^#[0-9a-f]{6}$/i.test(form.get('color')) ? form.get('color') : '#8b6dde';
    $('#projectEditDialog').close();
    await persistRegistry('Проект обновлён');
    renderAll();
  });

  $('#agentForm').addEventListener('submit', async event => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const form = new FormData(event.currentTarget);
    const existing = state.agents.find(agent => agent.id === form.get('id'));
    const baseId = slugify(form.get('name'));
    let id = existing?.id || baseId;
    let suffix = 2;
    while (!existing && state.agents.some(agent => agent.id === id)) id = `${baseId}-${suffix++}`;
    const next = normalizeAgent({
      ...(existing || {}), id, name: form.get('name').trim(), role: form.get('role').trim(), provider: form.get('provider'), status: form.get('status'), color: form.get('color'), description: form.get('description').trim(),
      permissions: { read: form.has('permissionRead'), create: form.has('permissionCreate'), edit: form.has('permissionEdit'), relations: form.has('permissionRelations'), delete: form.has('permissionDelete') },
      routing: { keywords: splitList(form.get('routingKeywords')), tags: splitList(form.get('routingTags')), priority: Number(form.get('routingPriority')) || 0, fallback: form.has('routingFallback') },
      security: { ...(existing?.security || {}), trustedOnly: form.has('trustedOnly') },
      rootSkills: existing?.rootSkills || [], updatedAt: new Date().toISOString()
    });
    if (existing) state.agents[state.agents.indexOf(existing)] = next; else state.agents.push(next);
    activeAgentId = next.id;
    $('#agentDialog').close();
    appendAudit(existing ? 'agent-updated' : 'agent-created', { agentId: next.id, detail: next.role });
    await persistRegistry(existing ? 'Агент обновлён' : 'Агент создан');
    renderAll();
    switchView('agents');
  });

  $('#agentSkillsForm').addEventListener('submit', async event => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault();
    const agent = activeAgent();
    if (!agent) return;
    agent.rootSkills = [...pendingAgentRootSkills].filter(id => state.skills.some(skill => skill.id === id));
    agent.updatedAt = new Date().toISOString();
    $('#agentSkillsDialog').close();
    await persistRegistry('Скиллы агента обновлены');
    renderAll();
  });

  $('#projectAgentsForm').addEventListener('submit', async event => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault();
    const project = activeProject();
    if (!project) return;
    project.agentIds = [...event.currentTarget.querySelectorAll('input[name="agent"]:checked')].map(input => input.value).filter(id => state.agents.some(agent => agent.id === id));
    $('#projectAgentsDialog').close();
    await persistRegistry('Агенты проекта обновлены');
    renderAll();
  });

  $('#skillGroupForm').addEventListener('submit', async event => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const name = new FormData(event.currentTarget).get('name').trim();
    if (editingSkillGroupId) {
      const group = state.groups.find(item => item.id === editingSkillGroupId);
      if (group) group.name = name;
    } else {
      state.groups.push(normalizeGroup({ name }));
    }
    editingSkillGroupId = null;
    $('#skillGroupDialog').close();
    await persistRegistry('Группа сохранена');
    renderAll();
  });

  $('#sourceForm').addEventListener('submit', async event => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const form = new FormData(event.currentTarget);
    const source = normalizeSource({ type: form.get('type'), name: form.get('name').trim(), endpoint: form.get('endpoint').trim(), branch: form.get('branch').trim(), path: form.get('path').trim() });
    state.sources.push(source);
    const connected = await syncRemoteSource(source, form.get('token'));
    if (connected) { $('#sourceDialog').close(); event.currentTarget.reset(); updateSourceFormMode(); }
    else {
      state.sources = state.sources.filter(item => item.id !== source.id);
      await persistRegistry('Неудачное подключение удалённого источника удалено');
      renderRemoteSources();
    }
  });

  $('#bindingForm').addEventListener('submit', async event => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault(); const project = activeProject(); const id = new FormData(event.currentTarget).get('skill'); if (!project || !id) return;
    project.roots.push(id); project.roots = [...new Set(project.roots)]; $('#bindingDialog').close(); await persistRegistry('Скилл подключён к проекту'); renderAll();
  });

  $('#registryImportForm').addEventListener('submit', async event => {
    if (event.submitter?.value === 'cancel') { pendingRegistryImport = null; return; }
    event.preventDefault();
    await applyPendingRegistryImport(new FormData(event.currentTarget).get('mode') || 'merge');
  });

  $('#deleteProject').addEventListener('click', async () => { setProjectActionsOpen(false); const project = activeProject(); if (!project) return; const activeRun = (state.agentRuns || []).find(run => run.projectId === project.id && !['completed', 'failed', 'cancelled'].includes(run.status)); if (activeRun) return showToast('Сначала завершите или отмените активную агентную цепочку'); if (!confirm(`Удалить проект «${project.name}»? Скиллы останутся в библиотеке.`)) return; state.projects = state.projects.filter(item => item.id !== project.id); activeProjectId = state.projects[0]?.id ?? null; await persistRegistry('Проект удалён'); renderAll(); });
  $('#openIntegrations').addEventListener('click', async () => { renderIntegrationStatus(); $('#integrationDialog').showModal(); await refreshIntegrationStatus(false); });
  $('#refreshIntegrations').addEventListener('click', () => refreshIntegrationStatus(true));
  $('#closeIntegrations').addEventListener('click', () => $('#integrationDialog').close());
  $('#doneIntegrations').addEventListener('click', () => $('#integrationDialog').close());
  $('#resolveButton').addEventListener('click', () => { const project = activeProject(); if (!project) return; const resolved = resolveProject(project); renderProjectView(); showToast(resolved.conflicts.length ? `Найдено проблем: ${resolved.conflicts.length}` : `Цепочка собрана: ${resolved.order.length} скиллов`); });
  $('#compareVersions').addEventListener('click', openLatestDiff);
  $('#closeDiff').addEventListener('click', () => $('#diffDialog').close());
  $('#doneDiff').addEventListener('click', () => $('#diffDialog').close());
  $('#closeImagePreview').addEventListener('click', () => $('#imagePreviewDialog').close());
  $('#imagePreviewDialog').addEventListener('click', event => { if (event.target === $('#imagePreviewDialog')) $('#imagePreviewDialog').close(); });

  $('#startLinkButton').addEventListener('click', () => {
    if (linkMode.active) cancelLinkMode(); else startLinkMode();
  });
  $('#graphContextMenu').addEventListener('pointerdown', event => event.stopPropagation());
  $$('[data-graph-action]').forEach(button => button.addEventListener('click', () => {
    const id = graphContextSkillId;
    $('#graphContextMenu').hidden = true;
    if (!id) return;
    if (button.dataset.graphAction === 'edit') { if (openSkill(id)) switchView('workspace'); }
    if (button.dataset.graphAction === 'rename') { if (openSkill(id)) openRenameDialog(); }
    if (button.dataset.graphAction === 'link') startLinkMode(id);
  }));
  document.addEventListener('click', event => { if (!event.target.closest('#graphContextMenu')) $('#graphContextMenu').hidden = true; });

  $('#relationForm').addEventListener('submit', async event => {
    if (event.submitter?.value === 'cancel') { cancelLinkMode(); return; }
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const source = state.skills.find(skill => skill.id === form.get('source'));
    const target = state.skills.find(skill => skill.id === form.get('target'));
    if (!source || !target) return;
    const type = form.get('type');
    const range = form.get('range').trim() || '*';
    const existing = source.deps.find(dep => dep.id === target.id && dep.type === type);
    if (existing) existing.range = range;
    else source.deps.push(dependency(target.id, type, range));
    syncSkillDependenciesToContent(source);
    source.updatedAt = new Date().toISOString();
    if (activeSkillId === source.id) {
      editor.value = source.content;
      savedEditorValue = source.content;
      setDirty(false);
    }
    $('#relationDialog').close();
    linkMode = { active: false, source: null };
    await persistRegistry(`Связь ${source.id} → ${target.id} создана`);
    renderAll();
    showToast('Линия связи создана и сохранена');
  });

  $('#zoomIn').addEventListener('click', () => setZoom(graphTransform.scale * 1.2));
  $('#zoomOut').addEventListener('click', () => setZoom(graphTransform.scale / 1.2));
  $('#zoomLabel').addEventListener('click', fitGraph);
  $('#graphCanvas').addEventListener('wheel', event => { event.preventDefault(); setZoom(graphTransform.scale * (event.deltaY < 0 ? 1.12 : .89)); }, { passive: false });
  $('#graphCanvas').addEventListener('dblclick', fitGraph);
  $('#graphCanvas').addEventListener('pointerdown', event => { if (event.button !== 0) return; graphDragging = { clientX: event.clientX, clientY: event.clientY, startX: graphTransform.x, startY: graphTransform.y, moved: false }; event.currentTarget.setPointerCapture(event.pointerId); });
  $('#graphCanvas').addEventListener('pointermove', event => { if (!graphDragging) return; const ratio = GRAPH_VIEW_WIDTH / Math.max(1, $('#graphSvg').clientWidth); const dx = (event.clientX - graphDragging.clientX) * ratio; const dy = (event.clientY - graphDragging.clientY) * ratio; graphDragging.moved ||= Math.abs(dx) + Math.abs(dy) > 3; graphTransform.x = graphDragging.startX + dx; graphTransform.y = graphDragging.startY + dy; applyGraphTransform(); });
  $('#graphCanvas').addEventListener('pointerup', () => { setTimeout(() => { graphDragging = null; }, 0); });
  new ResizeObserver(() => requestAnimationFrame(() => { applyGraphTransform(); updateGraphGeometry(); })).observe($('#graphCanvas'));
}

async function boot() {
  await initializeRegistry();
  bindEvents();
  window.addEventListener('skillgraph:registry-changed', refreshExternalRegistry);
  if (activeSkillId) openSkill(activeSkillId, true); else clearEditor();
  renderAll();
  if (desktopRuntime) {
    await refreshRuntimeState(false);
    setInterval(() => { refreshExternalRegistry(); refreshRuntimeState(); }, 2000);
    refreshIntegrationStatus(false);
  }
}

boot().catch(error => {
  console.error(error);
  if (desktopHostExpected && !document.querySelector('.startup-failure')) showDesktopStartupFailure(error.message || 'Неизвестная ошибка запуска.');
});
