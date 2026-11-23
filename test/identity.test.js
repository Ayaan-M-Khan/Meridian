import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handOffTarget, isNormalLaunch, parseInstallLocation, samePath, shortcutsToRepair } from '../electron/identity.js';

const INSTALLED_DIR = String.raw`C:\Users\pat\AppData\Local\Programs\AI Command Center`;
const INSTALLED = String.raw`C:\Users\pat\AppData\Local\Programs\AI Command Center\Meridian.exe`;
const BUILD = String.raw`C:\Users\pat\code\meridian\dist\win-unpacked\Meridian.exe`;
const base = { installDir: INSTALLED_DIR, packaged: true, platform: 'win32', argv: ['Meridian.exe'], env: {}, exists: () => true };

test('Windows paths compare without case or a trailing separator', () => {
  assert.equal(samePath(INSTALLED, INSTALLED.toLowerCase(), 'win32'), true);
  assert.equal(samePath(`${INSTALLED_DIR}\\`, INSTALLED_DIR, 'win32'), true);
  assert.equal(samePath(INSTALLED, BUILD, 'win32'), false);
  assert.equal(samePath(null, INSTALLED, 'win32'), false);
});

test('the install folder comes from the installer’s registry key', () => {
  const out = `\r\nHKEY_CURRENT_USER\\Software\\142f0647\r\n    InstallLocation    REG_SZ    ${INSTALLED_DIR}\r\n\r\n`;
  assert.equal(parseInstallLocation(out), INSTALLED_DIR);
  assert.equal(parseInstallLocation('ERROR: The system was unable to find the specified registry key or value.'), null);
  assert.equal(parseInstallLocation(undefined), null);
});

test('a copy opened from elsewhere hands off to the installed Meridian; the installed one and test copies don’t', () => {
  assert.equal(handOffTarget({ ...base, execPath: BUILD }), INSTALLED, 'a build opened through a stray shortcut');
  assert.equal(handOffTarget({ ...base, execPath: INSTALLED }), null, 'the installed copy carries on');
  assert.equal(handOffTarget({ ...base, execPath: INSTALLED.toUpperCase() }), null, 'whatever the case of its path');
  assert.equal(handOffTarget({ ...base, execPath: BUILD, argv: ['Meridian.exe', '--user-data-dir=C:\\tmp\\x'] }), null, 'a test copy with its own folder');
  assert.equal(handOffTarget({ ...base, execPath: BUILD, env: { ACC_DATA_DIR: 'C:\\tmp\\data' } }), null, 'a test copy with its own data');
  assert.equal(handOffTarget({ ...base, execPath: BUILD, exists: () => false }), null, 'nothing installed there any more');
  assert.equal(handOffTarget({ ...base, execPath: BUILD, installDir: null }), null, 'not installed');
  assert.equal(handOffTarget({ ...base, execPath: BUILD, packaged: false }), null, 'running from source');
  assert.equal(handOffTarget({ ...base, execPath: BUILD, platform: 'darwin' }), null);
  assert.equal(isNormalLaunch({ argv: ['Meridian.exe', '--hidden'], env: {} }), true, 'started at sign-in is a normal launch');
});

test('only Meridian shortcuts that point at another Meridian.exe are repaired', () => {
  const shortcuts = [
    { file: 'Start Menu\\Meridian.lnk', link: { target: BUILD, appUserModelId: 'com.aicommandcenter.desktop' } },
    { file: 'Desktop\\Meridian.lnk', link: { target: INSTALLED } },
    { file: 'TaskBar\\Meridian.lnk', link: { target: INSTALLED.toLowerCase() } },
    { file: 'Desktop\\Meridian notes.lnk', link: { target: String.raw`C:\notes\Meridian notes.txt` } },
    { file: 'Broken.lnk', link: null },
  ];
  assert.deepEqual(shortcutsToRepair(shortcuts, INSTALLED, 'win32').map((s) => s.file), ['Start Menu\\Meridian.lnk']);
});
