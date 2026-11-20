import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const host = readFileSync(new URL('../desktop-native/MainForm.cs', import.meta.url), 'utf8');

const checks = [
  ['native window can shrink to snap-compatible dimensions', /MinimumSize\s*=\s*new Size\(360,\s*320\)/.test(host)],
  ['Windows 11 recognizes the custom maximize button', /HtMaxButton\s*=\s*9/.test(host) && /message\.Result\s*=\s*\(IntPtr\)HtMaxButton/.test(host)],
  ['native maximize and Windows snap use WM_GETMINMAXINFO working area bounds', /WmGetMinMaxInfo\s*=\s*0x0024/.test(host) && /ApplyWorkingAreaMaximizeBounds/.test(host) && /MonitorFromWindow/.test(host) && /GetMonitorInfo/.test(host) && /WorkArea\.Bottom\s*-\s*monitorInfo\.WorkArea\.Top/.test(host)],
  ['maximized client area compensates the invisible resize frame', /SmCxSizeFrame\s*=\s*32/.test(host) && /SmCySizeFrame\s*=\s*33/.test(host) && /SmCxPaddedBorder\s*=\s*92/.test(host) && /GetSystemMetricsForDpi/.test(host) && /MaxPosition\.X[^;]+- frameX/.test(host) && /MaxSize\.Y[^;]+\+ frameY \* 2/.test(host)],
  ['native window keeps resize and caption capabilities', /WsThickFrame[\s\S]*WsMaximizeBox[\s\S]*WsSystemMenu/.test(host) && /parameters\.Style\s*\|=/.test(host)],
  ['native Windows border uses the SkillGraph purple', /DwmwaBorderColor\s*=\s*34/.test(host) && /SkillGraphBorderColor\s*=\s*0x00DF788B/.test(host) && /DwmSetWindowAttribute/.test(host)],
  ['main workspace has no fixed central minimum', /grid-template-columns:\s*46px var\(--explorer-column-width\) minmax\(0,1fr\) var\(--inspector-column-width\)/.test(css)],
  ['side panes are bounded by the live window width', /--explorer-column-width:clamp\([^;]+24vw/.test(css) && /--inspector-column-width:clamp\([^;]+28vw/.test(css)],
  ['mobile layout removes fixed side columns', /@media \(max-width:760px\)[\s\S]*?grid-template-columns:46px minmax\(0,1fr\)/.test(css)],
  ['mobile navigator has an explicit toggle', /id="explorerToggle"/.test(html)],
  ['mobile navigator slides underneath the visible icon ribbon', /@media \(max-width:760px\)[\s\S]*?\.ribbon \{ position:relative; z-index:42;[\s\S]*?\.explorer \{[\s\S]*?padding-left:46px;[\s\S]*?transform:translateX\(-100%\)/.test(css)],
  ['closed mobile navigator cannot leak clipped content', /transform:translateX\(-100%\);[\s\S]*?visibility:hidden;[\s\S]*?pointer-events:none/.test(css)],
  ['navigator animates back into its dock after expanding', /navigator-docking/.test(app) && /@keyframes navigator-dock-in/.test(css)],
  ['mobile navigator state is keyboard-dismissible', /Escape[^\n]+mobile-explorer/.test(app)],
  ['agent workspace collapses to one column', /@media \(max-width:760px\)[\s\S]*?\.agents-layout \{ grid-template-columns:1fr;/.test(css)],
  ['execution releases the agent sidebar at medium width', /@media \(max-width:1200px\)[\s\S]*?\.agents-layout:has\(\.agent-execution\)[\s\S]*?grid-template-columns:minmax\(0,1fr\)[\s\S]*?\.agent-list \{ display:none;/.test(css)],
  ['execution graph and details stack before becoming cramped', /@media \(max-width:1050px\)[\s\S]*?\.run-workspace[\s\S]*?grid-template-columns:minmax\(0,1fr\)/.test(css)],
  ['execution controls have a responsive group', /class="run-summary-controls"/.test(app) && /grid-template-areas:[\s\S]*?"status copy progress controls"/.test(css)],
  ['horizontal menus retain the user scroll position', /workspaceTabsScrollLeft/.test(app) && /agentModeTabsScrollLeft/.test(app)],
  ['swimlane viewport is restored and auto-advances by task state', /runViewportById/.test(app) && /nextRunTaskAfterCompletion/.test(app)],
  ['zoom buttons are accessible and use the shared control palette', /aria-label="Уменьшить масштаб"/.test(app) && /aria-label="Увеличить масштаб"/.test(app) && /\.zoom-controls,\s*\n\.run-zoom/.test(css)],
  ['graph and execution zoom percentages use the same compact type size', /\.zoom-controls #zoomLabel \{[\s\S]*?font-size:9px/.test(css) && /\.run-zoom span \{[\s\S]*?font-size:9px!important/.test(css)],
  ['compact execution uses one vertical document flow', /@media \(max-width:1050px\)[\s\S]*?\.agent-content:has\(\.agent-execution\) \{ overflow-x:hidden; overflow-y:auto; \}[\s\S]*?\.run-workspace \{[\s\S]*?display:flex;[\s\S]*?overflow:visible/.test(css)],
  ['shared control tokens exist for both themes', /--control-bg:/.test(css) && /--control-border:/.test(css) && /--focus-ring:/.test(css)],
  ['toolbars permit bounded horizontal overflow', /\.toolbar-actions \{[\s\S]*?overflow-x:auto/.test(css)],
  ['short-height layout is supported', /@media \(max-height:620px\)/.test(css)],
];

const failed = checks.filter(([, passed]) => !passed);
for (const [label, passed] of checks) console.log(`${passed ? 'PASS' : 'FAIL'} ${label}`);
if (failed.length) process.exit(1);
