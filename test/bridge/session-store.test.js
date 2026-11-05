/**
 * Unit tests for lib/session-store.js: persistence, debouncing, atomic writes,
 * corrupt-file tolerance, and cross-restart integration with the bridge.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionStore } from '../../lib/session-store.js';
import { createAgentBridge } from '../../lib/agent-bridge.js';
import { createFakeCtx } from './fake-ctx.js';
import { createRecordingLogger, flushAsync, testMessageFactory } from './helpers.js';

async function tempStorePath(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-plugin-discord-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'sessions.json');
}

test('persists mappings through flush and reloads them', async (t) => {
  const filePath = await tempStorePath(t);
  const store = createSessionStore({ filePath, flushDelayMs: 1000 });
  store.set('dm:1', 'session-a', { conversationLabel: 'DM' });
  store.set('guild:2', 'session-b');
  assert.equal(store.get('dm:1').sessionId, 'session-a');
  assert.equal(store.get('guild:2').sessionId, 'session-b');
  await store.flush();

  const raw = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.sessions['dm:1'].sessionId, 'session-a');
  assert.equal(raw.sessions['dm:1'].meta.conversationLabel, 'DM');

  const reloaded = createSessionStore({ filePath });
  assert.equal(reloaded.get('dm:1').sessionId, 'session-a');
  assert.equal(reloaded.get('guild:2').sessionId, 'session-b');
  assert.equal(reloaded.get('missing'), undefined);
  assert.equal(existsSync(filePath + '.tmp'), false, 'atomic temp file must be renamed away');
  await reloaded.flush();
});

test('writes are debounced without an explicit flush', async (t) => {
  const filePath = await tempStorePath(t);
  const store = createSessionStore({ filePath, flushDelayMs: 10 });
  store.set('dm:2', 'session-c');
  assert.equal(existsSync(filePath), false);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const reloaded = createSessionStore({ filePath });
  assert.equal(reloaded.get('dm:2').sessionId, 'session-c');
  await reloaded.flush();
});

test('delete removes a mapping on disk', async (t) => {
  const filePath = await tempStorePath(t);
  const store = createSessionStore({ filePath, flushDelayMs: 0 });
  store.set('dm:3', 'session-d');
  await store.flush();
  store.delete('dm:3');
  await store.flush();
  const reloaded = createSessionStore({ filePath });
  assert.equal(reloaded.get('dm:3'), undefined);
  assert.equal(reloaded.size, 0);
});

test('tolerates a corrupt JSON file and replaces it on the next write', async (t) => {
  const filePath = await tempStorePath(t);
  await writeFile(filePath, '{ this is not json', 'utf8');
  const logger = createRecordingLogger();
  const store = createSessionStore({ filePath, logger });
  assert.equal(store.get('dm:4'), undefined);
  assert.ok(logger.records.some((record) => record.level === 'warn' && record.message.includes('not valid JSON')));

  store.set('dm:4', 'session-e');
  await store.flush();
  const reloaded = createSessionStore({ filePath });
  assert.equal(reloaded.get('dm:4').sessionId, 'session-e');
  await reloaded.flush();
});

test('tolerates an unknown document shape', async (t) => {
  const filePath = await tempStorePath(t);
  await writeFile(filePath, JSON.stringify({ version: 99, sessions: [] }), 'utf8');
  const logger = createRecordingLogger();
  const store = createSessionStore({ filePath, logger });
  assert.equal(store.size, 0);
  assert.ok(logger.records.some((record) => record.level === 'warn' && record.message.includes('unknown shape')));
  await store.flush();
});

test('validates constructor and setter arguments', async (t) => {
  assert.throws(() => createSessionStore({}), /filePath/);
  const filePath = await tempStorePath(t);
  const store = createSessionStore({ filePath });
  assert.throws(() => store.set('', 'session-x'), /key/);
  assert.throws(() => store.set('dm:5', ''), /sessionId/);
  assert.equal(store.get(''), undefined);
  store.delete('');
  await store.flush();
});

test('merges meta across updates', async (t) => {
  const filePath = await tempStorePath(t);
  const store = createSessionStore({ filePath });
  store.set('dm:6', 'session-f', { conversationLabel: 'label' });
  store.set('dm:6', 'session-g', { userName: 'alice' });
  assert.deepEqual(store.get('dm:6'), {
    sessionId: 'session-g',
    updatedAt: store.get('dm:6').updatedAt,
    meta: { conversationLabel: 'label', userName: 'alice' },
  });
  await store.flush();
});

test('a session mapping survives a bridge restart and resumes the stored session', async (t) => {
  const filePath = await tempStorePath(t);
  const firstStore = createSessionStore({ filePath });
  const firstCtx = createFakeCtx();
  const firstBridge = createAgentBridge({
    ctx: firstCtx,
    logger: createRecordingLogger(),
    config: { provider: 'test-provider', model: 'test-model' },
    sessionStore: firstStore,
    createUserMessage: testMessageFactory(),
  });
  const first = await firstBridge.run('dm:restart', { text: 'one' });
  await firstBridge.dispose();
  assert.equal(firstStore.get('dm:restart').sessionId, first.sessionId);
  const persisted = createSessionStore({ filePath });
  assert.equal(persisted.get('dm:restart').sessionId, first.sessionId);

  const secondStore = createSessionStore({ filePath });
  const secondCtx = createFakeCtx();
  const secondBridge = createAgentBridge({
    ctx: secondCtx,
    logger: createRecordingLogger(),
    config: { provider: 'test-provider', model: 'test-model' },
    sessionStore: secondStore,
    createUserMessage: testMessageFactory(),
  });
  const second = await secondBridge.run('dm:restart', { text: 'two' });
  assert.equal(second.sessionId, first.sessionId);
  assert.deepEqual(secondCtx.resumeCalls.map((call) => call.resumeSessionId), [first.sessionId]);
  assert.equal(secondCtx.createCalls.length, 0);
  await secondBridge.dispose();
  await flushAsync();
});

test('entries() returns every persisted mapping for reconciliation', async (t) => {
  const filePath = await tempStorePath(t);
  const store = createSessionStore({ filePath, flushDelayMs: 1000 });
  store.set('dm:1', 'session-a', { conversationLabel: 'DM' });
  store.set('dm:2', 'session-b');
  const entries = store.entries();
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.key).sort(), ['dm:1', 'dm:2']);
  assert.deepEqual(entries.find((entry) => entry.key === 'dm:1').meta, { conversationLabel: 'DM' });
  await store.flush();
});
