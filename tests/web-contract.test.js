// The web app has no test runner yet: these read web/src as text and check contracts that protect users.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const src = (f) => fs.readFileSync(path.join(ROOT, 'web', 'src', f), 'utf8');

test('a logged-out or broken AI provider is named on Home and in Settings, never blamed on usage', () => {
  const bits = src('components/today/TodayBits.tsx');
  assert.doesNotMatch(bits, /usage to drop/, 'Home must not say "waiting for usage to drop" whatever the reason');
  // The server's guard reason for a setup error (server/ai/engine.js pause()) is what the web app recognises.
  assert.match(fs.readFileSync(path.join(ROOT, 'server', 'ai', 'engine.js'), 'utf8'), /pauseReason = setup \? `AI provider problem: \$\{/);
  assert.match(src('util.ts'), /if \(r\.startsWith\('AI provider problem'\)\) return 'provider';/);
  assert.match(bits, /const hold = aiHold\(ai\.guard\.reason\);/, 'Home reads the guard reason');
  assert.match(bits, /hold === 'provider' \?[\s\S]{0,200}\{ai\.guard\.reason\}[\s\S]{0,120}<Link to="\/settings#ai"/, 'a provider problem shows the reason and links to Settings → AI');
  const ai = src('components/settings/AISection.tsx');
  assert.doesNotMatch(ai, /title: 'Waiting for room in your usage',/, 'the Settings title is not the usage one for every reason');
  assert.match(ai, /title: HOLD_TITLE\[hold\]/, 'the Settings title follows the reason');
  assert.match(ai, /provider: 'AI provider problem'/);
});

test('New session: "Trust this folder" is never pre-ticked, and skipping permission prompts is said out loud', () => {
  const ns = src('components/NewSession.tsx');
  assert.match(ns, /\[trustTick, setTrustTick\] = useState\(false\)/, 'trust must start unticked on every device');
  assert.match(ns, /perm === 'bypassPermissions' && <SkipPromptsNote \/>/, 'the skip-prompts warning sits outside the folded options');
  assert.match(src('components/tasks/TaskBits.tsx'), /permissionMode === 'bypassPermissions' && <SkipPromptsNote \/>/, 'task Start shows it too');
});

test('launch progress never spins forever: New session and task Start use LaunchStatus, which gives up and links the session', () => {
  for (const f of ['components/NewSession.tsx', 'components/tasks/TaskBits.tsx']) {
    const s = src(f);
    assert.doesNotMatch(s, /function LaunchProgress\(/, `${f} keeps its own launch progress (no time-out, no session link before the phone link)`);
    assert.match(s, /<LaunchStatus launch=\{launch\} onNavigate=\{\w+\} \/>/, `${f} shows LaunchStatus`);
  }
  const ls = src('components/project/LaunchStatus.tsx');
  assert.match(ls, /\{!ready && viewLink\}/, '"View in Pilotage" as soon as the session id is known');
  assert.match(ls, /: timedOut \? <Hourglass /, 'after the time-out the icon stops spinning');
  assert.match(ls, /window\.setTimeout\(\(\) => bump\(/, 're-render at the give-up moment even when the polled record stopped changing');
  assert.doesNotMatch(ls, /d\.state === 'launched' && d\.note/, "Claude's no-terminal fallback (launched + a note) keeps polling for its phone link");
});

test('every permission mode Settings offers has a label in the New session dialog', () => {
  const opts = [...src('components/settings/General.tsx').matchAll(/\{ value: '(\w+)', label: '[^']+', hint: '[^']*(?:prompt|ask|edit|plan|Claude)[^']*' \}/gi)].map((m) => m[1]);
  assert.ok(opts.length >= 4, `found the Settings options (${opts})`);
  const labels = /const PERM_LABEL: Record<string, string> = \{([^}]+)\}/.exec(src('components/NewSession.tsx'))[1];
  for (const v of opts) assert.match(labels, new RegExp(`\\b${v}:`), `no label for "${v}" (the dialog would show the raw value)`);
});

test('Home: a brand-new user with no sessions gets one welcome with New session and the Guide, not a page of zeros', () => {
  const today = src('pages/Today.tsx');
  assert.match(today, /const fresh = o\.counts\.sessions === 0 && o\.index\.firstDone && !o\.live\.length;/, 'the welcome waits for the first index and needs no session at all');
  assert.match(today, /fresh \? <Welcome phone=\{phone\} \/> : <PulseTiles /, 'the welcome takes the place of the zero tiles');
  assert.match(today, /\(!fresh \|\| tasks > 0\) && <TodayPlan /, '"Nothing planned" is not the only next step');
  const home = src('components/today/HomeSections.tsx');
  const welcome = /export function Welcome\([\s\S]*?\n\}\n/.exec(home)?.[0] || '';
  assert.match(welcome, /<EmptyState[\s\S]*title=\{`No Claude Code sessions on \$\{phone \? 'your computer' : 'this computer'\} yet`\}/, 'one EmptyState says why the page is empty');
  assert.match(welcome, /onClick=\{\(\) => openNewSession\(\{\}\)\}[^>]*>\s*New session\s*<\/Button>/, 'its button opens the New session dialog');
  assert.match(welcome, /<Link to="\/guide"/, 'it points to the Guide');
});

test('live updates: coding-tool changes and growing turns reach every open device', () => {
  const api = src('api.ts');
  const map = /const KIND_TO_KEYS: Record<string, string\[\]> = \{([\s\S]*?)\n\};/.exec(api)[1];
  const keys = (kind) => (new RegExp(`\\b${kind}: \\[([^\\]]*)\\]`).exec(map)?.[1] || '').split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.ok(keys('settings').includes('harnesses'), 'settings → harnesses (New session agent list, Sessions filter)');
  assert.ok(keys('sessions').includes('turn'), 'sessions → turn (an open tool-call list on a live turn)');
  const prov = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'providers.js'), 'utf8');
  const patch = prov.slice(prov.indexOf("route('PATCH', '/api/harnesses'"), prov.indexOf("route('PATCH', '/api/harnesses'") + 2500);
  assert.match(patch, /broadcast\('settings'\)/, 'PATCH /api/harnesses tells open devices');
});

test('Home does not poll the network status (each /api/net runs Windows tools on WSL), and its advice fits the platform', () => {
  const home = src('components/today/HomeSections.tsx');
  const setup = /export function PhoneSetup\(\)[\s\S]*?\n\}\n/.exec(home)[0];
  assert.doesNotMatch(setup, /useNet|useDevices/, 'nothing is fetched once the callout is dismissed');
  assert.match(home, /useNetOnce\(\)/);
  assert.doesNotMatch(/export const useNetOnce = [^\n]*/.exec(src('api.ts'))[0], /refetchInterval/);
  assert.match(home, /net\.mode === 'off'/, 'Linux/macOS without PILOTAGE_LAN_BIND get the right advice');
});

test('"Needs you" signals: the tab title counts waiting sessions; opt-in notifications only for new ones, in the background', () => {
  const ny = src('needsYou.ts');
  assert.match(ny, /document\.title = waiting\.length \? `\(\$\{waiting\.length\}\) \$\{base\.current\}` : base\.current;/);
  assert.match(ny, /if \(!before \|\| !document\.hidden \|\| !notifyEnabled\(\)\) return;/, 'never on the first load, never for a visible tab, only when opted in');
  assert.match(ny, /if \(before\.has\(s\.id\)\) continue;/, 'one notification per session that starts waiting');
  assert.match(src('main.tsx'), /useNeedsYouSignals\(\);/);
  assert.match(src('components/settings/General.tsx'), /<NotifyCard \/>/);
});

test('Home warns when running sessions edit the same files, and sessions offer "Continue fresh" with a recap', () => {
  assert.match(src('pages/Today.tsx'), /<Collisions items=\{o\.attention\.filter\(\(a\) => a\.kind === 'collision'\)\} \/>/);
  assert.match(src('components/today/HomeSections.tsx'), /export function Collisions\(/);
  const actions = src('components/session/SessionActions.tsx');
  assert.match(actions, /key: 'fresh'/);
  assert.match(actions, /\/api\/sessions\/\$\{encodeURIComponent\(s\.id\)\}\/recap/);
  // The recap is mostly AI-written (digests, next step): the session it seeds asks before acting.
  assert.match(actions, /openNewSession\(\{ projectId: r\.projectId \|\| s\.projectId \|\| undefined, prompt: r\.prompt, aiPrompt: true \}\)/);
});

test('AI-seeded sessions: Home focus and a new project\'s first session say aiPrompt; dialogs say they ask before acting', () => {
  assert.match(src('components/today/HomeSections.tsx'), /openNewSession\(\{ projectId: p\.projectId \|\| undefined, prompt: p\.action, name: sessionName\(p\.title\), aiPrompt: true \}\)/, 'focus "Start" marks its prompt as AI-written');
  assert.match(src('components/ideas/NewProjectDialog.tsx'), /title: 'First session', aiPrompt: true \}/, 'a new project\'s first session reads an AI-made CLAUDE.md');
  const ns = src('components/NewSession.tsx');
  assert.match(ns, /ideaId: pre\?\.ideaId, aiPrompt: aiPrompt \|\| undefined \}/, 'New session passes the flag to /api/launch');
  assert.match(ns, /\{aiPrompt && claudeOnly && <AiPromptNote \/>\}/, 'and says so');
  assert.match(ns, /const perm = aiPrompt && settingsPerm \?/, 'the Options line shows the mode that will really be used');
  assert.match(src('components/tasks/TaskBits.tsx'), /\{it\.ai \? <AiPromptNote \/> : /, 'task Start of a suggested task says it asks first');
  assert.match(src('components/project/CreateFlow.tsx'), /hint=\{launch !== 'none' \? 'It asks before acting, whatever Settings says/, 'spin-off / new project: the kickoff asks first');
  // …which is what the server does.
  const server = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  assert.match(server, /permissionMode: body\.aiPrompt === true \? askFirstMode\(/);
});

test('the Map: a page in the sidebar, More and the palette, "See on the map" from a project, live refresh', () => {
  assert.match(src('main.tsx'), /const MapPage = lazy\(\(\) => import\('\.\/pages\/Map'\)\);/);
  assert.match(src('main.tsx'), /<Route path="map" element=\{<Suspense fallback=\{<LoadingCard \/>\}><MapPage \/><\/Suspense>\} \/>/);
  const layout = src('components/Layout.tsx');
  assert.match(layout, /sub\('\/map', <Network size=\{15\} \/>, 'Map'\)/, 'sidebar');
  assert.match(layout, /const moreActive = \[[^\]]*'\/map'/, 'the More tab lights up on the Map');
  assert.match(src('pages/More.tsx'), /\{ to: '\/map', icon: <Network \/>, label: 'Map' \}/, 'More menu on the phone');
  assert.match(src('components/CommandPalette.tsx'), /key: 'map'[^\n]*go\('\/map'\)/);
  assert.match(src('components/project/ProjectHeader.tsx'), /label: 'See on the map'[^\n]*navigate\(`\/map\?project=\$\{p\.id\}`\)/);
  const map = /const KIND_TO_KEYS: Record<string, string\[\]> = \{([\s\S]*?)\n\};/.exec(src('api.ts'))[1];
  for (const kind of ['sessions', 'projects', 'ai-data', 'ideas', 'work', 'scout']) assert.match(map, new RegExp(`\\b'?${kind}'?: \\[[^\\]]*'graph'`), `${kind} → graph`);
  assert.match(src('api-extra.ts'), /queryKey: \['graph', days, project \|\| 'all'\]/);
});

test('the Map: pan and zoom by wheel, pinch and drag; keyboard; panel with the fitting action; tokens only', () => {
  const canvas = src('components/map/MapCanvas.tsx');
  assert.match(canvas, /addEventListener\('wheel', onWheel, \{ passive: false \}\)/, 'wheel zoom keeps the page still');
  assert.match(canvas, /if \(pts\.length >= 2 && g\.dist\)/, 'pinch with two pointers');
  assert.match(canvas, /setPointerCapture\(e\.pointerId\)/, 'drag keeps going outside the map');
  assert.match(canvas, /prefers-reduced-motion: reduce/, 'no animated centering with reduced motion');
  const page = src('pages/Map.tsx');
  assert.match(page, /if \(e\.key === 'Enter'\) \{\s*e\.preventDefault\(\);\s*nextHit\(\);/, 'Enter in the search walks the hits');
  assert.match(page, /canvas\.current\?\.centerOn\(matchList\[0\]\.id\)/, 'typing centres the best hit');
  assert.match(page, /className="mp-canvas" tabIndex=\{0\} onKeyDown=\{onStageKey\}/, 'the map itself takes the keyboard');
  assert.match(page, /<EmptyState\s+icon=\{<Network \/>\}/, 'an empty state for a new user');
  assert.match(page, /setFocus\(\(f\) => \(f === selected \? null : selected\)\)/, 'focus mode');
  assert.match(page, /leftOut\(data\.truncated\.left\)/, 'what the server left out is said');
  const panel = src('components/map/MapPanel.tsx');
  assert.match(panel, /if \(e\.key !== 'Escape' \|\| document\.querySelector\('\.overlay'\)\) return;/, 'Esc closes the panel, not a dialog above it');
  assert.match(panel, /href=\{n\.href\} target="_blank" rel="noreferrer noopener"/, 'claude.ai opens in a new tab without a referrer');
  assert.match(panel, /openNewSession\(\{ resumeId: sessionId, projectId: n\.projectId \}\)/, 'Resume');
  assert.match(panel, /openNewSession\(\{ projectId: n\.projectId \}\)/, 'New session in that project');
  const css = fs.readFileSync(path.join(ROOT, 'web', 'src', 'pages', 'Map.css'), 'utf8');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'no raw colours');
  assert.doesNotMatch(css, /prefers-color-scheme/, 'themes come from the tokens');
  assert.match(css, /\.mp-svg \{[^}]*touch-action: none;/, 'pinch is the map’s, not the browser’s');
  // Seen in a phone screenshot: the fitted map had no label at all, and the project picker read "All projec".
  assert.match(canvas, /\(k >= 0\.55 \|\| landmarks <= 24\)/, 'projects and workspaces are named at the phone\'s fit zoom');
  assert.match(css, /\.mp-select \{[^}]*flex: 1 1 160px;/, 'the picker keeps room for a project name on the phone');
  // the web types name the same node types the server sends
  const server = fs.readFileSync(path.join(ROOT, 'server', 'graph.js'), 'utf8');
  const sent = new Set([...server.matchAll(/type: '(\w+)'/g)].map((m) => m[1]));
  const known = /export type GraphNodeType = ([^;]+);/.exec(src('types-map.ts'))[1];
  for (const t of sent) assert.match(known, new RegExp(`'${t}'`), `web type for ${t}`);
});

test('the Map layout: deterministic, finite, no overlaps, quick for 400 nodes, and a refresh starts where it was', (t) => {
  const probe = spawnSync(process.execPath, ['--experimental-strip-types', '-e', '1'], { encoding: 'utf8' });
  if (probe.status !== 0) return t.skip('this Node cannot strip TypeScript types');
  const script = `
    import { layoutGraph, radius } from ${JSON.stringify(path.join(ROOT, 'web', 'src', 'components', 'map', 'layout.ts'))};
    const nodes = [], links = [];
    for (let w = 0; w < 5; w++) nodes.push({ id: 'ws:' + w, type: 'workspace', weight: 8 });
    for (let p = 0; p < 40; p++) { nodes.push({ id: 'p:' + p, type: 'project', weight: 1 + (p % 9) }); links.push({ source: 'ws:' + (p % 5), target: 'p:' + p, kind: 'workspace' }); }
    for (let s = 0; s < 300; s++) { nodes.push({ id: 's:' + s, type: 'session', weight: 1 + (s % 5) }); links.push({ source: 'p:' + (s % 40), target: 's:' + s, kind: 'session' }); }
    for (let k = 0; k < 55; k++) { nodes.push({ id: 'topic:' + k, type: 'topic', weight: 3 }); for (let j = 0; j < 4; j++) links.push({ source: 's:' + ((k * 7 + j * 13) % 300), target: 'topic:' + k, kind: 'topic' }); }
    const t0 = performance.now();
    const a = layoutGraph(nodes, links);
    const ms = performance.now() - t0;
    const b = layoutGraph(nodes, links);
    let same = true, finite = true, overlaps = 0;
    for (const n of nodes) { const p = a.get(n.id), q = b.get(n.id); if (p.x !== q.x || p.y !== q.y) same = false; if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) finite = false; }
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) { const p = a.get(nodes[i].id), q = a.get(nodes[j].id); if (Math.hypot(p.x - q.x, p.y - q.y) < radius(nodes[i]) + radius(nodes[j])) overlaps++; }
    // one new session on a refresh: everything else barely moves
    const more = [...nodes, { id: 's:new', type: 'session', weight: 1 }];
    const c = layoutGraph(more, [...links, { source: 'p:0', target: 's:new', kind: 'session' }], a);
    let drift = 0; for (const n of nodes) drift = Math.max(drift, Math.hypot(c.get(n.id).x - a.get(n.id).x, c.get(n.id).y - a.get(n.id).y));
    const near = Math.hypot(c.get('s:new').x - c.get('p:0').x, c.get('s:new').y - c.get('p:0').y);
    console.log(JSON.stringify({ ms, same, finite, overlaps, drift, near }));
  `;
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.same, true, 'the same graph gives the same map');
  assert.equal(out.finite, true);
  assert.equal(out.overlaps, 0, 'nodes never sit on each other');
  assert.ok(out.ms < 1500, `400 nodes laid out in ${Math.round(out.ms)} ms`);
  assert.ok(out.drift < 60, `a refresh moves known nodes at most a little (${Math.round(out.drift)})`);
  assert.ok(out.near < 120, `a new node lands next to the node it hangs off (${Math.round(out.near)})`);
});

test('the Map labels never pile up: one that would overlap a placed label is left out, the selected one always shows', (t) => {
  const probe = spawnSync(process.execPath, ['--experimental-strip-types', '-e', '1'], { encoding: 'utf8' });
  if (probe.status !== 0) return t.skip('this Node cannot strip TypeScript types');
  const script = `
    import { placeLabels } from ${JSON.stringify(path.join(ROOT, 'web', 'src', 'components', 'map', 'layout.ts'))};
    // a zoomed-in cluster: twelve neighbours a few pixels apart, with long names (seen on the demo world)
    const items = [{ id: 'sel', x: 0, y: 0, r: 8, label: 'invoicely' }];
    for (let i = 0; i < 12; i++) items.push({ id: 'n' + i, x: (i % 3) * 12, y: Math.floor(i / 3) * 6, r: 4, label: 'Stripe payment links on invoices ' + i });
    items.push({ id: 'far', x: 900, y: 900, r: 4, label: 'Far away' });
    const placed = placeLabels(items, 12);
    const fs = 12, boxes = placed.map((l) => { const w = l.text.length * fs * 0.56 + fs * 0.4; return { x0: l.x - w / 2, x1: l.x + w / 2, y0: l.y - fs * 1.05, y1: l.y + fs * 0.3 }; });
    let overlaps = 0;
    for (let i = 2; i < boxes.length; i++) for (let j = 0; j < i; j++) { const a = boxes[i], b = boxes[j]; if (a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0) overlaps++; }
    console.log(JSON.stringify({ ids: placed.map((l) => l.id), overlaps }));
  `;
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.ids[0], 'sel', 'the selected node is named first');
  assert.ok(out.ids.includes('far'), 'a label with room is kept');
  assert.ok(out.ids.length < 8, `the pile is thinned (${out.ids.length} of 14 kept)`);
  assert.equal(out.overlaps, 0, 'no label overlaps one placed before it');
  assert.match(src('components/map/MapCanvas.tsx'), /\{placeLabels\(items, fs\)\.map\(/, 'the canvas draws through placeLabels');
});

test('claude.ai chats: imported from Settings → Sources on the PC, read-only in Sessions, search and the palette', () => {
  const sources = src('components/settings/Sources.tsx');
  const card = /function ClaudeAiCard\(\)[\s\S]*?\n\}\n/.exec(sources)?.[0] || '';
  assert.match(sources, /<ClaudeAiCard \/>/);
  assert.match(card, /actions=\{viaLan \? <PcOnly text="Import on the PC" \/> : null\}/, 'PC only, said on the phone');
  assert.match(card, /<fieldset className="stack-lg bare-fieldset" disabled=\{viaLan\}>/);
  assert.match(card, /await chatsImport\(path\.trim\(\)\)/);
  assert.match(card, /window\.confirm\('Forget the imported claude\.ai chats\?/, 'removing asks first');
  const rows = src('components/session/ChatRows.tsx');
  assert.match(rows, /href=\{c\.url\} target="_blank" rel="noreferrer noopener"/, 'opens in claude.ai, no referrer');
  assert.doesNotMatch(rows, /resume|openNewSession/i, 'a chat cannot be resumed here');
  const sessions = src('pages/Sessions.tsx');
  assert.match(sessions, /\['claude', 'codex', 'gemini', 'claude-ai'\]\.includes\(params\.get\('harness'\)/);
  assert.match(sessions, /\{\(chatCount > 0 \|\| chatsOnly\) && <option value="claude-ai">claude\.ai<\/option>\}/);
  assert.match(sessions, /chatsOnly \? \(\s*<ChatsView q=\{qd\} project=\{project\} \/>/);
  assert.match(sessions, /<Section title="claude\.ai chats" count=\{deepChats\.length\}>/, 'search finds chats too');
  assert.match(src('components/CommandPalette.tsx'), /group: 'claude\.ai chats'[^\n]*window\.open\(c\.url, '_blank', 'noopener,noreferrer'\)/);
  const map = /const KIND_TO_KEYS: Record<string, string\[\]> = \{([\s\S]*?)\n\};/.exec(src('api.ts'))[1];
  assert.match(map, /chats: \['chats', 'graph', 'search'\]/);
  const route = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'chats.js'), 'utf8');
  assert.match(route, /'\/api\/chats\/import',[\s\S]*?\{ localOnly: true \}/, 'the import route is PC-only on the server too');
});

test('"Make it a project" keeps its success screen when the last possible project is accepted', () => {
  const sc = src('components/ideas/ScoutCards.tsx');
  const body = sc.slice(sc.indexOf('export function ScoutCards('));
  assert.equal((body.match(/\{dialog\}/g) || []).length, 1, 'the dialog is rendered at one place only');
  assert.match(body, /const keep = \(body: ReactNode\) => \(\s*<>\s*\{body\}\s*\{dialog\}\s*<\/>\s*\);/, 'one wrapper puts it after whatever the list shows');
  const returns = body.match(/\breturn\b[^\n]*/g) || [];
  assert.ok(returns.length >= 4, `found the returns (${returns.length})`);
  for (const r of returns) assert.match(r, /^return keep\(/, `every branch keeps the dialog in place: ${r}`);
  const ov = src('components/project/OverviewTab.tsx');
  const pp = /function PossibleProjects\([\s\S]*?\n\}\n/.exec(ov)[0];
  assert.match(pp, /if \(!n && !making\) return null;/, 'the project Overview keeps the list mounted while the dialog is open');
  assert.match(pp, /<ScoutCards [^>]*onDialog=\{setMaking\}/);
});

test('New project, Spin off and task Start offer "Trust this folder" (unticked) and send it, so phone launches do not wait at the PC', () => {
  const flow = src('components/project/CreateFlow.tsx');
  const opts = /export function CreateOptions\([\s\S]*?\n\}\n/.exec(flow)[0];
  assert.match(opts, /const askTrust = launch !== 'none' && !settings\?\.settings\.launch\.trustFolders;/, 'asked only when a session starts and trust is not automatic');
  assert.match(opts, /\{askTrust && <TrustFolderCheck checked=\{trust\} onChange=\{setTrust\}/);
  for (const f of ['components/project/NewProjectDialog.tsx', 'components/project/SpinoffDialog.tsx']) {
    const s = src(f);
    assert.match(s, /const \[trust, setTrust\] = useState\(false\);/, `${f}: never pre-ticked`);
    assert.match(s, /trust: launch !== 'none' && trust,/, `${f}: sent with Create`);
    assert.match(s, /<CreateOptions [^>]*trust=\{trust\} setTrust=\{setTrust\}/, `${f}: shown`);
  }
  const task = src('components/tasks/TaskBits.tsx');
  assert.match(task, /const \[trustTick, setTrustTick\] = useState\(false\);/, 'task Start: never pre-ticked');
  assert.match(task, /\{askTrust && <TrustFolderCheck checked=\{trustTick\} onChange=\{setTrustTick\} \/>\}/);
  assert.match(task, /await start\(it\.id, mode, resume, askTrust && trustTick\)/);
  assert.match(src('components/tasks/model.ts'), /`\/api\/work\/\$\{id\}\/start`, \{ method: 'POST', body: \{ mode, resume, trust \} \}/);
  const work = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'work.js'), 'utf8');
  const startRoute = work.slice(work.indexOf("'/api/work/([\\\\w-]{4,40})/start'"), work.indexOf('await launch({', work.indexOf("'/api/work/([\\\\w-]{4,40})/start'")));
  assert.match(startRoute, /await ctx\.trustBeforeLaunch\?\.\(cwd, body\.trust === true,/, 'the task Start route answers it before launching');
  assert.match(work, /await ctx\.trustBeforeLaunch\?\.\(made\.dir, body\.trust === true, 'new project'\);/, 'new folders: the same step');
  assert.doesNotMatch(work, /trustFolder\(/, 'one trust step, no copy of it in the routes');
  // That step is claude-trust.js's helper, bound to the settings and the log once (server/index.js → ctx).
  const index = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  assert.match(index, /const trustBeforeLaunch = \(cwd, asked, why\) => trustForLaunch\(cwd, \{ asked, auto: !!store\.settings\.launch\.trustFolders, why, log, show: tildePath \}\);/);
  assert.match(index, /\n  trustBeforeLaunch, \/\/ the Settings → Trust folders step/);
});

test('dialogs manage focus: it moves in on open, Tab stays inside, it goes back on close, the title names the dialog', () => {
  const ui = src('components/ui.tsx');
  const modal = /export function Modal\([\s\S]*?\n\}\n/.exec(ui)[0];
  assert.match(modal, /role="dialog" aria-modal="true" aria-labelledby=\{title !== undefined \? titleId : undefined\} tabIndex=\{-1\}/, 'named by its title, focusable itself');
  assert.match(modal, /<h2 id=\{titleId\}>\{title\}<\/h2>/);
  assert.match(modal, /const \[opener\] = useState\(\(\) => \(typeof document !== 'undefined' \? \(document\.activeElement/, 'the opener is read before a child autoFocus moves focus');
  assert.match(modal, /if \(box && !box\.contains\(document\.activeElement\)\) \{[\s\S]{0,200}\(first \|\| box\)\.focus\(/, 'focus moves into the dialog on open (a child autoFocus wins)');
  assert.match(modal, /phoneSheets\(\) \? null : focusables\(box\)/, 'on a phone the sheet itself takes focus (no keyboard pop-up)');
  assert.match(modal, /e\.key === 'Tab' && top\(\)[\s\S]{0,500}els\[els\.length - 1\]\.focus\(\)[\s\S]{0,200}els\[0\]\.focus\(\)/, 'Tab and Shift+Tab cycle inside the top dialog');
  assert.match(modal, /opener\.isConnected[\s\S]{0,120}opener\.focus\(/, 'focus goes back to the opener on close');
});

test('on the phone, dev-server ports are text, not links to the phone\'s own localhost', () => {
  const wt = src('components/project/WorktreesTab.tsx');
  const dev = /export function DevPort\([\s\S]*?\n\}\n/.exec(wt)?.[0] || '';
  assert.match(dev, /if \(boot\?\.device\.viaLan\) \{\s*return \(\s*<span /, 'phone: plain text');
  assert.match(dev, /href=\{`http:\/\/localhost:\$\{port\}`\}/, 'PC: still a link');
  for (const f of ['components/project/OverviewTab.tsx', 'components/project/WorktreesTab.tsx']) {
    const s = src(f).replace(dev, '');
    assert.doesNotMatch(s, /href=\{`http:\/\/localhost/, `${f} links localhost outside DevPort`);
  }
  assert.match(src('components/project/OverviewTab.tsx'), /<DevPort key=\{port\} port=\{port\} label=\{`localhost:\$\{port\}`\} \/>/);
});

test('Markdown never renders <img> (CSP-blocked and relative README images were broken icons): the alt text, linked when it has a web address', () => {
  const ui = src('components/ui.tsx');
  const md = /export function Markdown\([\s\S]*?\n\}\n/.exec(ui)[0];
  assert.match(md, /img: \(\{ src, alt \}\) => <MarkdownImage src=\{src\} alt=\{alt\} \/>/, 'images go through MarkdownImage');
  const img = /function MarkdownImage\([\s\S]*?\n\}\n/.exec(ui)?.[0] || '';
  assert.doesNotMatch(img, /<img\b/, 'no <img>');
  assert.match(img, /\{alt \|\| 'image'\}/, 'the alt text is shown');
  assert.match(img, /if \(!inLink && src && \/\^https\?:/, 'a web address becomes a link, never inside another link (badges)');
  assert.match(md, /<InMarkdownLink\.Provider value=\{true\}>\{children\}<\/InMarkdownLink\.Provider>/);
  assert.match(src('components/project/DocsTab.tsx'), /<Markdown text=\{data\.content\}/, 'project docs use this Markdown');
});

test('About shows the real data folder and the one write to Claude\'s files; "Start a project" never creates a path it has not shown', () => {
  const about = /export function AboutSection\(\)[\s\S]*?\n\}\n/.exec(src('components/settings/General.tsx'))[0];
  assert.doesNotMatch(about, /~\/pilotage\/data/, 'no hard-coded data folder');
  assert.match(about, /\{boot\?\.dataDir \|\| '…'\}/);
  assert.match(about, /"Trust this folder"[^<]*~\/\.claude\.json/, 'the trust write is said');
  assert.match(fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8'), /dataDir: tildePath\(DATA\),/);
  const np = src('components/ideas/NewProjectDialog.tsx');
  assert.match(np, /const ready = preview\.state === 'ok' && preview\.key === planKey;/, 'ready only for the dry run of what is typed now');
  assert.match(np, /if \(r\.ok\) setPreview\(\{ state: 'ok', d: r\.data, key \}\);/);
  assert.match(np, /if \(!ready \|\| creating\) return;/, 'Enter waits too');
  assert.match(np, /disabled=\{!ready\} onClick=\{create\}/, 'Create waits for the current path');
});

test('Settings → AI: the automatic summary window can be changed, and Run now says which window it covers', () => {
  const ai = src('components/settings/AISection.tsx');
  assert.match(ai, /onCommit=\{\(v\) => setAi\(\{ backfillDays: v \}/);
  assert.match(ai, /Summarize pending work from the last \$\{s\.ai\.backfillDays \?\? 30\} days now/);
  assert.match(fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8'), /clean\.ai\.backfillDays = Math\.max\(1, Math\.min\(3650,/);
});
