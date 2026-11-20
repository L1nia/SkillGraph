(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SkillGraphRunLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function computeRunDepths(tasks) {
    const list = Array.isArray(tasks) ? tasks : [];
    const byId = new Map(list.map(task => [String(task.id), task]));
    const visiting = new Set();
    const visited = new Set();
    const depths = {};
    function visit(id) {
      if (visited.has(id)) return depths[id];
      if (visiting.has(id)) throw new Error('Dependency cycle in agent run');
      const task = byId.get(id);
      if (!task) throw new Error(`Unknown dependency ${id}`);
      visiting.add(id);
      const dependencies = Array.isArray(task.dependsOn) ? task.dependsOn : [];
      const depth = dependencies.length ? Math.max(...dependencies.map(visit)) + 1 : 0;
      visiting.delete(id); visited.add(id); depths[id] = depth;
      return depth;
    }
    list.forEach(task => visit(String(task.id)));
    return depths;
  }

  function runProgress(tasks) {
    const list = Array.isArray(tasks) ? tasks : [];
    const completed = list.filter(task => task.status === 'completed').length;
    return { completed, total: list.length, percent: list.length ? Math.round(completed * 100 / list.length) : 0 };
  }

  function currentRunTask(tasks) {
    const list = Array.isArray(tasks) ? tasks : [];
    const completed = new Set(list.filter(task => task.status === 'completed').map(task => String(task.id)));
    return list.find(task => ['running', 'claimed', 'review', 'waiting'].includes(task.status))
      || list.find(task => task.status === 'queued' && (task.dependsOn || []).every(id => completed.has(String(id))))
      || list.find(task => task.status === 'queued')
      || list.at(-1)
      || null;
  }

  function nextRunTaskAfterCompletion(tasks, previousStatuses) {
    const list = Array.isArray(tasks) ? tasks : [];
    if (!previousStatuses || typeof previousStatuses !== 'object') return null;
    const completedNow = list.some(task => task.status === 'completed'
      && previousStatuses[String(task.id)]
      && previousStatuses[String(task.id)] !== 'completed');
    if (!completedNow) return null;
    const candidate = currentRunTask(list);
    return candidate?.status === 'completed' ? null : candidate;
  }

  function buildSwimlaneLayout(run, tasks, agents) {
    const list = Array.isArray(tasks) ? tasks : [];
    const byAgent = new Map((agents || []).map(agent => [String(agent.id), agent]));
    const orderedAgentIds = [];
    list.forEach(task => { const id = String(task.agentId || 'unassigned'); if (!orderedAgentIds.includes(id)) orderedAgentIds.push(id); });
    const depths = computeRunDepths(list);
    const laneHeight = 116;
    const columnWidth = 230;
    const left = 210;
    const top = 28;
    const lanes = orderedAgentIds.map((agentId, index) => ({
      id: agentId,
      index,
      y: top + index * laneHeight,
      agent: byAgent.get(agentId) || { id: agentId, name: 'Удалённый агент', color: '#777777' }
    }));
    const laneById = new Map(lanes.map(lane => [lane.id, lane]));
    const nodes = list.map(task => ({
      ...task,
      depth: depths[String(task.id)],
      lane: laneById.get(String(task.agentId || 'unassigned'))?.index ?? 0,
      x: left + depths[String(task.id)] * columnWidth,
      y: (laneById.get(String(task.agentId || 'unassigned'))?.y ?? top) + 20
    }));
    const edges = [];
    list.forEach(task => (task.dependsOn || []).forEach(from => edges.push({ from: String(from), to: String(task.id) })));
    const maxDepth = Math.max(0, ...Object.values(depths));
    return { runId: run?.id || '', lanes, nodes, edges, width: left + (maxDepth + 1) * columnWidth + 220, height: Math.max(220, top + lanes.length * laneHeight), depths };
  }

  return { computeRunDepths, runProgress, currentRunTask, nextRunTaskAfterCompletion, buildSwimlaneLayout };
});
