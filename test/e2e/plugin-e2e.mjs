#!/usr/bin/env node
/**
 * Isolated end-to-end harness for dsh-plugin-discord.
 *
 * It never touches the real DSH home's profile or sessions:
 *   1. create a throwaway DSH_HOME under %TEMP% (or DSH_PLUGIN_E2E_HOME),
 *   2. copy only .credentials.yaml / .anonymous-user-id from the real home,
 *   3. materialize profile "plugin-e2e" with
 *        bundles: [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-discord]
 *        dependencies: { "dsh-plugin-discord": "link:<abs plugin dir>" }
 *      and a profile patch that mounts the plugin with runtime.workspace and
 *      debugHttpPort (the plugin's loopback self-test endpoint),
 *   4. pnpm install in the plugin dir and in the isolated profile,
 *   5. boot `dsh --profile plugin-e2e --no-open --port <free>`,
 *   6. wait for GET http://127.0.0.1:<debugHttpPort>/health (up to 120s),
 *   7. POST /selftest {"text":"Reply with exactly: E2E_PLUGIN_OK"} and assert
 *      ok === true and the reply contains E2E_PLUGIN_OK,
 *   8. stop the whole process tree and delete the throwaway home.
 *
 * The precheck test only runs `dsh --profile plugin-e2e --dump-config` to prove
 * the bundle composition (base + web-app + plugin) before spending a model turn.
 *
 * Usage (from dsh-plugin-discord):
 *   DSH_PLUGIN_E2E=1 node --test --test-reporter=spec test/e2e/plugin-e2e.mjs
 * or:  scripts/e2e.ps1
 *
 * Environment overrides:
 *   DSH_PLUGIN_E2E=1        required to run (otherwise tests are skipped)
 *   DSH_PLUGIN_E2E_HOME     reuse/create the throwaway home at this path
 *   DSH_PLUGIN_E2E_KEEP=1   keep the throwaway home after a successful run
 *   DSH_PLUGIN_E2E_HEALTH_ONLY=1  boot + wait for /health, skip the model turn
 *   DSH_REAL_HOME           real DSH home to copy credentials from (default: $DSH_HOME)
 *   DSH_CLI                 dsh.cmd path (default: derived from the install layout)
 *   DSH_NODE / DSH_PNPM     node executable and pnpm.mjs (defaults: process.execPath and sibling pnpm)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENABLED = process.env.DSH_PLUGIN_E2E === '1';
const SKIP_REASON =
  'set DSH_PLUGIN_E2E=1 to run the isolated DSH e2e (boots a throwaway DSH home and performs one real model turn)';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(HERE, '..', '..');
const REAL_DSH_HOME = process.env.DSH_REAL_HOME || process.env.DSH_HOME || join(process.env.USERPROFILE || tmpdir(), '.dsh');

const JSON_HEADERS = { 'content-type': 'application/json' };
const HEALTH_TIMEOUT_MS = 120_000;
const SELFTEST_TIMEOUT_MS = 240_000;
const SELFTEST_TEXT = 'Reply with exactly: E2E_PLUGIN_OK';
const SELFTEST_TOKEN = 'E2E_PLUGIN_OK';
const HEALTH_ONLY = process.env.DSH_PLUGIN_E2E_HEALTH_ONLY === '1';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const startedAt = Date.now();
function log(message) {
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(5);
  process.stdout.write('[plugin-e2e +' + seconds + 's] ' + message + '\n');
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Sleep without keeping the Node event loop alive (used while racing a kill). */
function delayUnref(ms) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

function quoteWinArg(value) {
  const text = String(value);
  return /[\s"]/.test(text) ? '"' + text.replace(/"/g, '\\"') + '"' : text;
}

function tail(text, maxChars = 6000) {
  const value = String(text || '');
  return value.length <= maxChars ? value : '…' + value.slice(-maxChars);
}

function isWithin(child, parent) {
  const childPath = resolve(child).toLowerCase();
  const parentPath = resolve(parent).toLowerCase();
  return childPath === parentPath || childPath.startsWith(parentPath + (parentPath.endsWith('\\') ? '' : '\\'));
}

function assertIsolatedHome(home) {
  const real = resolve(REAL_DSH_HOME);
  if (resolve(home).toLowerCase() === real.toLowerCase()) {
    throw new Error('refusing to use the real DSH home as the isolated home: ' + home);
  }
  const temp = resolve(tmpdir()).toLowerCase();
  const isolated = resolve(home).toLowerCase();
  if (!isolated.startsWith(temp + '\\') && !process.env.DSH_PLUGIN_E2E_HOME) {
    throw new Error('isolated DSH home must live under ' + tmpdir() + ' (got ' + home + ')');
  }
}

// ---------------------------------------------------------------------------
// Toolchain discovery (no node/pnpm on PATH on this machine)
// ---------------------------------------------------------------------------

function resolveNodeAndPnpm() {
  const node = process.env.DSH_NODE || process.execPath;
  let pnpm = process.env.DSH_PNPM;
  if (!pnpm) {
    // <dependencies>/node/bin/node.exe -> <dependencies>/pnpm/bin/pnpm.mjs
    pnpm = resolve(dirname(node), '..', '..', 'pnpm', 'bin', 'pnpm.mjs');
  }
  if (!existsSync(pnpm)) {
    throw new Error(
      'pnpm not found at ' + pnpm + '; set DSH_PNPM to the bundled pnpm.mjs path',
    );
  }
  return { node, pnpm };
}

function resolveDshCli() {
  if (process.env.DSH_CLI) {
    if (!existsSync(process.env.DSH_CLI)) {
      throw new Error('DSH_CLI does not exist: ' + process.env.DSH_CLI);
    }
    return resolve(process.env.DSH_CLI);
  }
  const candidates = [];
  if (process.env.DSH_INSTALL_DIR) {
    candidates.push(join(process.env.DSH_INSTALL_DIR, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
  }
  candidates.push('E:\\deepseekharness\\resources\\runtime\\cli\\bin\\dsh.cmd');
  candidates.push('C:\\deepseekharness\\resources\\runtime\\cli\\bin\\dsh.cmd');
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      'dsh launcher not found; set DSH_CLI to <install>\\resources\\runtime\\cli\\bin\\dsh.cmd',
    );
  }
  return found;
}

/**
 * Resolve how to spawn the launcher.
 *
 * On Windows dsh.cmd is just a shim around
 * `ELECTRON_RUN_AS_NODE=1 "<install>\DeepSeek Harness.exe" --expose-internals
 * <...>\dsh-desktop-host\lib\cli.js %*`. Calling that shim through cmd.exe
 * makes quoting and process-tree handling fragile, so we invoke the Electron
 * binary with the same arguments directly and derive the paths from dsh.cmd's
 * location. Other platforms run the launcher executable directly.
 */
function resolveDshSpawn() {
  const cli = resolveDshCli();
  if (process.platform !== 'win32') {
    return { command: cli, baseArgs: [], env: {} };
  }
  const binDir = dirname(cli);
  const resourcesDir = resolve(binDir, '..', '..', '..');
  const harnessExe = resolve(resourcesDir, '..', 'DeepSeek Harness.exe');
  const hostCli = join(
    resourcesDir,
    'app.asar',
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh-desktop-host',
    'lib',
    'cli.js',
  );
  if (existsSync(harnessExe) && existsSync(hostCli)) {
    return {
      command: harnessExe,
      baseArgs: ['--expose-internals', hostCli],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  // Fallback: go through the .cmd shim.
  return {
    command: process.env.ComSpec || 'cmd.exe',
    baseArgs: ['/d', '/s', '/c', [quoteWinArg(cli)].join(' ')],
    env: {},
    viaCmd: true,
    cli,
  };
}

function dshCommandLine(dshArgs) {
  const spawnSpec = resolveDshSpawn();
  if (spawnSpec.viaCmd) {
    const line = [spawnSpec.baseArgs[3], ...dshArgs.map(quoteWinArg)].join(' ');
    return { command: spawnSpec.command, args: ['/d', '/s', '/c', line], env: spawnSpec.env };
  }
  return { command: spawnSpec.command, args: [...spawnSpec.baseArgs, ...dshArgs], env: spawnSpec.env };
}

function buildEnvOverrides(home) {
  const env = {
    DSH_HOME: home,
    DSH_PROFILE: 'plugin-e2e',
    DSH_TELEMETRY_DISABLED: '1',
    NO_COLOR: '1',
  };
  // Never inherit the launching session's profile pointer or web URL.
  for (const key of ['DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL']) {
    env[key] = undefined;
  }
  return env;
}

function cleanEnv(home) {
  const env = { ...process.env, ...buildEnvOverrides(home), ...resolveDshSpawn().env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  return env;
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
}

function spawnCollect(command, args, options = {}) {
  const { cwd, env, timeoutMs = 60_000, label = 'command' } = options;
  const child = spawn(command, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  let bytes = 0;
  const append = (chunk) => {
    bytes += chunk.length;
    chunks.push(chunk);
    while (bytes > 512 * 1024 && chunks.length > 0) {
      bytes -= chunks[0].length;
      chunks.shift();
    }
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const exit = new Promise((resolvePromise) => {
    child.once('error', (error) => resolvePromise({ code: -1, signal: null, error }));
    child.once('exit', (code, signal) => resolvePromise({ code, signal, error: null }));
  });
  const output = () => Buffer.concat(chunks).toString('utf8');
  const timer = setTimeout(() => {
    killTree(child);
  }, timeoutMs);
  return exit.then((result) => {
    clearTimeout(timer);
    return { ...result, output: output(), label };
  });
}

async function runDsh(dshArgs, options = {}) {
  const { cwd, home, timeoutMs = 180_000 } = options;
  const spec = dshCommandLine(dshArgs);
  const result = await spawnCollect(spec.command, spec.args, {
    cwd,
    env: { ...cleanEnv(home), ...spec.env },
    timeoutMs,
    label: 'dsh ' + dshArgs.join(' '),
  });
  if (result.error) throw new Error('failed to spawn dsh: ' + result.error.message);
  if (result.code !== 0) {
    throw new Error(
      'dsh ' + dshArgs.join(' ') + ' exited with code ' + result.code + '\n' + tail(result.output),
    );
  }
  return result.output;
}

async function runPnpm(pnpmPath, args, cwd) {
  const result = await spawnCollect(process.execPath, [pnpmPath, ...args], {
    cwd,
    env: process.env,
    timeoutMs: 300_000,
    label: 'pnpm ' + args.join(' '),
  });
  if (result.code !== 0) {
    throw new Error('pnpm ' + args.join(' ') + ' failed (code ' + result.code + ')\n' + tail(result.output));
  }
  return result.output;
}

// ---------------------------------------------------------------------------
// Ports / HTTP
// ---------------------------------------------------------------------------

async function getFreePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}

async function fetchJson(url, options = {}, timeoutMs = 10_000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { __raw: text };
  }
  return { status: response.status, body, headers: response.headers };
}

async function waitForHealth(debugPort, boot, timeoutMs = HEALTH_TIMEOUT_MS) {
  const url = 'http://127.0.0.1:' + debugPort + '/health';
  const deadline = Date.now() + timeoutMs;
  let lastError;
  let exited = false;
  let exitResult;
  boot.exit.then((result) => {
    exited = true;
    exitResult = result;
  });
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        'dsh exited before the plugin debug endpoint answered /health (code ' +
          exitResult.code +
          ')\n' +
          tail(boot.output()),
      );
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        const body = await response.json();
        if (body && body.ok === true) {
          log('health OK at ' + url + ' after ' + ((Date.now() - boot.startedAt) / 1000).toFixed(1) + 's');
          return body;
        }
        lastError = new Error('unexpected /health body: ' + JSON.stringify(body));
      } else {
        lastError = new Error('/health answered HTTP ' + response.status);
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(
    'timed out after ' +
      timeoutMs +
      'ms waiting for ' +
      url +
      ' (last error: ' +
      (lastError instanceof Error ? lastError.message : String(lastError)) +
      ')\n' +
      tail(boot.output()),
  );
}

async function postSelftest(debugPort, text, timeoutMs = SELFTEST_TIMEOUT_MS) {
  const url = 'http://127.0.0.1:' + debugPort + '/selftest';
  log('POST ' + url + ' text=' + JSON.stringify(text));
  const started = Date.now();
  const { status, body } = await fetchJson(
    url,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ text }) },
    timeoutMs,
  );
  log('selftest answered HTTP ' + status + ' in ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
  return { status, body };
}

// ---------------------------------------------------------------------------
// Isolated environment
// ---------------------------------------------------------------------------

function profilePackageJson() {
  const linkSpec = 'link:' + PLUGIN_DIR.replace(/\\/g, '/');
  return (
    JSON.stringify(
      {
        name: 'dsh-profile-plugin-e2e',
        private: true,
        dependencies: { 'dsh-plugin-discord': linkSpec },
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plugin-discord'],
          },
        },
      },
      null,
      2,
    ) + '\n'
  );
}

function profilePatchYaml(workspace, debugHttpPort) {
  const workspacePosix = workspace.replace(/\\/g, '/');
  return [
    '# Isolated e2e overlay: mount the plugin, point the bridge at a throwaway',
    '# workspace, and enable its loopback self-test endpoint.',
    '- id: discord',
    '  name: dsh-plugin-discord',
    '  config:',
    '    runtime:',
    '      workspace: ' + workspacePosix,
    '      # Explicit fallback route: proves the plugin-config route reaches',
    '      # create/resume. The ctx.agentDefaultModel path is covered by the',
    '      # bridge unit tests, so the e2e does not depend on host defaults.',
    '      provider: deepseek-official',
    '      model: deepseek-flash',
    '    debugHttpPort: ' + debugHttpPort,
    '',
  ].join('\n');
}

async function ensureCredentials(sourceHome, targetHome) {
  const credentials = join(sourceHome, '.credentials.yaml');
  try {
    await stat(credentials);
  } catch {
    throw new Error(
      'missing ' + credentials + '; the e2e needs real model credentials copied into the throwaway home',
    );
  }
  await copyFile(credentials, join(targetHome, '.credentials.yaml'));
  const anonymousId = join(sourceHome, '.anonymous-user-id');
  try {
    await copyFile(anonymousId, join(targetHome, '.anonymous-user-id'));
  } catch {
    // optional: DSH generates a fresh identity when absent
  }
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensurePluginDependencies() {
  const discordJs = join(PLUGIN_DIR, 'node_modules', 'discord.js', 'package.json');
  const dshLlm = join(PLUGIN_DIR, 'node_modules', '@deepseek-ai', 'dsh-llm', 'package.json');
  if ((await fileExists(discordJs)) && (await fileExists(dshLlm))) return;
  const { pnpm } = resolveNodeAndPnpm();
  log('installing plugin dependencies (pnpm install in ' + PLUGIN_DIR + ')');
  await runPnpm(pnpm, ['install', '--reporter=append-only'], PLUGIN_DIR);
}

/**
 * Create the throwaway DSH home, profile and workspace, and make both pnpm
 * installs idempotent. Never writes outside the returned temp root.
 */
async function prepareIsolatedEnv(options = {}) {
  const debugHttpPort = options.debugHttpPort || (await getFreePort());
  const webPort = options.webPort || (await getFreePort());
  const reuseHome = process.env.DSH_PLUGIN_E2E_HOME ? resolve(process.env.DSH_PLUGIN_E2E_HOME) : null;
  const tempRoot = reuseHome || (await mkdtemp(join(tmpdir(), 'dsh-plugin-e2e-')));
  const home = join(tempRoot, 'home');
  const workspace = join(tempRoot, 'workspace');
  const profileDir = join(home, 'profiles', 'plugin-e2e');

  assertIsolatedHome(home);
  await mkdir(profileDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await ensureCredentials(REAL_DSH_HOME, home);

  await writeFile(join(profileDir, 'package.json'), profilePackageJson(), 'utf8');
  await writeFile(join(profileDir, 'cordis.yml'), '[]\n', 'utf8');
  await writeFile(
    join(profileDir, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
    'utf8',
  );
  await writeFile(join(profileDir, 'cordis.patch.yml'), profilePatchYaml(workspace, debugHttpPort), 'utf8');

  await ensurePluginDependencies();
  const { pnpm } = resolveNodeAndPnpm();
  log('pnpm install in isolated profile ' + profileDir);
  await runPnpm(pnpm, ['install', '--reporter=append-only'], profileDir);

  const keep = process.env.DSH_PLUGIN_E2E_KEEP === '1' || Boolean(reuseHome);
  log('isolated DSH home: ' + home);
  log('isolated workspace: ' + workspace);
  log('debug endpoint: http://127.0.0.1:' + debugHttpPort);

  return {
    tempRoot,
    home,
    workspace,
    profileDir,
    debugHttpPort,
    webPort,
    keep,
    async cleanup(success) {
      if (!success && !reuseHome) {
        log('run failed; keeping throwaway home for inspection: ' + tempRoot);
        return;
      }
      if (keep) {
        log('DSH_PLUGIN_E2E_KEEP=1; keeping throwaway home: ' + tempRoot);
        return;
      }
      await removeTempRoot(tempRoot);
      log('removed throwaway home ' + tempRoot);
    },
  };
}

async function removeTempRoot(dir) {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await sleep(400 * (attempt + 1));
    }
  }
  throw new Error('failed to remove ' + dir + ': ' + (lastError instanceof Error ? lastError.message : String(lastError)));
}

// ---------------------------------------------------------------------------
// Precheck: compose the profile without booting anything
// ---------------------------------------------------------------------------

async function precheckBundles(env) {
  log('precheck: dsh --profile plugin-e2e --dump-config');
  const output = await runDsh(['--profile', 'plugin-e2e', '--dump-config'], {
    cwd: env.workspace,
    home: env.home,
    timeoutMs: 180_000,
  });
  assert.match(output, /# == @deepseek-ai\/dsh-base/, 'base bundle missing from composed config');
  assert.match(output, /# == @deepseek-ai\/dsh-web-app/, 'web-app bundle missing from composed config');
  assert.match(output, /# == dsh-plugin-discord/, 'plugin bundle missing from composed config');
  assert.match(output, /- id: discord\n  name: dsh-plugin-discord/, 'discord entry missing from composed config');
  assert.match(
    output,
    new RegExp('debugHttpPort: ' + env.debugHttpPort),
    'profile patch did not reach the plugin config',
  );
  assert.ok(
    output.includes(env.workspace.replace(/\\/g, '/')),
    'profile patch did not set runtime.workspace to the throwaway workspace',
  );
  log('precheck OK: base + web-app + plugin composed; discord row patched');
  return output;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function bootDsh(env) {
  const dshArgs = [
    '--profile',
    'plugin-e2e',
    '--no-open',
    '--host',
    '127.0.0.1',
    '--port',
    String(env.webPort),
  ];
  const spec = dshCommandLine(dshArgs);
  const child = spawn(spec.command, spec.args, {
    cwd: env.workspace,
    env: { ...cleanEnv(env.home), ...spec.env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  let bytes = 0;
  const append = (chunk) => {
    bytes += chunk.length;
    chunks.push(chunk);
    while (bytes > 512 * 1024 && chunks.length > 0) {
      bytes -= chunks[0].length;
      chunks.shift();
    }
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const exit = new Promise((resolvePromise) => {
    child.once('error', (error) => resolvePromise({ code: -1, signal: null, error }));
    child.once('exit', (code, signal) => resolvePromise({ code, signal, error: null }));
  });
  const boot = {
    child,
    exit,
    startedAt: Date.now(),
    output: () => Buffer.concat(chunks).toString('utf8'),
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      log('stopping dsh (pid ' + child.pid + ')');
      killTree(child);
      await Promise.race([exit, delayUnref(20_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        log('dsh did not exit in 20s; forcing taskkill again');
        killTree(child);
        await Promise.race([exit, delayUnref(5000)]);
      }
    },
  };
  log('booting dsh: web http://127.0.0.1:' + env.webPort + ', debug http://127.0.0.1:' + env.debugHttpPort);
  return boot;
}

// ---------------------------------------------------------------------------
// Tests (skipped unless DSH_PLUGIN_E2E=1)
// ---------------------------------------------------------------------------

test(
  'precheck: isolated profile composes base + web-app + dsh-plugin-discord',
  { skip: ENABLED ? false : SKIP_REASON, timeout: 240_000 },
  async () => {
    const env = await prepareIsolatedEnv();
    let success = false;
    try {
      await precheckBundles(env);
      success = true;
    } finally {
      await env.cleanup(success);
    }
  },
);

test(
  'e2e: boot isolated DSH, wait for plugin /health, run /selftest through the real bridge',
  { skip: ENABLED ? false : SKIP_REASON, timeout: 600_000 },
  async () => {
    const env = await prepareIsolatedEnv();
    let boot;
    let success = false;
    try {
      boot = bootDsh(env);
      const health = await waitForHealth(env.debugHttpPort, boot);
      assert.equal(health.ok, true);

      if (HEALTH_ONLY) {
        log('DSH_PLUGIN_E2E_HEALTH_ONLY=1: plugin booted and /health is OK; skipping the model turn');
        await boot.stop();
        success = true;
        return;
      }

      const { status, body } = await postSelftest(env.debugHttpPort, SELFTEST_TEXT);
      assert.equal(status, 200, 'selftest HTTP status: ' + JSON.stringify(tail(JSON.stringify(body), 1200)));
      assert.equal(body.ok, true, 'selftest failed: ' + JSON.stringify(tail(JSON.stringify(body), 2000)));
      assert.match(String(body.reply || ''), new RegExp(SELFTEST_TOKEN), 'reply must contain ' + SELFTEST_TOKEN);
      assert.ok(typeof body.sessionId === 'string' && body.sessionId.length > 0, 'selftest must report a sessionId');
      log(
        'selftest OK: sessionId=' +
          body.sessionId +
          ' durationMs=' +
          body.durationMs +
          ' reply=' +
          JSON.stringify(String(body.reply).slice(0, 120)),
      );

      // The plugin persists its conversation -> session mapping inside the
      // isolated DSH home only; verify it landed there.
      const storePath = join(env.home, 'dsh-plugin-discord', 'sessions.json');
      let storeText = '';
      for (let attempt = 0; attempt < 20 && !storeText; attempt += 1) {
        await sleep(250);
        try {
          storeText = await readFile(storePath, 'utf8');
        } catch {
          storeText = '';
        }
      }
      if (storeText) {
        assert.ok(isWithin(storePath, env.home), 'session store escaped the isolated home');
        assert.ok(storeText.includes(body.sessionId), 'persisted session store should contain the selftest session id');
        log('session store OK: ' + storePath);
      } else {
        log('warning: session store not flushed to ' + storePath + ' before assertion window (non-fatal)');
      }

      await boot.stop();
      success = true;
    } finally {
      if (!success) {
        const logPath = join(env.tempRoot, 'dsh.log');
        try {
          await writeFile(logPath, boot ? boot.output() : '', 'utf8');
        } catch {
          // best effort
        }
        log('FAILED: throwaway DSH home kept for inspection at ' + env.home);
        log('FAILED: full DSH output written to ' + logPath);
        if (boot) process.stdout.write(tail(boot.output(), 12000) + '\n');
      }
      if (boot) await boot.stop();
      await env.cleanup(success);
    }
  },
);
