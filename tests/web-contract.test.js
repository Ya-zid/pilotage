// The web app has no test runner yet: these read web/src as text and check contracts that protect users.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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
