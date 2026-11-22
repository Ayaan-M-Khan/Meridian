import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitGuardEnv } from '../server/local/git-guard.js';

const hasGit = spawnSync('git', ['--version']).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-test-git-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const run = (cwd, args, env = process.env) => spawnSync('git', args, { cwd, env, encoding: 'utf8' });
const ok = (cwd, args, env) => {
  const r = run(cwd, args, env);
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

test('the push check refuses force-pushes and remote deletes in every form, and runs the repository’s own hooks', { skip: !hasGit && 'git isn’t installed' }, () => {
  const remote = path.join(tmp, 'remote.git');
  ok(tmp, ['init', '-q', '--bare', '-b', 'main', remote]);
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  ok(repo, ['init', '-q', '-b', 'main']);
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false']]) ok(repo, ['config', k, v]);
  ok(repo, ['remote', 'add', 'origin', remote]);

  // The repository's own hooks keep running during a git task.
  const marks = path.join(tmp, 'hook-marks.txt').replace(/\\/g, '/');
  for (const h of ['pre-commit', 'pre-push']) fs.writeFileSync(path.join(repo, '.git', 'hooks', h), `#!/bin/sh\necho ${h} >> "${marks}"\n`, { mode: 0o755 });
  // Set up as a git task's run is: the push check, plus pass-throughs only for the hooks this repository has.
  const guard = { ...process.env, ...gitGuardEnv(path.join(tmp, 'data'), repo) };
  assert.deepEqual(fs.readdirSync(guard.GIT_CONFIG_VALUE_0).sort(), ['pre-commit', 'pre-push'], 'no hooks that git runs on every command');

  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  ok(repo, ['add', '-A'], guard);
  ok(repo, ['commit', '-q', '-m', 'First'], guard);
  ok(repo, ['push', '-q', '-u', 'origin', 'main'], guard);
  // Normal pushes and new branches go through.
  fs.appendFileSync(path.join(repo, 'a.txt'), 'two\n');
  ok(repo, ['commit', '-q', '-am', 'Second'], guard);
  ok(repo, ['push', '-q'], guard);
  ok(repo, ['push', '-q', 'origin', 'main:feature'], guard);
  assert.deepEqual(fs.readFileSync(marks, 'utf8').trim().split(/\r?\n/), ['pre-commit', 'pre-push', 'pre-commit', 'pre-push', 'pre-push']);

  // Overwriting what's on the remote is refused, whatever the flags.
  ok(repo, ['commit', '-q', '--amend', '-m', 'Second, reworded'], guard);
  for (const args of [['push', '--force'], ['push', '-f', 'origin', 'main'], ['push', 'origin', 'main', '--force'], ['push', '--force-with-lease'], ['push', 'origin', '+main']]) {
    const r = run(repo, args, guard);
    assert.notEqual(r.status, 0, `git ${args.join(' ')} should be refused`);
    assert.match(r.stderr, /Meridian blocked a push that would overwrite history on the remote \(refs\/heads\/main\)/);
  }
  const del = run(repo, ['push', 'origin', '--delete', 'feature'], guard);
  assert.notEqual(del.status, 0);
  assert.match(del.stderr, /Meridian blocked deleting refs\/heads\/feature on the remote/);
  assert.equal(run(remote, ['rev-parse', '--verify', '-q', 'feature']).status, 0, 'the remote branch is still there');
  assert.notEqual(ok(remote, ['log', '-1', '--format=%s', 'main']), 'Second, reworded', 'the remote kept its history');

  // Outside a git task, git works as usual: the check is only in that run's environment.
  ok(repo, ['push', '-q', '--force'], process.env);
  assert.equal(ok(remote, ['log', '-1', '--format=%s', 'main']), 'Second, reworded');
});

test('the push check keeps config entries already in the environment', () => {
  const env = gitGuardEnv(path.join(tmp, 'data2'), null, { GIT_CONFIG_COUNT: '2' });
  assert.equal(env.GIT_CONFIG_COUNT, '3');
  assert.equal(env.GIT_CONFIG_KEY_2, 'core.hooksPath');
  assert.deepEqual(fs.readdirSync(env.GIT_CONFIG_VALUE_2), ['pre-push'], 'without a repository, only the push check');
});
