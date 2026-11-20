import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** This build's version, from package.json. */
export const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;
  } catch {
    return null;
  }
})();
