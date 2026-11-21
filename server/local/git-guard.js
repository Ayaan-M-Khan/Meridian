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
import fs from 'node:fs';
import path from 'node:path';

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

/** Writes the hooks under the app's data folder (once) and returns their folder. */
export function gitGuardDir(dataDir) {
  const dir = path.join(dataDir, 'git-guard', 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  for (const h of HOOKS) {
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

/** Environment for one run: git uses these hooks, after any config entries already in the environment. */
export function gitGuardEnv(dataDir, env = process.env) {
  const n = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  return {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: 'core.hooksPath',
    [`GIT_CONFIG_VALUE_${n}`]: gitGuardDir(dataDir).replace(/\\/g, '/'),
  };
}
