import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const [registryPath, upstreamRoot, outputPath] = process.argv.slice(2);
if (!registryPath || !upstreamRoot || !outputPath) {
  throw new Error('Usage: node prepare-habr-upstream-import.mjs <registry.json> <upstream-root> <output.json>');
}

const sources = {
  'find-skills': ['vercel-labs__skills', 'skills/find-skills/SKILL.md', 'https://github.com/vercel-labs/skills'],
  'grill-me': ['mattpocock__skills', 'skills/productivity/grill-me/SKILL.md', 'https://github.com/mattpocock/skills'],
  'grill-with-docs': ['mattpocock__skills', 'skills/engineering/grill-with-docs/SKILL.md', 'https://github.com/mattpocock/skills'],
  'improve-codebase-architecture': ['mattpocock__skills', 'skills/engineering/improve-codebase-architecture/SKILL.md', 'https://github.com/mattpocock/skills'],
  'frontend-design': ['anthropics__skills', 'skills/frontend-design/SKILL.md', 'https://github.com/anthropics/skills'],
  'tdd': ['mattpocock__skills', 'skills/engineering/tdd/SKILL.md', 'https://github.com/mattpocock/skills'],
  'agent-browser': ['vercel-labs__agent-browser', 'skills/agent-browser/SKILL.md', 'https://github.com/vercel-labs/agent-browser'],
  'handoff': ['mattpocock__skills', 'skills/productivity/handoff/SKILL.md', 'https://github.com/mattpocock/skills'],
  'triage': ['mattpocock__skills', 'skills/engineering/triage/SKILL.md', 'https://github.com/mattpocock/skills'],
  'prototype': ['mattpocock__skills', 'skills/engineering/prototype/SKILL.md', 'https://github.com/mattpocock/skills'],
  'vercel-react-best-practices': ['vercel-labs__agent-skills', 'skills/react-best-practices/SKILL.md', 'https://github.com/vercel-labs/agent-skills'],
  'web-design-guidelines': ['vercel-labs__agent-skills', 'skills/web-design-guidelines/SKILL.md', 'https://github.com/vercel-labs/agent-skills'],
  'teach': ['mattpocock__skills', 'skills/productivity/teach/SKILL.md', 'https://github.com/mattpocock/skills'],
  'domain-modeling': ['mattpocock__skills', 'skills/engineering/domain-modeling/SKILL.md', 'https://github.com/mattpocock/skills'],
  'codebase-design': ['mattpocock__skills', 'skills/engineering/codebase-design/SKILL.md', 'https://github.com/mattpocock/skills'],
  'diagnosing-bugs': ['mattpocock__skills', 'skills/engineering/diagnosing-bugs/SKILL.md', 'https://github.com/mattpocock/skills'],
  'implement': ['mattpocock__skills', 'skills/engineering/implement/SKILL.md', 'https://github.com/mattpocock/skills'],
  'code-review': ['mattpocock__skills', 'skills/engineering/code-review/SKILL.md', 'https://github.com/mattpocock/skills'],
  'wayfinder': ['mattpocock__skills', 'skills/engineering/wayfinder/SKILL.md', 'https://github.com/mattpocock/skills'],
  'design-taste-frontend': ['leonxlnx__taste-skill', 'skills/taste-skill/SKILL.md', 'https://github.com/Leonxlnx/taste-skill'],
  'research': ['mattpocock__skills', 'skills/engineering/research/SKILL.md', 'https://github.com/mattpocock/skills'],
  'to-spec': ['mattpocock__skills', 'skills/engineering/to-spec/SKILL.md', 'https://github.com/mattpocock/skills'],
  'to-tickets': ['mattpocock__skills', 'skills/engineering/to-tickets/SKILL.md', 'https://github.com/mattpocock/skills'],
  'resolving-merge-conflicts': ['mattpocock__skills', 'skills/engineering/resolving-merge-conflicts/SKILL.md', 'https://github.com/mattpocock/skills'],
  'supabase-postgres-best-practices': ['supabase__agent-skills', 'skills/supabase-postgres-best-practices/SKILL.md', 'https://github.com/supabase/agent-skills'],
  'skill-creator': ['anthropics__skills', 'skills/skill-creator/SKILL.md', 'https://github.com/anthropics/skills'],
  'brainstorming': ['obra__superpowers', 'skills/brainstorming/SKILL.md', 'https://github.com/obra/superpowers'],
  'ui-ux-pro-max': ['nextlevelbuilder__ui-ux-pro-max-skill', '.claude/skills/ui-ux-pro-max/SKILL.md', 'https://github.com/nextlevelbuilder/ui-ux-pro-max-skill'],
  'brandkit': ['leonxlnx__imagegen-skills', 'skills/brandkit/SKILL.md', 'https://github.com/Leonxlnx/imagegen-skills'],
  'impeccable': ['pbakaus__impeccable', 'plugin/skills/impeccable/SKILL.md', 'https://github.com/pbakaus/impeccable'],
  'image-to-code': ['leonxlnx__imagegen-skills', 'skills/image-to-code/SKILL.md', 'https://github.com/Leonxlnx/imagegen-skills'],
  'systematic-debugging': ['obra__superpowers', 'skills/systematic-debugging/SKILL.md', 'https://github.com/obra/superpowers'],
  'writing-plans': ['obra__superpowers', 'skills/writing-plans/SKILL.md', 'https://github.com/obra/superpowers'],
  'pptx': ['anthropics__skills', 'skills/pptx/SKILL.md', 'https://github.com/anthropics/skills'],
  'executing-plans': ['obra__superpowers', 'skills/executing-plans/SKILL.md', 'https://github.com/obra/superpowers'],
  'seo-audit': ['coreyhaines31__marketingskills', 'skills/seo-audit/SKILL.md', 'https://github.com/coreyhaines31/marketingskills'],
  'verification-before-completion': ['obra__superpowers', 'skills/verification-before-completion/SKILL.md', 'https://github.com/obra/superpowers'],
  'subagent-driven-development': ['obra__superpowers', 'skills/subagent-driven-development/SKILL.md', 'https://github.com/obra/superpowers'],
  'copywriting': ['coreyhaines31__marketingskills', 'skills/copywriting/SKILL.md', 'https://github.com/coreyhaines31/marketingskills'],
  'pdf': ['anthropics__skills', 'skills/pdf/SKILL.md', 'https://github.com/anthropics/skills'],
  'docx': ['anthropics__skills', 'skills/docx/SKILL.md', 'https://github.com/anthropics/skills'],
  'xlsx': ['anthropics__skills', 'skills/xlsx/SKILL.md', 'https://github.com/anthropics/skills'],
  'webapp-testing': ['anthropics__skills', 'skills/webapp-testing/SKILL.md', 'https://github.com/anthropics/skills'],
  'mcp-builder': ['anthropics__skills', 'skills/mcp-builder/SKILL.md', 'https://github.com/anthropics/skills'],
  'web-artifacts-builder': ['anthropics__skills', 'skills/web-artifacts-builder/SKILL.md', 'https://github.com/anthropics/skills'],
  'browser-use': ['browser-use__browser-use', 'skills/browser-use/SKILL.md', 'https://github.com/browser-use/browser-use'],
  'theme-factory': ['anthropics__skills', 'skills/theme-factory/SKILL.md', 'https://github.com/anthropics/skills'],
  'doc-coauthoring': ['anthropics__skills', 'skills/doc-coauthoring/SKILL.md', 'https://github.com/anthropics/skills'],
  'ponytail': ['dietrichgebert__ponytail', 'skills/ponytail/SKILL.md', 'https://github.com/dietrichgebert/ponytail'],
  'shadcn': ['shadcn-ui__ui', 'skills/shadcn/SKILL.md', 'https://github.com/shadcn-ui/ui']
};

const reservedFrontmatter = new Set([
  'schema', 'id', 'namespace', 'version', 'title', 'status', 'requires', 'extends',
  'recommends', 'tags', 'source', 'repository', 'upstream-repository', 'upstream-path',
  'upstream-commit'
]);

function splitMarkdown(markdown) {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  return match
    ? { frontmatter: match[1], body: normalized.slice(match[0].length) }
    : { frontmatter: '', body: normalized };
}

function keepUpstreamFrontmatter(frontmatter) {
  const lines = frontmatter.split('\n');
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (/^[A-Za-z0-9_-]+\s*:/.test(line) && current.length) {
      blocks.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length) blocks.push(current);
  return blocks
    .filter(block => {
      const key = block[0].match(/^([A-Za-z0-9_-]+)\s*:/)?.[1]?.toLowerCase();
      return key && !reservedFrontmatter.has(key);
    })
    .flat()
    .join('\n')
    .trim();
}

function dependencyBlock(skill, type, registry) {
  const dependencies = skill.deps.filter(item => item.type === type);
  if (!dependencies.length) return `${type}:\n  []`;
  const rows = dependencies.map(item => {
    const target = registry.skills.find(candidate => candidate.id === item.id);
    return `  - skill://${target?.namespace || 'local'}.${item.id}@${item.range || '*'}`;
  });
  return `${type}:\n${rows.join('\n')}`;
}

function mergedContent(skill, raw, sourcePath, repository, commit, registry) {
  const { frontmatter, body } = splitMarkdown(raw);
  const upstreamMetadata = keepUpstreamFrontmatter(frontmatter);
  const tags = [...new Set([...(skill.tags || []), 'upstream-skill'])];
  const header = [
    '---',
    'schema: skillgraph/v1',
    `id: ${skill.namespace}.${skill.id}`,
    `version: ${skill.version}`,
    `title: ${JSON.stringify(skill.title || skill.name || skill.id)}`,
    `status: ${skill.status || 'draft'}`,
    `source: https://habr.com/ru/articles/1078034/`,
    `repository: ${repository}`,
    `upstream-path: ${sourcePath}`,
    `upstream-commit: ${commit}`,
    upstreamMetadata,
    dependencyBlock(skill, 'requires', registry),
    '',
    dependencyBlock(skill, 'extends', registry),
    '',
    dependencyBlock(skill, 'recommends', registry),
    '',
    'tags:',
    ...tags.map(tag => `  - ${tag}`),
    '---',
    '',
    body.trimStart()
  ].filter((line, index, all) => line !== '' || all[index - 1] !== '');
  return `${header.join('\n').trimEnd()}\n`;
}

const registry = JSON.parse(readFileSync(resolve(registryPath), 'utf8'));
const imported = [];
for (const [id, [repoDirectory, sourcePath, repository]] of Object.entries(sources)) {
  const skill = registry.skills.find(item => item.id === id && item.namespace === 'habr');
  if (!skill) throw new Error(`SkillGraph entry not found: habr.${id}`);
  const repositoryDirectory = join(resolve(upstreamRoot), repoDirectory);
  const absoluteSource = join(repositoryDirectory, ...sourcePath.split('/'));
  const raw = readFileSync(absoluteSource, 'utf8');
  const commit = execFileSync('git', ['-C', repositoryDirectory, 'log', '-1', '--format=%H', '--', sourcePath], { encoding: 'utf8' }).trim()
    || execFileSync('git', ['-C', repositoryDirectory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  imported.push({
    ...skill,
    tags: [...new Set([...(skill.tags || []), 'upstream-skill'])],
    content: mergedContent(skill, raw, sourcePath, repository, commit, registry),
    updatedAt: new Date().toISOString()
  });
}

if (imported.length !== 50) throw new Error(`Expected 50 skills, prepared ${imported.length}`);
mkdirSync(dirname(resolve(outputPath)), { recursive: true });
writeFileSync(resolve(outputPath), JSON.stringify({
  schema: 'skillgraph/import-v1',
  source: 'https://habr.com/ru/articles/1078034/',
  generatedAt: new Date().toISOString(),
  skills: imported
}, null, 2));
console.log(`Prepared ${imported.length} upstream skills at ${resolve(outputPath)}`);
