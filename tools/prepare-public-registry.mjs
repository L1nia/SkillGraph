import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const registryPath = path.join(root, 'data', 'registry.json');
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

for (const skill of registry.skills ?? []) {
  for (const asset of skill.images ?? skill.assets ?? []) {
    const fileName = asset.name || asset.fileName || asset.path?.split(/[\\/]/).pop();
    if (!fileName) continue;
    asset.path = `data/assets/${fileName}`;
    asset.relativePath = `data/assets/${fileName}`;
  }
}

const publicRegistry = {
  ...registry,
  updatedAt: new Date().toISOString(),
  registryRevision: 0,
  projects: [],
  agents: [],
  handoffs: [],
  agentRuns: [],
  runTasks: [],
  runArtifacts: [],
  auditLog: [],
  evaluations: [],
  sources: [],
  groups: [],
  settings: { theme: registry.settings?.theme === 'light' ? 'light' : 'dark' },
};

fs.writeFileSync(registryPath, `${JSON.stringify(publicRegistry, null, 2)}\n`, 'utf8');
console.log(`Prepared public registry with ${publicRegistry.skills?.length || 0} skills and no user projects.`);
