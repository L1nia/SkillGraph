import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [registryArgument, projectSelector, skillId] = process.argv.slice(2);
if (!registryArgument || !projectSelector || !skillId) {
  throw new Error('Usage: node ensure-project-skill-root.mjs <registry.json> <project-id-or-name> <skill-id>');
}

const registryPath = resolve(registryArgument);
const registry = JSON.parse(await readFile(registryPath, 'utf8'));
const project = registry.projects?.find(
  (item) => item.id === projectSelector || item.name === projectSelector,
);
if (!project) {
  throw new Error(`Project not found: ${projectSelector}`);
}
if (!registry.skills?.some((item) => item.id === skillId || item.name === skillId)) {
  throw new Error(`Skill not found: ${skillId}`);
}

project.roots = Array.from(new Set([...(project.roots ?? []), skillId]));
registry.updatedAt = new Date().toISOString();
registry.registryRevision = Math.max(0, Number(registry.registryRevision) || 0) + 1;
await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
process.stdout.write(`Connected ${skillId} to ${project.name} in ${registryPath}\n`);
