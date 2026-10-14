// Builds the AnythingLLM release pinned in package.json ("anythingllm": { "version": ... }) into
// ./anythingllm.
//
// Nothing of AnythingLLM's is committed to this repository. The build downloads the tagged
// source from GitHub and builds it the way upstream's own Dockerfile does: the web interface with
// Vite, then the server and the document collector with their production dependencies from
// upstream's yarn lockfiles, then the Prisma client for its SQLite database. Upgrading is a
// version bump in package.json.
//
// Nixpacks runs this as `npm run build`. It needs internet access (GitHub, the npm registry and
// Prisma's engine download) and no app environment: nothing here reads a secret.
//
// Everything happens in this one command on purpose. Each Nixpacks phase is one image layer, so
// the source, the web interface's build dependencies and every cache are created and deleted in
// the same layer and never reach the image. Only ./anythingllm is left behind.

'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const version = require('./package.json').anythingllm?.version;
const YARN_VERSION = '1.22.22';

const root = __dirname;
const runtime = path.join(root, 'anythingllm');
const work = path.join(os.tmpdir(), 'velixir-anythingllm-build');
const src = path.join(work, 'src');
const home = path.join(work, 'home');

const env = {
  ...process.env,
  HOME: home,
  XDG_CACHE_HOME: path.join(home, '.cache'),
  npm_config_cache: path.join(home, '.npm'),
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
  YARN_CACHE_FOLDER: path.join(home, '.yarn-cache'),
  // No telemetry from the build tools.
  CHECKPOINT_DISABLE: '1',
  DISABLE_TELEMETRY: 'true',
  // The collector's puppeteer would download a Chrome of its own. There is no browser in this
  // image: the collector reads web pages with plain HTTP instead (see the README).
  PUPPETEER_SKIP_DOWNLOAD: 'true',
  PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: 'true',
};
// Nixpacks sets NPM_CONFIG_PRODUCTION=false for its own install step; each install below says
// what it wants instead.
delete env.NPM_CONFIG_PRODUCTION;
delete env.npm_config_production;

const started = Date.now();

main().catch((err) => fail(err.stack || err.message));

async function main() {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
    fail('package.json needs "anythingllm": { "version": "x.y.z" }, naming a release such as "1.18.0".');
  }

  // ─── Source ─────────────────────────────────────────────────────────────────

  step(`fetching AnythingLLM ${version} from GitHub`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const archive = path.join(work, 'anythingllm.tar.gz');
  await download(`https://github.com/Mintplex-Labs/anything-llm/archive/refs/tags/v${version}.tar.gz`, archive);
  log(`anything-llm-${version}.tar.gz sha256 ${crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')}`);
  // Only the three parts that run. The rest (the browser extension, the desktop "open-computer"
  // tool, cloud templates) is not needed.
  run('tar', ['-xzf', archive, '-C', src, '--strip-components=1',
    `anything-llm-${version}/package.json`, `anything-llm-${version}/frontend`,
    `anything-llm-${version}/server`, `anything-llm-${version}/collector`]);

  const upstream = readJson(path.join(src, 'package.json'));
  if (upstream.version !== version) {
    fail(`the v${version} archive says it is AnythingLLM ${upstream.version}. Check the version in package.json.`);
  }

  // ─── Yarn ───────────────────────────────────────────────────────────────────

  step(`installing yarn ${YARN_VERSION}, the package manager AnythingLLM's lockfiles are written for`);
  const yarnDir = path.join(work, 'yarn');
  fs.mkdirSync(yarnDir);
  npm(['install', '--prefix', yarnDir, '--no-save', `yarn@${YARN_VERSION}`]);
  const yarnCli = path.join(yarnDir, 'node_modules', 'yarn', 'bin', 'yarn.js');
  const yarn = (cwd, args, extraEnv = {}) =>
    run(process.execPath, [yarnCli, ...args], { cwd, env: { ...env, ...extraEnv } });

  // ─── Web interface ──────────────────────────────────────────────────────────

  step('building the web interface (the slow part)');
  const frontend = path.join(src, 'frontend');
  // The same value upstream's Docker build uses: the API on the same origin as the page.
  fs.writeFileSync(path.join(frontend, '.env'), "VITE_API_BASE='/api'\n");
  // Vite and its plugins are devDependencies, and Nixpacks sets NODE_ENV=production for the
  // whole build, which makes yarn skip them.
  yarn(frontend, ['install', '--frozen-lockfile', '--non-interactive', '--network-timeout', '100000'], { NODE_ENV: 'development' });
  yarn(frontend, ['build'], { NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=3072' });
  // Upstream's post-build step renames index.html to _index.html; the server renders it from there.
  if (!fs.existsSync(path.join(frontend, 'dist', '_index.html'))) fail('the web interface build produced no dist/_index.html.');

  // ─── Server and collector ───────────────────────────────────────────────────

  step("installing the server's production dependencies");
  const server = path.join(src, 'server');
  yarn(server, ['install', '--production', '--frozen-lockfile', '--non-interactive', '--network-timeout', '100000']);

  step("installing the document collector's production dependencies");
  const collector = path.join(src, 'collector');
  yarn(collector, ['install', '--production', '--frozen-lockfile', '--non-interactive', '--network-timeout', '100000']);

  step('generating the Prisma client for the SQLite database');
  run(process.execPath, [path.join(server, 'node_modules', 'prisma', 'build', 'index.js'), 'generate', '--schema=./prisma/schema.prisma'], { cwd: server });

  // ─── Runtime ────────────────────────────────────────────────────────────────

  step('assembling the runtime in ./anythingllm');
  fs.rmSync(runtime, { recursive: true, force: true });
  fs.mkdirSync(runtime);
  move(server, path.join(runtime, 'server'));
  move(collector, path.join(runtime, 'collector'));
  move(path.join(frontend, 'dist'), path.join(runtime, 'server', 'public'));

  // server/storage is where AnythingLLM keeps everything (its database, documents, vectors,
  // models). At runtime it is a link to the volume. What upstream ships in it (two logo images
  // and a few readme files) is kept as a seed for an empty volume.
  fs.renameSync(path.join(runtime, 'server', 'storage'), path.join(runtime, 'storage-seed'));
  fs.rmSync(path.join(runtime, 'server', '.env'), { force: true });
  fs.writeFileSync(path.join(runtime, 'VERSION'), `${version}\n`);

  // Fail here rather than at runtime.
  const engines = path.join(runtime, 'server', 'node_modules', '@prisma', 'engines');
  if (!fs.existsSync(engines) || !fs.readdirSync(engines).some((f) => f.startsWith('schema-engine') || f.startsWith('migration-engine'))) {
    fail("Prisma's schema engine was not downloaded, so migrations could not run. Re-run the build.");
  }
  for (const mod of ['@lancedb/lancedb', 'sharp', 'canvas']) {
    const check = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: path.join(runtime, 'server'), env, encoding: 'utf8' });
    if (check.status !== 0) fail(`the server's native module ${mod} does not load:\n${check.stderr}`);
  }

  fs.rmSync(work, { recursive: true, force: true });
  step(`done: AnythingLLM ${version} in ./anythingllm (${megabytes(runtime)} MB), ${Math.round((Date.now() - started) / 1000)}s in total${peakMemory()}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function step(message) {
  const s = Math.round((Date.now() - started) / 1000);
  console.log(`\n==> anythingllm build [${s}s]: ${message}`);
}

function log(message) {
  console.log(`    ${message}`);
}

function fail(message) {
  console.error(`\nanythingllm build failed: ${message}`);
  process.exit(1);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function run(cmd, args, { cwd = work, env: runEnv = env } = {}) {
  const result = spawnSync(cmd, args, { cwd, env: runEnv, stdio: 'inherit' });
  if (result.error) fail(`${cmd} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${path.basename(cmd)} ${args.join(' ')} exited with ${result.status ?? result.signal}`);
}

// npm sets npm_execpath when it runs a script, so `npm run build` reuses the very npm that is
// running it. Run by hand, fall back to whatever npm is on the PATH.
function npm(args) {
  const cli = process.env.npm_execpath;
  if (cli && /npm-cli\.js$/.test(cli)) return run(process.execPath, [cli, ...args]);
  return run('npm', args);
}

async function download(url, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) fail(`there is no AnythingLLM release v${version} on GitHub. Check the version in package.json.`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      return;
    } catch (err) {
      if (attempt === 3) fail(`could not download ${url}: ${err.message}`);
      log(`download failed (${err.message}), retrying`);
      await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
    }
  }
}

function megabytes(dir) {
  let bytes = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else bytes += fs.lstatSync(p).size;
    }
  };
  walk(dir);
  return Math.round(bytes / 1048576);
}

function peakMemory() {
  try {
    const bytes = Number(fs.readFileSync('/sys/fs/cgroup/memory.peak', 'utf8'));
    return bytes > 0 ? `, peak memory ${Math.round(bytes / 1048576)} MB` : '';
  } catch {
    return '';
  }
}

// A rename where it can (instant), a copy where the scratch folder is on another filesystem.
// verbatimSymlinks keeps relative links in node_modules/.bin relative.
function move(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}
