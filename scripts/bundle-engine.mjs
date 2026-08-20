/**
 * Freezes the Python statistical engine into a standalone one-folder bundle,
 * so a packaged Terra Pulse needs no system Python (PROJECT_PLAN.md §10).
 *
 * Output: `engine/dist/terra-pulse-engine/`, which `electron-builder.yml` ships
 * as an `extraResource` to `resources/engine/`.
 *
 * Run:  pnpm engine:bundle
 *
 * ## Why this is a script and not a one-line pnpm command
 *
 * Three things have to be checked before PyInstaller runs, and each of them
 * fails in a way that is confusing rather than obvious if it is not:
 *
 *   - **No venv.** `python -m PyInstaller` against a bare system Python either
 *     is not installed or, worse, freezes a *different* set of dependencies
 *     than the engine's tests ran against.
 *   - **PyInstaller not installed.** It is deliberately in the `bundle` extra
 *     rather than `dev` (see `pyproject.toml`), so a normal setup does not
 *     have it, and the raw error is a bare `No module named PyInstaller`.
 *   - **A stale bundle.** PyInstaller happily leaves a previous `dist/` in
 *     place on failure, so a broken build can be packaged and shipped looking
 *     entirely healthy. The old output is removed *before* the build, not
 *     after, so a failure leaves nothing to ship rather than something wrong.
 *
 * The spec file (`engine/terra-pulse-engine.spec`) carries the real build
 * configuration — hidden imports, exclusions, one-folder vs one-file — and
 * documents why each is what it is.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, statSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_DIR = join(ROOT, 'engine');
const SPEC = 'terra-pulse-engine.spec';
const OUT_DIR = join(ENGINE_DIR, 'dist', 'terra-pulse-engine');

const isWindows = process.platform === 'win32';
const venvPython = isWindows
  ? join(ENGINE_DIR, '.venv', 'Scripts', 'python.exe')
  : join(ENGINE_DIR, '.venv', 'bin', 'python');

function fail(message) {
  console.error(`\nengine:bundle — ${message}\n`);
  process.exit(1);
}

if (!existsSync(venvPython)) {
  fail(
    `no engine venv at ${venvPython}\n` +
      `  Set one up first (engine/README.md):\n` +
      `    python -m venv engine/.venv\n` +
      `    ${isWindows ? 'engine\\.venv\\Scripts\\python.exe' : 'engine/.venv/bin/python'} -m pip install -e "engine[dev,bundle]"`,
  );
}

const hasPyInstaller = spawnSync(venvPython, ['-c', 'import PyInstaller'], { stdio: 'ignore' });
if (hasPyInstaller.status !== 0) {
  fail(
    'PyInstaller is not installed in the engine venv.\n' +
      '  It lives in the `bundle` extra, not `dev`, so a normal setup omits it:\n' +
      `    ${venvPython} -m pip install -e "engine[bundle]"`,
  );
}

// Before the build, never after: a failed build must leave nothing shippable
// rather than yesterday's bundle wearing today's date.
if (existsSync(OUT_DIR)) {
  console.log(`Removing previous bundle at ${OUT_DIR}`);
  rmSync(OUT_DIR, { recursive: true, force: true });
}

console.log('Freezing the engine with PyInstaller — this takes about a minute.\n');
const build = spawnSync(
  venvPython,
  ['-m', 'PyInstaller', SPEC, '--noconfirm', '--distpath', 'dist', '--workpath', 'build'],
  { cwd: ENGINE_DIR, stdio: 'inherit' },
);

if (build.status !== 0) {
  fail(`PyInstaller exited with code ${String(build.status)}`);
}

const executable = join(OUT_DIR, isWindows ? 'terra-pulse-engine.exe' : 'terra-pulse-engine');
if (!existsSync(executable)) {
  fail(`build reported success but produced no executable at ${executable}`);
}

function directorySizeBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? directorySizeBytes(path) : statSync(path).size;
  }
  return total;
}

const megabytes = (directorySizeBytes(OUT_DIR) / 1e6).toFixed(1);
console.log(`\nengine:bundle — built ${OUT_DIR} (${megabytes} MB)`);
console.log('  Packaging will pick it up automatically:');
console.log('    pnpm --filter @terra-pulse/desktop package');
