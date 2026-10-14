// Starts AnythingLLM the way velixir runs apps.
//
// AnythingLLM is two processes: the server (the web interface and API, on $PORT) and the
// document collector (turns uploads and web pages into text, on a private port). Upstream's
// container starts both from a shell script; this file does the same, plus what a public deploy
// needs:
//
//   1. Everything on the volume. AnythingLLM keeps its database, documents, vectors, downloaded
//      models and its own settings file under server/storage and server/.env. Both are linked to
//      the volume (VELIXIR_VOLUME_PATH), so workspaces, chats and settings survive restarts and
//      redeploys. Without a volume they live on the container disk and start over on every
//      restart, and the log says so.
//   2. Locked from the first start. A fresh AnythingLLM is open to anyone who finds the URL until
//      someone sets a password in its onboarding. Here the first start sets one (and a signing
//      secret for sign-in sessions), and prints the password once to the deploy log.
//      ANYTHINGLLM_PASSWORD resets it on any start.
//   3. One process stopping stops both, so the platform restarts the app rather than leaving it
//      half-working. Stop signals reach both, so the database closes cleanly on a redeploy.
//
// While the database migrates, $PORT serves a short "starting" page and /healthz answers 200.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const PORT = Number(process.env.PORT || 3001);
const COLLECTOR_PORT = Number(process.env.COLLECTOR_PORT || (PORT === 8888 ? 8889 : 8888));

const appDir = path.join(__dirname, 'anythingllm');
const serverDir = path.join(appDir, 'server');
const collectorDir = path.join(appDir, 'collector');

const volume = (process.env.VELIXIR_VOLUME_PATH || '').trim();
const base = volume ? path.join(volume, 'anythingllm') : path.join(__dirname, '.anythingllm-data');
const storageDir = path.join(base, 'storage');
const envFile = path.join(base, '.env');
const marker = path.join(base, '.velixir-initialised');

const resetPassword = process.env.ANYTHINGLLM_PASSWORD || '';

const children = [];
let stopping = false;

// ─── The page shown while AnythingLLM starts ─────────────────────────────────

const STARTING_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>Starting AnythingLLM</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#0b0b10; color:#e8e8ef;
         font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif; }
  p { color:#7a7a8c; font-size:.875rem; }
</style>
<div><h1>AnythingLLM is starting</h1><p>This takes a few seconds. The page reloads by itself.</p></div>
</html>`;

function startingServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '5', 'cache-control': 'no-store' });
    res.end(STARTING_PAGE);
  });
  server.listen(PORT, '0.0.0.0');
  return server;
}

// ─── Storage and settings ────────────────────────────────────────────────────

// Replaces `link` (a folder or file from the image, or an old link) with a symlink to `target`.
function linkTo(link, target) {
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(target, link);
}

function readEnvFile() {
  const values = {};
  if (!fs.existsSync(envFile)) return values;
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(['"]?)(.*)\2\s*$/.exec(line);
    if (m) values[m[1]] = m[3];
  }
  return values;
}

function appendEnv(entries) {
  const lines = Object.entries(entries).map(([k, v]) => `${k}='${v}'`).join('\n');
  const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  fs.writeFileSync(envFile, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${lines}\n`);
}

function replaceEnv(key, value) {
  const lines = (fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '').split('\n')
    .filter((line) => !new RegExp(`^\\s*${key}\\s*=`).test(line) && line !== '');
  lines.push(`${key}='${value}'`);
  fs.writeFileSync(envFile, `${lines.join('\n')}\n`);
}

function prepareStorage() {
  fs.mkdirSync(storageDir, { recursive: true });
  // What upstream ships in server/storage (logos, readme files), for an empty volume. Never
  // overwrites anything already there.
  fs.cpSync(path.join(appDir, 'storage-seed'), storageDir, { recursive: true, force: false, errorOnExist: false });
  if (!fs.existsSync(envFile)) fs.writeFileSync(envFile, '');

  linkTo(path.join(serverDir, 'storage'), storageDir);
  linkTo(path.join(serverDir, '.env'), envFile);

  const current = readEnvFile();
  const additions = {};
  // Signs sign-in sessions. Kept in AnythingLLM's own settings file on the volume, so sessions
  // survive restarts.
  if (!current.JWT_SECRET) additions.JWT_SECRET = crypto.randomBytes(32).toString('hex');

  let firstPassword = null;
  if (!fs.existsSync(marker)) {
    // First start on this storage: lock the instance before anyone can reach it. After this,
    // the password is AnythingLLM's own setting: change it, or switch to multi-user mode, in
    // its Settings > Security, and this file leaves it alone.
    if (!current.AUTH_TOKEN && !resetPassword) {
      firstPassword = randomPassword(24);
      additions.AUTH_TOKEN = firstPassword;
    }
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  }
  if (Object.keys(additions).length) appendEnv(additions);
  // Written to the settings file as well as passed to AnythingLLM, so the reset password stays
  // when the variable is removed again.
  if (resetPassword && current.AUTH_TOKEN !== resetPassword) replaceEnv('AUTH_TOKEN', resetPassword);
  return firstPassword;
}

// ─── Processes ───────────────────────────────────────────────────────────────

function childEnv() {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    // The link, not the volume path: AnythingLLM finds the collector's folder relative to it.
    STORAGE_DIR: path.join(serverDir, 'storage'),
    SERVER_PORT: String(PORT),
    COLLECTOR_PORT: String(COLLECTOR_PORT),
    CHECKPOINT_DISABLE: '1',
  };
  // Anonymous usage statistics to AnythingLLM's makers are off unless you turn them on.
  if (!('DISABLE_TELEMETRY' in process.env)) env.DISABLE_TELEMETRY = 'true';
  // Takes precedence over the settings file, which AnythingLLM then rewrites with it.
  if (resetPassword) env.AUTH_TOKEN = resetPassword;
  delete env.PORT;
  return env;
}

function migrate() {
  console.log('AnythingLLM: applying database migrations.');
  const prisma = path.join(serverDir, 'node_modules', 'prisma', 'build', 'index.js');
  const result = spawnSync(process.execPath, [prisma, 'migrate', 'deploy', '--schema=./prisma/schema.prisma'],
    { cwd: serverDir, env: childEnv(), stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`database migration failed (exit ${result.status ?? result.signal})`);
}

function launch(name, cwd) {
  const child = spawn(process.execPath, ['index.js'], { cwd, env: childEnv(), stdio: 'inherit' });
  child.velixirName = name;
  children.push(child);
  child.on('exit', (code, signal) => {
    if (stopping) {
      if (children.every((c) => c.exitCode !== null || c.signalCode !== null)) process.exit(process.exitCode ?? 0);
      return;
    }
    // Like upstream's container: when one stops, stop the other and let the platform restart
    // the app, rather than run with half of it missing.
    console.error(`AnythingLLM ${name} stopped (${signal || `exit ${code}`}); stopping the app so it restarts.`);
    process.exitCode = 1;
    stopAll('SIGTERM');
    setTimeout(() => process.exit(1), 10000).unref();
  });
  return child;
}

function stopAll(signal) {
  stopping = true;
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill(signal);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!volume) {
    box([
      "No volume: AnythingLLM's data is on the container disk.",
      '',
      'Workspaces, chats, documents, embeddings and settings start empty',
      "again on every restart and redeploy, and so does the password. Add a",
      "volume on the app's Volume tab (a paid plan) to keep them.",
    ]);
  }

  const placeholder = startingServer();
  const firstPassword = prepareStorage();
  migrate();
  await new Promise((resolve) => placeholder.close(() => resolve()));
  if (stopping) return process.exit(0);

  launch('collector', collectorDir);
  launch('server', serverDir);

  if (firstPassword) {
    box([
      'AnythingLLM is ready. Your password:',
      '',
      `  ${firstPassword}`,
      '',
      'This is shown once. Sign in, then change it (or switch to multi-user',
      'mode) under Settings > Security. Set ANYTHINGLLM_PASSWORD on the',
      'Environment tab to reset it on the next start.',
    ]);
  } else if (resetPassword) {
    console.log('AnythingLLM: password set from ANYTHINGLLM_PASSWORD.');
  }
}

// As PID 1, node gets no default signal handling: without this a redeploy's SIGTERM would be
// ignored until the platform's grace period ran out.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (!children.length) process.exit(0);
    stopAll(signal);
    setTimeout(() => process.exit(0), 20000).unref();
  });
}

function randomPassword(n) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  while (out.length < n) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

function box(lines) {
  const width = Math.max(...lines.map((l) => l.length));
  const border = `+${'-'.repeat(width + 2)}+`;
  console.log(['', border, ...lines.map((l) => `| ${l.padEnd(width)} |`), border].join('\n'));
}

main().catch((err) => {
  console.error(`AnythingLLM could not start: ${err.message}`);
  stopAll('SIGTERM');
  process.exit(1);
});
