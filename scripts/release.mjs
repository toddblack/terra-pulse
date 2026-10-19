/**
 * Builds a release and, with `--publish`, puts it on GitHub.
 *
 * Run:  pnpm release              build and check; prints what it would publish
 *       pnpm release --publish    the same, then creates the GitHub release
 *
 * The version is `apps/desktop/package.json`'s. Bump it there first, in a
 * commit on main; the release is tagged `v<version>` at that commit.
 *
 * ## Why the release page is what matters
 *
 * The app's update check (`apps/desktop/src/main/update-check.ts`) asks
 * GitHub for this repository's **latest release** and compares its tag with
 * the running version. So a release published here is what every installed
 * copy is told about. Two rules follow, and the checks below hold them:
 *
 *   - **Built from main, clean, and pushed.** A release built from a dirty tree
 *     or a local-only commit is a binary nobody can reproduce from the repo.
 *   - **Never a duplicate tag.** Re-publishing v0.2.0 with different bytes
 *     would give two installs with the same version and different code.
 *
 * Drafts and pre-releases are ignored by the update check, so a release can be
 * staged as a draft on the GitHub page by hand and published there when ready.
 *
 * ## What it uploads
 *
 * The NSIS installer and its `.blockmap`. The blockmap does nothing today; it
 * is what lets a future signed auto-updater download only the changed parts,
 * and it has to be on every release from the start for that to work.
 *
 * The installer's SHA-256 goes in the release notes, so anyone can check the
 * file they downloaded is the one published. Unsigned, that is the only
 * integrity check a reader has.
 *
 * ## The Microsoft Store build
 *
 *       pnpm release --store      builds Terra-Pulse-<version>.appx for upload
 *
 * Same tree checks — main, clean, pushed — because a Store package should be
 * as reproducible from the repo as a GitHub one. It publishes nothing: the
 * upload to Partner Center is by hand. It does not care whether the GitHub tag
 * exists, since the usual order is GitHub release first, Store package of the
 * same version second. **It refuses while electron-builder.yml still carries
 * the placeholder identity**, because Partner Center rejects a package whose
 * identity is not the one it issued, and only after the upload.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps', 'desktop');
const RELEASE_DIR = join(DESKTOP, 'release');
const publish = process.argv.includes('--publish');
const store = process.argv.includes('--store');
if (publish && store) fail('--store builds a package to upload by hand; it cannot be combined with --publish');

function fail(message) {
  console.error(`\nrelease — ${message}\n`);
  process.exit(1);
}

/** Runs a command, returning trimmed stdout; exits on failure unless `allowFail`. */
function run(command, args, { allowFail = false, inherit = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
    shell: process.platform === 'win32' && command === 'pnpm',
  });
  if (result.status !== 0 && !allowFail) {
    fail(`\`${command} ${args.join(' ')}\` failed${result.stderr ? `:\n${result.stderr}` : ''}`);
  }
  return { ok: result.status === 0, out: (result.stdout ?? '').trim() };
}

// --- The version -----------------------------------------------------------

const version = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')).version;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  fail(`apps/desktop/package.json has version "${version}" — it must be plain x.y.z, which is what the update check compares`);
}
if (version === '0.0.0') fail('the version is still 0.0.0 — bump apps/desktop/package.json first');
const tag = `v${version}`;

// --- The tree --------------------------------------------------------------

const branch = run('git', ['branch', '--show-current']).out;
if (branch !== 'main') fail(`on branch "${branch}" — releases are built from main`);
if (run('git', ['status', '--porcelain']).out !== '') fail('the working tree has changes — commit or stash them first');
run('git', ['fetch', '--quiet', 'origin', 'main']);
const head = run('git', ['rev-parse', 'HEAD']).out;
if (head !== run('git', ['rev-parse', 'origin/main']).out) fail('main is not the same as origin/main — pull or push first');

if (store) {
  buildStorePackage();
  process.exit(0);
}

if (run('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { allowFail: true }).ok) {
  fail(`tag ${tag} already exists locally — bump the version`);
}
if (run('gh', ['release', 'view', tag], { allowFail: true }).ok) fail(`release ${tag} already exists on GitHub — bump the version`);

// --- Build -----------------------------------------------------------------

console.log(`\nrelease — building Terra Pulse ${version} from ${head.slice(0, 7)}\n`);
// Removed first so a failed build cannot leave last time's installer to upload.
rmSync(RELEASE_DIR, { recursive: true, force: true });
run('pnpm', ['engine:bundle'], { inherit: true });
run('pnpm', ['--filter', '@terra-pulse/desktop', 'package'], { inherit: true });

// `artifactName` in electron-builder.yml — no spaces, because GitHub turns
// spaces in asset names into dots and the notes below name the file.
const installerName = `Terra-Pulse-Setup-${version}.exe`;
const installer = join(RELEASE_DIR, installerName);
const blockmap = `${installer}.blockmap`;
for (const file of [installer, blockmap]) {
  if (!existsSync(file)) fail(`expected ${file} after packaging, and it is not there`);
}
if (!existsSync(join(RELEASE_DIR, 'win-unpacked', 'resources', 'engine'))) {
  fail('the packaged app has no engine — electron-builder skips a missing bundle silently');
}

const sha256 = createHash('sha256').update(readFileSync(installer)).digest('hex');
const notes = `## Terra Pulse ${version}

Windows x64. Download **${installerName}** below and run it.

**The installer is not code-signed yet**, so Windows SmartScreen will warn on first run: choose *More info* → *Run anyway*. To check the file you downloaded is the one published here, compare its SHA-256:

\`\`\`
${sha256}
\`\`\`

(In PowerShell, in the folder you downloaded it to: \`Get-FileHash ${installerName}\`.)

Installed copies of Terra Pulse check this page for new releases and say so beside the version number. They never download or install anything themselves.
`;

const notesDir = mkdtempSync(join(tmpdir(), 'terra-pulse-release-'));
const notesFile = join(notesDir, 'notes.md');
writeFileSync(notesFile, notes);

const ghArgs = [
  'release',
  'create',
  tag,
  installer,
  blockmap,
  '--target',
  head,
  '--title',
  `Terra Pulse ${version}`,
  '--notes-file',
  notesFile,
];

console.log(`\nrelease — built.\n  installer  ${installer}\n  sha256     ${sha256}\n`);
if (!publish) {
  console.log(`Nothing published. To publish, run:  pnpm release --publish\n\nNotes that would be posted:\n\n${notes}`);
  rmSync(notesDir, { recursive: true, force: true });
  process.exit(0);
}

run('gh', ghArgs, { inherit: true });
rmSync(notesDir, { recursive: true, force: true });
console.log(`\nrelease — published ${tag}. Installed copies will see it on their next check.\n`);

// --- The Microsoft Store package ----------------------------------------------

function buildStorePackage() {
  const config = readFileSync(join(DESKTOP, 'electron-builder.yml'), 'utf8');
  if (/identityName:\s*TerraPulse\.Placeholder/.test(config) || /publisher:\s*CN=0{8}-/.test(config)) {
    fail(
      'electron-builder.yml still has the placeholder Store identity.\n' +
        '  Copy Package/Identity/Name and Package/Identity/Publisher from Partner Center\n' +
        '  (your app → Product management → Product identity) into the appx section first.',
    );
  }

  console.log(`\nrelease — building the Microsoft Store package for Terra Pulse ${version} from ${head.slice(0, 7)}\n`);
  rmSync(RELEASE_DIR, { recursive: true, force: true });
  run('pnpm', ['engine:bundle'], { inherit: true });
  run('pnpm', ['--filter', '@terra-pulse/desktop', 'package:store'], { inherit: true });

  const appx = join(RELEASE_DIR, `Terra-Pulse-${version}.appx`);
  if (!existsSync(appx)) fail(`expected ${appx} after packaging, and it is not there`);
  if (!existsSync(join(RELEASE_DIR, 'win-unpacked', 'resources', 'engine'))) {
    fail('the packaged app has no engine — electron-builder skips a missing bundle silently');
  }

  console.log(
    `\nrelease — Store package built (unsigned: the Store signs it).\n` +
      `  package  ${appx}\n\n` +
      `Upload it in Partner Center: your app → a new submission → Packages.\n` +
      `The Store needs each submission's version to be higher than the last one it accepted.\n`,
  );
}
