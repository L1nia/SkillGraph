import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const skill = await readFile(resolve(root, 'skills/project-template-builder.md'), 'utf8');
const prompt = await readFile(resolve(root, 'docs/PROJECT-TEMPLATE-RUN-PROMPT.md'), 'utf8');
assert.match(skill, /QueryParametersPanel` — \*\*это header приложения\*\*/, 'filter parameters must be the application header');
assert.match(skill, /Не создавай отдельный `AppHeader`/, 'separate AppHeader must be explicitly forbidden');
assert.match(skill, /Segoe UI/, 'the Windows UI font must be specified');
assert.match(skill, /<input type="date">/, 'native date input must be specified');
assert.match(skill, /Фронт: \{frontendVersion\} \| Бэк: \{backendVersion\} \| Дата: \{lastModifiedDate\}/, 'footer must use the canonical labels and order');
assert.match(prompt, /skill:\/\/local\.project-template-builder@1\.0\.6 как обязательный контракт/, 'run prompt must require the current skill contract');
assert.match(prompt, /Промпт определяет только предметную задачу/, 'run prompt must delegate visual and artifact requirements to the skill');
assert.match(skill, /colorBgLayout: '#f3f4f6'/, 'page background must be neutral gray');
assert.doesNotMatch(skill, /colorBgLayout: '#eef3f8'/, 'blue-tinted page background must not return');
assert.match(skill, /шириной `256px`/, 'filter must be a full right-side panel');
assert.match(skill, /многоуровневые заголовки/, 'table must support grouped headers');

const requiredAttachmentIds = [
  'project-template-task8-populated-table',
  'project-template-task8-filter-panel',
  'project-template-incorrect-blue-layout',
  'project-template-incorrect-compact-table',
  'project-template-incorrect-filter-dropdown',
];
for (const id of requiredAttachmentIds) {
  assert.match(skill, new RegExp(`skillgraph-asset://${id}`), `source skill must reference attachment ${id}`);
}

console.log('PASS project-template-builder visual contract');
