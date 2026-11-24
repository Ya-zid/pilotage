// Repos found on disk are untrusted (an unpacked archive can ship its own .git/config). Pilotage's background git
// calls must never run a command a repo's own config names. Each attack below leaves a marker file if it runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-gitsafe-'));
// Own HOME and no system config, so the user's real git config plays no part.
process.env.HOME = path.join(BASE, 'home');
process.env.GIT_CONFIG_NOSYSTEM = '1';
fs.mkdirSync(process.env.HOME);
const { statusOf, repoExtras, myCommitTimes } = await import('../server/sources/git.js');

const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();
const marker = (name) => path.join(BASE, `${name}.ran`);
const script = (name) => {
  const p = path.join(BASE, `${name}.sh`);
  fs.writeFileSync(p, `#!/bin/sh\ntouch '${marker(name)}'\ncat\n`, { mode: 0o755 });
  return p;
};

function repo(name) {
  const dir = path.join(BASE, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

test('git status never runs a repo-local clean filter', async () => {
  const dir = repo('filter');
  fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=evil\n');
  git(dir, 'config', 'filter.evil.clean', script('clean'));
  git(dir, 'config', 'filter.evil.process', script('process'));
  // As after unpacking an archive: same content, different stat data, so git must look at the content.
  const f = path.join(dir, 'a.txt');
  fs.utimesSync(f, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  const st = await statusOf(dir);
  await repoExtras(dir);
  assert.equal(fs.existsSync(marker('clean')), false, 'the clean filter ran');
  assert.equal(fs.existsSync(marker('process')), false, 'the process filter ran');
  assert.equal(st.ok, false);
  assert.match(st.error, /filter/i);
});

test('git log / show never run a repo-local gpg.program (log.showSignature)', async () => {
  const dir = repo('signature');
  // A commit carrying a signature header, so that showing it would verify the signature.
  const tree = git(dir, 'rev-parse', 'HEAD^{tree}');
  const parent = git(dir, 'rev-parse', 'HEAD');
  const body = `tree ${tree}\nparent ${parent}\nauthor T <t@example.com> 1700000000 +0000\ncommitter T <t@example.com> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----\n\nsigned\n`;
  const sha = execFileSync('git', ['-C', dir, 'hash-object', '-t', 'commit', '-w', '--stdin'], { input: body, encoding: 'utf8' }).trim();
  git(dir, 'update-ref', 'HEAD', sha);
  git(dir, 'config', 'log.showSignature', 'true');
  git(dir, 'config', 'gpg.program', script('gpg'));
  await statusOf(dir);
  await repoExtras(dir);
  await myCommitTimes(dir, ['t@example.com', 'T']);
  assert.equal(fs.existsSync(marker('gpg')), false, 'gpg.program ran');
});

test('git-lfs repos still get their status (well-known filters are allowed)', async () => {
  const dir = repo('lfs');
  git(dir, 'config', 'filter.lfs.clean', 'git-lfs clean -- %f');
  git(dir, 'config', 'filter.lfs.process', 'git-lfs filter-process');
  const st = await statusOf(dir);
  assert.equal(st.ok, true, st.error);
});

test('an allow-listed filter command cannot smuggle a second line (shell runs every line)', async () => {
  const dir = repo('newline');
  fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=x\n');
  git(dir, 'config', 'filter.x.clean', `git-lfs clean\ntouch '${marker('newline')}'\ncat`);
  fs.utimesSync(path.join(dir, 'a.txt'), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  const st = await statusOf(dir);
  assert.equal(fs.existsSync(marker('newline')), false, 'the smuggled line ran');
  assert.equal(st.ok, false);
});

test('git-lfs extensions and custom transfer agents in a repo\'s own config also skip git status', async () => {
  const dir = repo('lfsext');
  git(dir, 'config', 'lfs.extension.evil.clean', `sh '${script('lfsext')}' %f`);
  git(dir, 'config', 'lfs.extension.evil.smudge', `sh '${script('lfsext')}' %f`);
  git(dir, 'config', 'lfs.extension.evil.priority', '0');
  assert.equal((await statusOf(dir)).ok, false);
  const dir2 = repo('lfsxfer');
  git(dir2, 'config', 'lfs.customtransfer.evil.path', script('lfsxfer'));
  assert.equal((await statusOf(dir2)).ok, false);
});

test('a partial clone cannot lazily "fetch" through a command (ext:: remote)', async () => {
  const dir = repo('partial');
  const m = marker('partial');
  git(dir, 'config', 'core.repositoryformatversion', '1');
  git(dir, 'config', 'extensions.partialClone', 'origin');
  git(dir, 'config', 'remote.origin.promisor', 'true');
  git(dir, 'config', 'remote.origin.url', `ext::sh -c touch% ${m}`);
  git(dir, 'config', 'protocol.ext.allow', 'always');
  // Remove HEAD's tree so git wants to fetch it.
  const tree = git(dir, 'rev-parse', 'HEAD^{tree}');
  fs.rmSync(path.join(dir, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));
  await statusOf(dir);
  await repoExtras(dir);
  assert.equal(fs.existsSync(m), false, 'the ext:: command ran');
});

test('when git can\'t say which config defines filters (old git, timeout), status is skipped, not run', async () => {
  const { riskyConfig } = await import('../server/sources/git.js');
  assert.equal(riskyConfig(1, ''), false, 'exit 1: no such keys');
  assert.equal(riskyConfig(129, ''), true, 'git < 2.26 has no --show-scope');
  assert.equal(riskyConfig(null, ''), true, 'timeout');
  assert.equal(riskyConfig(0, 'global\0filter.lfs.clean\ngit-lfs clean -- %f\0'), false, "the user's own filters are fine");
  assert.equal(riskyConfig(0, 'local\0filter.lfs.process\ngit-lfs filter-process\0'), false, 'plain git-lfs in the repo');
  assert.equal(riskyConfig(0, 'local\0filter.x.clean\ngit-lfs clean\ntouch /m\0'), true);
  assert.equal(riskyConfig(0, 'garbage'), true, 'unreadable output');
});
