import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const assets = [
  {
    id: 'project-template-task8-populated-table',
    name: 'project-template-task8-populated-table.png',
    caption: 'Эталон заполненной широкой таблицы задачи 8: toolbar, inline-фильтры, многоуровневая шапка, sticky-колонки и скролл',
    relation: 'extends',
  },
  {
    id: 'project-template-task8-filter-panel',
    name: 'project-template-task8-filter-panel.png',
    caption: 'Эталон правой панели ФИЛЬТР задачи 8 с переключателями и действием СБРОСИТЬ',
    relation: 'extends',
  },
  {
    id: 'project-template-incorrect-blue-layout',
    name: 'project-template-incorrect-blue-layout.png',
    caption: 'Анти-референс: неверные голубой фон, растянутые поля и oversized footer; не воспроизводить',
    relation: 'anti-reference',
  },
  {
    id: 'project-template-incorrect-compact-table',
    name: 'project-template-incorrect-compact-table.png',
    caption: 'Анти-референс: неверная компактная плоская Ant Table; не воспроизводить',
    relation: 'anti-reference',
  },
  {
    id: 'project-template-incorrect-filter-dropdown',
    name: 'project-template-incorrect-filter-dropdown.png',
    caption: 'Анти-референс: неверное маленькое dropdown-меню фильтра; не воспроизводить',
    relation: 'anti-reference',
  },
];

const registryPaths = process.argv.slice(2);
if (registryPaths.length === 0) throw new Error('Передайте хотя бы один путь к registry.json');

for (const registryPath of registryPaths) {
  const absolutePath = resolve(registryPath);
  const registry = JSON.parse(await readFile(absolutePath, 'utf8'));
  const skill = registry.skills?.find(item => item.namespace === 'local' && item.name === 'project-template-builder');
  if (!skill) throw new Error(`Скилл local.project-template-builder не найден: ${absolutePath}`);

  const existing = new Map((skill.images ?? []).map(image => [image.id, image]));
  const assetRoot = resolve(dirname(absolutePath), 'assets');
  for (const asset of assets) {
    const prior = existing.get(asset.id) ?? {};
    existing.set(asset.id, {
      ...prior,
      ...asset,
      path: resolve(assetRoot, asset.name),
      relativePath: asset.name,
      url: `https://skillgraph-assets.local/${asset.name}`,
      createdAt: prior.createdAt ?? new Date().toISOString(),
    });
  }
  skill.images = [...existing.values()];
  skill.modified = new Date().toISOString();
  await writeFile(absolutePath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  process.stdout.write(`Обновлены референсы ${absolutePath}\n`);
}
