import fs from 'node:fs';
import path from 'node:path';

/**
 * Moves the app's folder from its old name to its new one (AI Command Center → Meridian), keeping everything in it:
 * your data, sign-in and window settings. Returns what happened, so the caller can keep using the old folder when
 * the move isn't possible. Never deletes anything except an empty new folder, and never overwrites data.
 */
export function moveAppFolder(legacy, current) {
  if (path.resolve(legacy) === path.resolve(current)) return 'same';
  if (!fs.existsSync(path.join(legacy, 'data'))) return 'nothing-to-move';
  if (fs.existsSync(path.join(current, 'data'))) return 'already-moved';
  try {
    if (fs.existsSync(current)) fs.rmdirSync(current); // only succeeds when it's empty
  } catch {
    /* not empty: move just the data folder below */
  }
  try {
    if (fs.existsSync(current)) {
      fs.renameSync(path.join(legacy, 'data'), path.join(current, 'data'));
      return 'moved-data';
    }
    fs.renameSync(legacy, current);
    return 'moved';
  } catch {
    return 'keep-legacy';
  }
}
