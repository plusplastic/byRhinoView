// build/release-android.mjs
// Publishes the signed release APK as a GitHub Release, so that
//   https://github.com/plusplastic/byRhinoView/releases/latest/download/byRhinoView.apk
// always serves the newest build. Only the APK is uploaded — android/ itself
// stays out of the repository; the APK is built and signed in Android Studio
// (Generate Signed App Bundle / APK → APK, release) before this runs.
//
// Run:  npm run release:android -- --dry-run   checks + writes the notes draft
//       npm run release:android                tags HEAD and publishes
//
// The notes draft lands in scratch/release/notes-v<version>.md. It is only
// generated when missing, so edits made to it after a dry run are what ship.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const REPO       = 'plusplastic/byRhinoView';
const PACKAGE_ID = 'com.byrhino3d.view';
const ASSET_NAME = 'byRhinoView.apk';   // the /latest/download/ link depends on this exact name

const dryRun = process.argv.includes('--dry-run');

const apkPath    = resolve(root, 'android/app/release/app-release.apk');
const gradlePath = resolve(root, 'android/app/build.gradle');
const outDir     = resolve(root, 'scratch/release');

const fail = (msg) => { console.error(`\n[release] ✗ ${msg}`); process.exit(1); };
const ok   = (msg) => console.log(`[release] ✓ ${msg}`);
const info = (msg) => console.log(`[release]   ${msg}`);

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const git = (...args) => run('git', args);
const tryRun = (cmd, args, opts) => { try { return run(cmd, args, opts); } catch { return null; } };

// ── 1. Every place that states the version must agree ────────────────────────
if (!existsSync(gradlePath)) fail(`${gradlePath} not found — is the Android project set up here?`);
const gradle      = readFileSync(gradlePath, 'utf8');
const versionName = gradle.match(/versionName\s+"([^"]+)"/)?.[1];
const versionCode = Number(gradle.match(/versionCode\s+(\d+)/)?.[1]);
if (!versionName || !versionCode) fail('could not read versionName / versionCode from build.gradle');

const readAppVersion = (file) => readFileSync(file, 'utf8').match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1];
const versions = {
  'android/app/build.gradle':                      versionName,
  'package.json':                                  JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version,
  'www/session.js':                                readAppVersion(resolve(root, 'www/session.js')),
  'android/.../assets/public/session.js (synced)': readAppVersion(resolve(root, 'android/app/src/main/assets/public/session.js')),
};
const mismatched = Object.entries(versions).filter(([, v]) => v !== versionName);
if (mismatched.length) {
  fail('versions disagree:\n' + Object.entries(versions).map(([k, v]) => `           ${k.padEnd(48)} ${v}`).join('\n')
    + '\n         Bump them together, then `npm run build:shell` and `npm run sync:android`.');
}
ok(`version ${versionName} (versionCode ${versionCode}) everywhere`);

const tag = `v${versionName}`;

// ── 2. The APK must be the build of what is synced now ───────────────────────
if (!existsSync(apkPath)) fail(`${apkPath} not found — build a signed release APK in Android Studio first.`);
const apkTime = statSync(apkPath).mtimeMs;
const syncedTime = statSync(resolve(root, 'android/app/src/main/assets/public/session.js')).mtimeMs;
if (syncedTime > apkTime) fail('web assets were synced after the APK was built — rebuild the APK.');

// Android SDK tools: badging tells us what the APK really is, apksigner that it
// is signed. apksigner is a .bat that needs Java; Android Studio's bundled JBR
// is used when JAVA_HOME is not set.
const sdkDir = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  || readFileSync(resolve(root, 'android/local.properties'), 'utf8').match(/sdk\.dir=(.*)/)?.[1].trim().replace(/\\(.)/g, '$1');
const buildTools = sdkDir && existsSync(resolve(sdkDir, 'build-tools'))
  ? readdirSync(resolve(sdkDir, 'build-tools')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop()
  : null;
if (!buildTools) fail('Android SDK build-tools not found (set ANDROID_HOME).');
const bt = resolve(sdkDir, 'build-tools', buildTools);

const badging = run(resolve(bt, process.platform === 'win32' ? 'aapt2.exe' : 'aapt2'), ['dump', 'badging', apkPath]);
const pkg = badging.match(/package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/);
if (!pkg) fail('could not read the APK package line');
if (pkg[1] !== PACKAGE_ID) fail(`APK package is ${pkg[1]}, expected ${PACKAGE_ID}`);
if (Number(pkg[2]) !== versionCode || pkg[3] !== versionName) {
  fail(`APK is ${pkg[3]} (${pkg[2]}), build.gradle says ${versionName} (${versionCode}) — rebuild the APK.`);
}
ok(`APK is ${pkg[1]} ${pkg[3]} (${pkg[2]})`);

const javaHome = process.env.JAVA_HOME
  || ['C:/Program Files/Android/Android Studio/jbr', '/Applications/Android Studio.app/Contents/jbr/Contents/Home']
       .find((p) => existsSync(p));
const apksigner = resolve(bt, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
let signers;
try {
  signers = run(apksigner, ['verify', '--print-certs', apkPath],
    { shell: process.platform === 'win32', env: { ...process.env, ...(javaHome && { JAVA_HOME: javaHome }) } });
} catch (e) {
  fail(`apksigner rejected the APK — is it a signed release build?\n${e.stderr || e.message}`);
}
const signerDN = signers.match(/certificate DN: (.*)/)?.[1];
if (/CN=Android Debug/.test(signerDN)) fail('APK is signed with the debug key.');
ok(`signed by ${signerDN}`);

// ── 3. Git: HEAD must be committed and pushed, the tag free or already HEAD ──
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const dirty = git('status', '--porcelain', '--untracked-files=no');
if (dirty) fail(`uncommitted changes:\n${dirty}`);
git('fetch', '--quiet', '--tags', 'origin');
const head = git('rev-parse', 'HEAD');
const unpushed = tryRun('git', ['rev-list', `origin/${branch}..HEAD`]);
if (unpushed === null) fail(`origin/${branch} not found`);
if (unpushed) fail(`${unpushed.split('\n').length} commit(s) on ${branch} not pushed yet — push first.`);

const tagCommit = tryRun('git', ['rev-parse', `${tag}^{commit}`]);
if (tagCommit && tagCommit !== head) fail(`${tag} already exists and points at ${tagCommit.slice(0, 7)}, not HEAD.`);
ok(tagCommit ? `${tag} already points at HEAD` : `${tag} will be created at ${head.slice(0, 7)}`);

// ── 4. gh must be installed, logged in, and the release must not exist ───────
if (tryRun('gh', ['--version']) === null) fail('GitHub CLI not found — `winget install GitHub.cli`, then `gh auth login`.');
if (tryRun('gh', ['auth', 'status']) === null) fail('gh is not logged in — run `gh auth login`.');
if (tryRun('gh', ['release', 'view', tag, '-R', REPO]) !== null) fail(`release ${tag} already exists on GitHub.`);
ok('gh ready, release does not exist yet');

// ── 5. Asset + notes ─────────────────────────────────────────────────────────
mkdirSync(outDir, { recursive: true });
const assetPath = resolve(outDir, ASSET_NAME);
copyFileSync(apkPath, assetPath);
const sha256 = createHash('sha256').update(readFileSync(assetPath)).digest('hex');
const sizeMB = (statSync(assetPath).size / 1024 / 1024).toFixed(1);
ok(`${ASSET_NAME} ${sizeMB} MB  sha256 ${sha256}`);

const notesPath = resolve(outDir, `notes-${tag}.md`);
if (!existsSync(notesPath)) {
  // Changes since the previous release tag, sorted into feat / perf / fix.
  const prevTag = git('tag', '--list', 'v*', '--sort=-v:refname').split('\n').find((t) => t && t !== tag);
  const subjects = git('log', '--no-merges', '--format=%s', prevTag ? `${prevTag}..HEAD` : '-30').split('\n');
  const section = (title, re) => {
    const items = subjects.filter((s) => re.test(s)).map((s) => `- ${s.replace(re, '').replace(/^./, (c) => c.toUpperCase())}`);
    return items.length ? `### ${title}\n${items.join('\n')}\n\n` : '';
  };
  writeFileSync(notesPath,
`## byRhinoView ${versionName} (Android)

**Download:** [${ASSET_NAME}](https://github.com/${REPO}/releases/latest/download/${ASSET_NAME}) — Android 7.0+

SHA-256: \`${sha256}\`

> Do not mix this APK with the Google Play version — uninstall one before installing the other.
> 请勿与 Google Play 版本混装，安装前请先卸载另一版本。

${section('New', /^feat(\([^)]*\))?:\s*/)}${section('Performance', /^perf(\([^)]*\))?:\s*/)}${section('Fixes', /^fix(\([^)]*\))?:\s*/)}`.trimEnd() + '\n');
  info(`notes draft written (changes since ${prevTag ?? 'the last 30 commits'})`);
} else {
  // A hand-edited file is kept, but its checksum must match the APK being uploaded.
  const notes = readFileSync(notesPath, 'utf8');
  const stated = notes.match(/SHA-256:\s*`([0-9a-f]{64})`/)?.[1];
  if (stated && stated !== sha256) fail(`${notesPath} states SHA-256 ${stated}, but the APK is ${sha256}.`);
  info('using the existing notes file');
}
info(`notes: ${notesPath}`);

if (dryRun) {
  console.log('\n[release] dry run — nothing tagged or published. Review the notes, then run without --dry-run.');
  process.exit(0);
}

// ── 6. Tag, push the tag, publish ────────────────────────────────────────────
if (!tagCommit) {
  git('tag', '-a', tag, '-m', `byRhinoView ${versionName}`);
  git('push', 'origin', tag);
  ok(`tagged and pushed ${tag}`);
}
const url = run('gh', ['release', 'create', tag, assetPath,
  '-R', REPO, '--verify-tag', '--latest',
  '--title', `byRhinoView ${versionName}`,
  '--notes-file', notesPath]);
ok(`published ${url}`);
info(`download: https://github.com/${REPO}/releases/latest/download/${ASSET_NAME}`);
