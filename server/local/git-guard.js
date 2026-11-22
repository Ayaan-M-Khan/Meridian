/**
 * A check on every push made by an AI with git access (git tasks, runner.js): it refuses pushes that would overwrite
 * or delete history on the remote, which covers force-pushes in every form (--force, -f, --force-with-lease, +refspec)
 * and deleting a remote branch, whatever flags or aliases were used. The AI apps' own permission rules can only match
 * command names, not flags, so this is what actually stops a force-push.
 *
 * It's added for that run only, through git's environment config (GIT_CONFIG_COUNT: core.hooksPath), so nothing in
 * your repository or git settings changes. Each hook here then runs your repository's own hook of the same name
 * (from your core.hooksPath, or .git/hooks), so your hooks keep working during the task.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOKS = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg',
  'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'post-rewrite', 'reference-transaction',
  'pre-auto-gc', 'post-index-change', 'push-to-checkout', 'sendemail-validate',
];

// POSIX sh, as git runs hooks (Git for Windows uses its own sh). Same script for every hook name.
const SCRIPT = `#!/bin/sh
# Added by Meridian for one git task. Refuses pushes that would overwrite or delete history on the remote,
# then runs this repository's own hook of the same name.
name=\${0##*/}
own=$(GIT_CONFIG_COUNT=0 git config --get core.hooksPath 2>/dev/null)
[ -n "$own" ] || own="$(GIT_CONFIG_COUNT=0 git rev-parse --git-common-dir)/hooks"
if [ "$name" = pre-push ]; then
  input=$(cat)
  printf '%s\\n' "$input" | while read -r lref lsha rref rsha; do
    [ -n "$lref" ] || continue
    case $lsha in
      *[!0]*) ;;
      *) echo "Meridian blocked deleting $rref on the remote. Git tasks can't delete remote branches." >&2; exit 1 ;;
    esac
    case $rsha in
      *[!0]*)
        if ! git merge-base --is-ancestor "$rsha" "$lsha" 2>/dev/null; then
          echo "Meridian blocked a push that would overwrite history on the remote ($rref). Pull and merge the remote's changes first, then push normally." >&2
          exit 1
        fi ;;
    esac
  done || exit 1
  if [ -x "$own/$name" ]; then printf '%s\\n' "$input" | "$own/$name" "$@"; exit $?; fi
  exit 0
fi
if [ -x "$own/$name" ]; then exec "$own/$name" "$@"; fi
exit 0
`;

/** The hooks the repository at `folder` has (in its core.hooksPath, or .git/hooks), by name. */
export function repositoryHooks(folder) {
  if (!folder) return [];
  // GIT_CONFIG_COUNT=0: the repository's own settings, not a check already in this environment.
  const git = (args) => spawnSync('git', args, { cwd: folder, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_CONFIG_COUNT: '0' } });
  try {
    let dir = git(['config', '--get', 'core.hooksPath']).stdout?.trim();
    if (dir) dir = path.resolve(git(['rev-parse', '--show-toplevel']).stdout?.trim() || folder, dir.replace(/^~(?=[\\/])/, os.homedir()));
    else {
      const common = git(['rev-parse', '--git-common-dir']).stdout?.trim();
      if (!common) return [];
      dir = path.join(path.resolve(folder, common), 'hooks');
    }
    return fs.readdirSync(dir).filter((h) => HOOKS.includes(h));
  } catch {
    return [];
  }
}

/**
 * Writes the hooks under the app's data folder and returns their folder: the push check, plus a pass-through for each
 * hook the repository has. Only those: git runs some hooks on nearly every command (post-index-change on each index
 * write, reference-transaction on each ref update), and a hook there costs a shell start each time.
 */
export function gitGuardDir(dataDir, names = []) {
  const set = [...new Set(['pre-push', ...names.filter((h) => HOOKS.includes(h))])].sort();
  const dir = path.join(dataDir, 'git-guard', set.length === 1 ? 'push' : crypto.createHash('sha256').update(set.join(',')).digest('hex').slice(0, 12));
  fs.mkdirSync(dir, { recursive: true });
  for (const h of set) {
    const f = path.join(dir, h);
    let cur = null;
    try {
      cur = fs.readFileSync(f, 'utf8');
    } catch {
      cur = null;
    }
    if (cur !== SCRIPT) fs.writeFileSync(f, SCRIPT, { mode: 0o755 });
  }
  return dir;
}

/**
 * Environment for one run in the repository at `folder`: git uses these hooks, after any config entries already in
 * the environment. Hooks the repository adds during the run aren't run until the next one.
 */
export function gitGuardEnv(dataDir, folder = null, env = process.env) {
  const n = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  return {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: 'core.hooksPath',
    [`GIT_CONFIG_VALUE_${n}`]: gitGuardDir(dataDir, repositoryHooks(folder)).replace(/\\/g, '/'),
  };
}
