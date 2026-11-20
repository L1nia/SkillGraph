import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const skillPath = resolve(root, 'skills', 'project-template-builder.md');
const content = await readFile(skillPath, 'utf8');
const description = 'Строгий визуальный и архитектурный контракт для React-приложений с параметрами, информационными сообщениями, управляемой таблицей и Excel. Референсы из задачи 8 являются источником истины; интерфейс строится на Ant Design.';

const registryPaths = process.argv.slice(2);
if (registryPaths.length === 0) {
  throw new Error('Передайте хотя бы один путь к registry.json');
}

for (const registryPath of registryPaths) {
  const absolutePath = resolve(registryPath);
  const registry = JSON.parse(await readFile(absolutePath, 'utf8'));
  const skill = registry.skills?.find(
    (item) => item.name === 'project-template-builder' && item.namespace === 'local',
  );

  if (!skill) {
    throw new Error(`Скилл local.project-template-builder не найден: ${absolutePath}`);
  }

  skill.content = content;
  skill.description = description;
  skill.title = 'Шаблон проекта: управляемые таблицы и Excel';
  skill.tags = Array.from(new Set([...(skill.tags ?? []), 'project-template', 'react', 'antd', 'table', 'excel']));
  skill.modified = new Date().toISOString();

  await writeFile(absolutePath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  process.stdout.write(`Обновлён ${absolutePath}\n`);
}
