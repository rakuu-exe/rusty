/**
 * Wrapper around `rustplus.js fcm-register`.
 *
 * That CLI drives a Chromium browser via chrome-launcher to capture the Rust+
 * auth token during Steam login. It only looks for Google Chrome, which many
 * Windows machines do not have — but chrome-launcher checks CHROME_PATH first,
 * and Edge is Chromium, so pointing it at Edge works identically.
 *
 * Doing the detection here rather than in an npm script keeps it working the
 * same from PowerShell, cmd and bash, which all disagree about how to set an
 * environment variable inline.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { platform } from 'node:process';

/**
 * Work around a Unix assumption in the upstream CLI.
 *
 * It hardcodes `--user-data-dir=/tmp/temporary-chrome-profile-dir-rustplus`,
 * which on Windows resolves to C:\tmp\... — a directory that does not exist by
 * default. Chromium refuses to honour --disable-web-security on a default
 * profile, so when that directory is unusable the flag is silently dropped,
 * the postMessage handler is never injected, and login fails at the handoff
 * with "failed to send login message to the rust+ app".
 *
 * Creating the directory up front is enough to make the flag stick.
 */
function ensureChromeProfileDir() {
  if (platform !== 'win32') return;

  const dir = 'C:\\tmp\\temporary-chrome-profile-dir-rustplus';
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    console.warn(`Could not create ${dir}: ${error.message}`);
    console.warn('Login may fail at the token handoff step.');
  }
}

/** Chromium builds to try, best first. Chrome is preferred only because the
 *  upstream tool is written and tested against it. */
const CANDIDATES = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge'],
};

function findBrowser() {
  // An explicit CHROME_PATH always wins, so this can still be overridden.
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  return (CANDIDATES[platform] ?? []).find((path) => path && existsSync(path)) ?? null;
}

const browser = findBrowser();
if (!browser) {
  console.error(
    [
      'No Chromium-based browser found.',
      '',
      'fcm-register needs Chrome, Edge or Brave to perform the Steam login.',
      'Firefox will not work: the tool passes Chrome-only flags such as',
      '--disable-web-security, which Firefox does not understand.',
      '',
      'Install one, or set CHROME_PATH to an existing Chromium binary.',
    ].join('\n'),
  );
  process.exit(1);
}

ensureChromeProfileDir();

console.log(`Using browser: ${browser}`);
console.log('');
console.log('A browser window will open for Steam login.');
console.log('It runs with web security disabled (that is how the tool captures the');
console.log('Rust+ token) but in a THROWAWAY profile, so your normal browser profile,');
console.log('cookies and saved logins are not exposed. Close it when finished.');
console.log('');

// Resolve the CLI through node rather than a shell, so no PATH lookup or
// shell quoting is involved.
const require = createRequire(import.meta.url);
const cli = require.resolve('@liamcottle/rustplus.js/cli/index.js');

const child = spawn(process.execPath, [cli, 'fcm-register', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, CHROME_PATH: browser },
});

child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (error) => {
  console.error(`Failed to launch fcm-register: ${error.message}`);
  process.exit(1);
});
