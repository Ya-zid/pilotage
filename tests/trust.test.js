// Claude Code folder trust (server/claude-trust.js): reads and the one-key write, against a fake home and config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-trust-'));
const HOME = path.join(BASE, 'home');
fs.mkdirSync(HOME);
process.env.HOME = HOME; // never the real ~/.claude.json, even by default
delete process.env.CLAUDE_CONFIG_DIR;
process.env.PILOTAGE_DATA = path.join(BASE, 'data');
const { trustState, trustFolder, CLAUDE_CONFIG } = await import('../server/claude-trust.js');
const FILE = path.join(HOME, '.claude.json');
const opts = { file: FILE, home: HOME };
const mk = (...p) => {
  const d = path.join(HOME, ...p);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

test('trust: the default config lives in the (fake) home folder', () => {
  assert.equal(CLAUDE_CONFIG, FILE);
});

test('trust: a folder is trusted by its own record or a parent, never by the home folder', () => {
  const work = mk('work');
  const app = mk('work', 'app');
  const other = mk('other');
  fs.writeFileSync(FILE, JSON.stringify({ numStartups: 3, projects: { [work]: { hasTrustDialogAccepted: true }, [HOME]: { hasTrustDialogAccepted: true } } }, null, 2));
  assert.deepEqual(trustState(app, opts), { trusted: true, via: work, home: false });
  assert.equal(trustState(other, opts).trusted, false, 'the home record does not count');
  assert.deepEqual(trustState(HOME, opts), { trusted: false, via: null, home: true });
  fs.writeFileSync(FILE, '{ not json');
  assert.equal(trustState(app, opts).trusted, false, 'unreadable config: not trusted');
});

test('trust: writes one key, keeps everything else, keeps the file mode, backs up, and releases the lock', async () => {
  const proj = mk('proj');
  const before = { numStartups: 7, oauthAccount: { emailAddress: 'x@example.com' }, projects: { [proj]: { allowedTools: ['Bash'], hasTrustDialogAccepted: false }, '/elsewhere': { hasTrustDialogAccepted: true } } };
  fs.writeFileSync(FILE, JSON.stringify(before, null, 2), { mode: 0o600 });
  fs.chmodSync(FILE, 0o600);
  assert.deepEqual(await trustFolder(proj, opts), { changed: true });
  const after = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.deepEqual(after, { ...before, projects: { ...before.projects, [proj]: { allowedTools: ['Bash'], hasTrustDialogAccepted: true } } });
  assert.equal(fs.statSync(FILE).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${FILE}.lock`), false, 'lock released');
  assert.deepEqual(fs.readdirSync(HOME).filter((n) => n.includes('.tmp')), [], 'no temp file left');
  const backups = fs.readdirSync(path.join(BASE, 'data', 'backups', 'claude-config'));
  assert.equal(backups.length, 1);
  assert.deepEqual(await trustFolder(proj, opts), { changed: false }, 'already trusted: no write');
  assert.equal(trustState(proj, opts).trusted, true);
  // a new folder gets a minimal record
  const fresh = mk('fresh');
  await trustFolder(fresh, opts);
  assert.deepEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')).projects[fresh], { hasTrustDialogAccepted: true });
});

test('trust: refuses the home folder, a missing folder, and an unreadable config, without writing', async () => {
  const proj = mk('p2');
  fs.writeFileSync(FILE, JSON.stringify({ projects: {} }));
  await assert.rejects(trustFolder(HOME, opts), /home folder/);
  await assert.rejects(trustFolder(path.join(HOME, 'missing'), opts), /not found/);
  fs.writeFileSync(FILE, '{ broken');
  await assert.rejects(trustFolder(proj, opts), /Can't read/);
  assert.equal(fs.readFileSync(FILE, 'utf8'), '{ broken', 'left as it was');
  fs.writeFileSync(FILE, '[1,2]');
  await assert.rejects(trustFolder(proj, opts), /unexpected format/);
});

test('trust: waits for the lock Claude Code holds, and gives up without writing if it is never released', async () => {
  const proj = mk('p3');
  fs.writeFileSync(FILE, JSON.stringify({ projects: {} }));
  fs.mkdirSync(`${FILE}.lock`);
  setTimeout(() => fs.rmdirSync(`${FILE}.lock`), 300);
  assert.deepEqual(await trustFolder(proj, opts), { changed: true }, 'went through once the lock was free');
  // symlinked config: written through the link, the link stays
  const real = path.join(BASE, 'real-claude.json');
  fs.writeFileSync(real, JSON.stringify({ projects: {} }));
  const link = path.join(HOME, 'linked.json');
  fs.symlinkSync(real, link);
  await trustFolder(proj, { file: link, home: HOME });
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(JSON.parse(fs.readFileSync(real, 'utf8')).projects[proj].hasTrustDialogAccepted, true);
});

test.after(() => fs.rmSync(BASE, { recursive: true, force: true }));
