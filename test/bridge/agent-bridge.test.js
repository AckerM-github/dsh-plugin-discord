/**
 * Unit tests for lib/agent-bridge.js.
 *
 * The fake ctx supplies a real session/event event bus and a scriptable agents
 * registry, so these tests cover session resolution, run serialization, event
 * mapping, error recovery and plugin-owned disposal without any DSH host.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentBridge } from '../../lib/agent-bridge.js';
import { createFakeCtx, behavior, turnBehavior } from './fake-ctx.js';
import {
  createMemoryStore,
  createRecordingLogger,
  deferred,
  flushAsync,
  testMessageFactory,
} from './helpers.js';

function setup(options = {}) {
  const ctx = options.ctx || createFakeCtx(options.ctxOptions);
  const store = options.store || createMemoryStore(options.initialStore || {});
  const logger = options.logger || createRecordingLogger();
  const messageFactory = options.messageFactory === undefined ? testMessageFactory() : options.messageFactory;
  // Most tests need a complete route so fresh-session creation is allowed;
  // the no-route test opts out explicitly with config: {}.
  const config = options.config === undefined ? { provider: 'test-provider', model: 'test-model' } : options.config;
  const bridge = createAgentBridge({
    ctx,
    logger,
    config,
    sessionStore: store,
    ...(messageFactory ? { createUserMessage: messageFactory } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return { ctx, store, logger, bridge, messageFactory };
}

test('creates a fresh session with a minted id, meta.cwd and agentOptions', async () => {
  const { ctx, store, bridge } = setup({
    config: {
      workspace: 'E:/workspace',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'high',
      maxTokens: 2048,
    },
  });
  const result = await bridge.run('dm:1', { text: 'hi', conversationLabel: 'DM', userName: 'alice' });

  assert.match(result.sessionId, /^session-[0-9a-f]{32}$/);
  assert.equal(result.finalText, 'fake reply');
  assert.ok(result.durationMs >= 0);
  assert.equal(ctx.createCalls.length, 1);
  assert.equal(ctx.resumeCalls.length, 0);
  const create = ctx.createCalls[0];
  assert.equal(create.sessionId, result.sessionId);
  assert.deepEqual(create.meta, { cwd: 'E:/workspace' });
  assert.deepEqual(create.agentOptions, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
    maxTokens: 2048,
  });
  assert.equal(store.get('dm:1').sessionId, result.sessionId);
  assert.equal(bridge.status().liveSessions, 1);
  assert.equal(bridge.status().ready, true);

  const agent = ctx.agents.get(result.sessionId);
  assert.equal(agent.inbox.length, 1);
  const message = agent.inbox[0];
  assert.equal(message.role, 'user');
  assert.deepEqual(message.content, [{ type: 'text', text: 'hi' }]);
  assert.deepEqual(message.source, { kind: 'user' });
  assert.match(message.id, /^msg-test-/);
  await bridge.dispose();
});

test('reuses an in-memory session for later runs on the same key', async () => {
  const { ctx, bridge } = setup();
  await bridge.run('dm:2', { text: 'one' });
  await bridge.run('dm:2', { text: 'two' });
  assert.equal(ctx.createCalls.length, 1);
  assert.equal(ctx.resumeCalls.length, 0);
  assert.equal(bridge.status().liveSessions, 1);
  await bridge.dispose();
});

test('resumes a persisted session id instead of creating a new session', async () => {
  const ctx = createFakeCtx();
  const store = createMemoryStore({ 'dm:3': 'session-saved' });
  const { bridge } = setup({ ctx, store });
  const result = await bridge.run('dm:3', { text: 'continue' });

  assert.equal(result.sessionId, 'session-saved');
  assert.deepEqual(ctx.resumeCalls.map((call) => call.resumeSessionId), ['session-saved']);
  assert.equal(ctx.createCalls.length, 0);
  assert.equal(store.get('dm:3').sessionId, 'session-saved');
  assert.equal(ctx.agents.get('session-saved').inbox.length, 1);
  await bridge.dispose();
});

test('reuses a session already live in the host without owning it', async () => {
  const ctx = createFakeCtx();
  ctx.addLiveAgent('session-live');
  const store = createMemoryStore({ 'dm:4': 'session-live' });
  const { bridge } = setup({ ctx, store });

  const result = await bridge.run('dm:4', { text: 'ui session' });
  assert.equal(result.sessionId, 'session-live');
  assert.equal(ctx.createCalls.length, 0);
  assert.equal(ctx.resumeCalls.length, 0);

  await bridge.dispose();
  assert.equal(ctx.hasLiveAgent('session-live'), true, 'host-owned live agent must survive bridge disposal');
  assert.deepEqual(ctx.disposeCalls, []);
});

test('falls back to a fresh session when resume fails and overwrites the mapping', async () => {
  const ctx = createFakeCtx({ failResumeIds: ['session-gone'] });
  const store = createMemoryStore({ 'dm:5': 'session-gone' });
  const logger = createRecordingLogger();
  const { bridge } = setup({ ctx, store, logger });

  const result = await bridge.run('dm:5', { text: 'hi' });
  assert.notEqual(result.sessionId, 'session-gone');
  assert.deepEqual(ctx.resumeCalls.map((call) => call.resumeSessionId), ['session-gone']);
  assert.equal(ctx.createCalls.length, 1);
  assert.equal(store.get('dm:5').sessionId, result.sessionId);
  assert.ok(logger.records.some((record) => record.level === 'warn' && record.message.includes('resume failed')));
  await bridge.dispose();
});

test('falls back to the deployment default model selection', async () => {
  const ctx = createFakeCtx({
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'default-provider', model: 'default-model', reasoningEffort: 'max' }),
    },
  });
  const { bridge } = setup({ ctx, config: { maxTokens: 512 } });
  await bridge.run('dm:6', { text: 'hi' });
  assert.deepEqual(ctx.createCalls[0].agentOptions, {
    provider: 'default-provider',
    model: 'default-model',
    reasoningEffort: 'max',
    maxTokens: 512,
  });
  await bridge.dispose();
});

test('fails with an actionable error when no model route is available', async () => {
  const { ctx, bridge } = setup({ config: {} });
  await assert.rejects(
    bridge.run('dm:7', { text: 'hi' }),
    /no model route: configure runtime\.provider\/model or ensure agentDefaultModel is available/,
  );
  assert.equal(ctx.createCalls.length, 0, 'no agent may be created without a route');
  await bridge.dispose();
});

test('resolves agentDefaultModel through ctx.get when it is not exposed as a property', async () => {
  const ctx = createFakeCtx({
    services: {
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'service-provider', model: 'service-model', reasoningEffort: 'high' }),
      },
    },
  });
  assert.equal(ctx.agentDefaultModel, undefined, 'property shortcut is intentionally absent');
  const { bridge } = setup({ ctx, config: {} });
  const result = await bridge.run('dm:route', { text: 'hi' });
  assert.equal(result.finalText, 'fake reply');
  assert.deepEqual(ctx.createCalls[0].agentOptions, {
    provider: 'service-provider',
    model: 'service-model',
    reasoningEffort: 'high',
  });
  await bridge.dispose();
});

test('maps tool calls/results, assistant text and status transitions to the observer', async () => {
  const ctx = createFakeCtx();
  ctx.defaultBehavior = turnBehavior({
    tools: [
      { callId: 'call-1', name: 'pwsh', arguments: JSON.stringify({ command: 'Get-ChildItem -Force' }) },
      { callId: 'call-2', name: 'read', arguments: '{"file_path":"src/missing.ts"}', isError: true },
    ],
    assistant: 'done',
  });
  const { bridge } = setup({ ctx });
  const activities = [];
  const assistantTexts = [];
  const statuses = [];
  const result = await bridge.run('dm:8', { text: 'hi' }, {
    onActivity: (line) => activities.push(line),
    onAssistantText: (text) => assistantTexts.push(text),
    onStatus: (status) => statuses.push(status),
  });

  assert.deepEqual(activities, [
    '🛠 pwsh: Get-ChildItem -Force',
    '✅ pwsh 完成',
    '🛠 read: src/missing.ts',
    '⚠️ read 失败',
  ]);
  assert.deepEqual(assistantTexts, ['done']);
  assert.deepEqual(statuses, ['running', 'idle']);
  assert.equal(result.finalText, 'done');
  await bridge.dispose();
});

test('returns the last assistant text of the run interval', async () => {
  const ctx = createFakeCtx();
  ctx.defaultBehavior = behavior([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]);
  const { bridge } = setup({ ctx });
  const assistantTexts = [];
  const result = await bridge.run('dm:9', { text: 'hi' }, {
    onAssistantText: (text) => assistantTexts.push(text),
  });
  assert.deepEqual(assistantTexts, ['first', 'second']);
  assert.equal(result.finalText, 'second');
  await bridge.dispose();
});

test('ignores stale events that predate the run sequence watermark', async () => {
  const ctx = createFakeCtx();
  const { bridge, store } = setup({ ctx });
  const first = await bridge.run('dm:10', { text: 'one' });
  const agent = ctx.agents.get(first.sessionId);
  agent.emit('assistant/message', {
    message: { role: 'assistant', content: [{ type: 'text', text: 'stale text' }] },
  });
  ctx.behaviors.set(first.sessionId, turnBehavior({ assistant: 'fresh text' }));

  const assistantTexts = [];
  const result = await bridge.run('dm:10', { text: 'two' }, {
    onAssistantText: (text) => assistantTexts.push(text),
  });
  assert.deepEqual(assistantTexts, ['fresh text']);
  assert.equal(result.finalText, 'fresh text');
  assert.equal(store.get('dm:10').sessionId, first.sessionId);
  await bridge.dispose();
});

test('a turn/end error rejects the run but keeps the session usable', async () => {
  const ctx = createFakeCtx();
  ctx.defaultBehavior = behavior([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'quota exceeded', code: 'QUOTA' } } } },
  ]);
  const { bridge, store } = setup({ ctx });

  await assert.rejects(
    bridge.run('dm:11', { text: 'bad' }),
    (error) => error instanceof Error && error.message.includes('quota exceeded'),
  );
  const sessionId = store.get('dm:11').sessionId;
  ctx.behaviors.set(sessionId, turnBehavior({ assistant: 'recovered' }));
  const retry = await bridge.run('dm:11', { text: 'retry' });
  assert.equal(retry.sessionId, sessionId);
  assert.equal(retry.finalText, 'recovered');
  assert.equal(ctx.createCalls.length, 1);
  await bridge.dispose();
});

test('an agent/error event rejects the run but keeps the session usable', async () => {
  const ctx = createFakeCtx();
  ctx.defaultBehavior = async () => {
    throw new Error('model exploded');
  };
  const { bridge, store } = setup({ ctx });

  await assert.rejects(
    bridge.run('dm:12', { text: 'bad' }),
    (error) => error instanceof Error && error.message.includes('model exploded'),
  );
  const sessionId = store.get('dm:12').sessionId;
  ctx.behaviors.set(sessionId, turnBehavior({ assistant: 'after error' }));
  const retry = await bridge.run('dm:12', { text: 'retry' });
  assert.equal(retry.finalText, 'after error');
  assert.equal(ctx.createCalls.length, 1);
  await bridge.dispose();
});

test('a run timeout rejects, cancels the turn, and leaves the session usable', async () => {
  const ctx = createFakeCtx();
  const gate = deferred();
  ctx.defaultBehavior = async ({ agent }) => {
    agent.emit('turn/start', { turn: 1 });
    await gate.promise;
  };
  const { bridge, store } = setup({ ctx, config: { provider: 'test-provider', model: 'test-model', turnTimeoutMs: 30 } });

  await assert.rejects(bridge.run('dm:13', { text: 'slow' }), /超时/);
  const sessionId = store.get('dm:13').sessionId;
  const agent = ctx.agents.get(sessionId);
  assert.equal(agent.cancelled.length, 1);
  assert.deepEqual(agent.cancelled[0], { kind: 'user' });

  gate.resolve();
  await flushAsync();
  ctx.behaviors.set(sessionId, turnBehavior({ assistant: 'after timeout' }));
  const retry = await bridge.run('dm:13', { text: 'retry' });
  assert.equal(retry.finalText, 'after timeout');
  await bridge.dispose();
});

test('serializes runs for the same conversation key', async () => {
  const ctx = createFakeCtx();
  const order = [];
  const gates = [deferred(), deferred()];
  let index = 0;
  ctx.defaultBehavior = async ({ agent }) => {
    const current = index++;
    order.push('start:' + current);
    await gates[current].promise;
    agent.emit('assistant/message', {
      message: { role: 'assistant', content: [{ type: 'text', text: 'reply-' + current }] },
    });
    agent.emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
    order.push('end:' + current);
  };
  const { bridge } = setup({ ctx });

  const first = bridge.run('dm:14', { text: 'one' });
  await flushAsync();
  const second = bridge.run('dm:14', { text: 'two' });
  await flushAsync();
  assert.deepEqual(order, ['start:0']);

  gates[0].resolve();
  const firstResult = await first;
  await flushAsync();
  assert.deepEqual(order, ['start:0', 'end:0', 'start:1']);

  gates[1].resolve();
  const secondResult = await second;
  assert.equal(firstResult.finalText, 'reply-0');
  assert.equal(secondResult.finalText, 'reply-1');
  assert.equal(ctx.createCalls.length, 1);
  await bridge.dispose();
});

test('runs on different conversation keys execute concurrently', async () => {
  const ctx = createFakeCtx();
  const gates = [deferred(), deferred()];
  let started = 0;
  ctx.defaultBehavior = async ({ agent }) => {
    const current = started++;
    await gates[current].promise;
    agent.emit('assistant/message', {
      message: { role: 'assistant', content: [{ type: 'text', text: 'reply-' + current }] },
    });
    agent.emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
  };
  const { bridge } = setup({ ctx });

  const first = bridge.run('alpha:1', { text: 'a' });
  const second = bridge.run('beta:1', { text: 'b' });
  await flushAsync();
  assert.equal(started, 2, 'both conversations entered their agent concurrently');
  gates.forEach((gate) => gate.resolve());
  const results = await Promise.all([first, second]);
  assert.equal(results.length, 2);
  assert.notEqual(results[0].sessionId, results[1].sessionId);
  await bridge.dispose();
});

test('observer exceptions never fail a turn', async () => {
  const { bridge } = setup();
  const result = await bridge.run('dm:15', { text: 'hi' }, {
    onActivity: () => {
      throw new Error('observer bug');
    },
    onAssistantText: () => {
      throw new Error('observer bug');
    },
    onStatus: () => {
      throw new Error('observer bug');
    },
  });
  assert.equal(result.finalText, 'fake reply');
  await bridge.dispose();
});

test('reset deletes the mapping and disposes only owned sessions', async () => {
  const ctx = createFakeCtx();
  const store = createMemoryStore();
  const { bridge } = setup({ ctx, store });
  const first = await bridge.run('dm:16', { text: 'one' });
  assert.equal(bridge.status().liveSessions, 1);

  bridge.reset('dm:16');
  assert.equal(store.get('dm:16'), undefined);
  assert.equal(bridge.status().liveSessions, 0);
  await flushAsync();
  assert.deepEqual(ctx.disposeCalls, [first.sessionId]);

  const second = await bridge.run('dm:16', { text: 'two' });
  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal(ctx.createCalls.length, 2);
  await bridge.dispose();
});

test('reset never disposes a live session the plugin did not create', async () => {
  const ctx = createFakeCtx();
  ctx.addLiveAgent('session-host');
  const store = createMemoryStore({ 'dm:17': 'session-host' });
  const { bridge } = setup({ ctx, store });
  await bridge.run('dm:17', { text: 'host session' });

  bridge.reset('dm:17');
  await flushAsync();
  assert.equal(ctx.hasLiveAgent('session-host'), true);
  assert.deepEqual(ctx.disposeCalls, []);
  const fresh = await bridge.run('dm:17', { text: 'fresh' });
  assert.notEqual(fresh.sessionId, 'session-host');
  await bridge.dispose();
});

test('dispose releases subscriptions, disposed owned handles, flushes and rejects later runs', async () => {
  const ctx = createFakeCtx();
  const store = createMemoryStore();
  const { bridge } = setup({ ctx, store });
  const first = await bridge.run('dm:18', { text: 'one' });
  const second = await bridge.run('dm:19', { text: 'two' });

  await bridge.dispose();
  assert.deepEqual(ctx.disposeCalls.sort(), [first.sessionId, second.sessionId].sort());
  assert.equal(store.flushCalls, 1);
  assert.equal(ctx.listenerCount('session/event'), 0);
  assert.deepEqual(bridge.status(), { ready: false, liveSessions: 0 });
  await assert.rejects(bridge.run('dm:20', { text: 'later' }), /已关闭/);

  const flushesBefore = store.flushCalls;
  await bridge.dispose();
  assert.equal(store.flushCalls, flushesBefore, 'dispose is idempotent');
});

test('rejects invalid construction options', () => {
  assert.throws(() => createAgentBridge({}), /ctx is required/);
  assert.throws(
    () => createAgentBridge({ ctx: createFakeCtx() }),
    /sessionStore/,
  );
});

test('uses the official dsh-llm message factory when none is injected', async () => {
  const ctx = createFakeCtx();
  const store = createMemoryStore();
  const bridge = createAgentBridge({ ctx, logger: createRecordingLogger(), config: { provider: 'test-provider', model: 'test-model' }, sessionStore: store });
  const result = await bridge.run('dm:21', { text: 'official factory' });
  const agent = ctx.agents.get(result.sessionId);
  const message = agent.inbox[0];
  assert.equal(message.role, 'user');
  assert.deepEqual(message.content, [{ type: 'text', text: 'official factory' }]);
  assert.deepEqual(message.source, { kind: 'user' });
  assert.equal(typeof message.id, 'string');
  assert.ok(message.id.length > 0);
  await bridge.dispose();
});

test('falls back to a locally constructed message when the factory throws', async () => {
  const ctx = createFakeCtx();
  const store = createMemoryStore();
  const logger = createRecordingLogger();
  const bridge = createAgentBridge({
    ctx,
    logger,
    config: { provider: 'test-provider', model: 'test-model' },
    sessionStore: store,
    createUserMessage: () => {
      throw new Error('factory exploded');
    },
  });
  const result = await bridge.run('dm:21b', { text: 'local fallback' });
  const agent = ctx.agents.get(result.sessionId);
  const message = agent.inbox[0];
  assert.match(message.id, /^msg-[0-9a-f]+$/);
  assert.equal(message.role, 'user');
  assert.deepEqual(message.content, [{ type: 'text', text: 'local fallback' }]);
  assert.deepEqual(message.source, { kind: 'user' });
  assert.ok(logger.records.some((record) => record.level === 'warn' && record.message.includes('createUserMessage failed')));
  await bridge.dispose();
});

test('surfaces session creation failures as a readable error', async () => {
  const ctx = createFakeCtx({ failCreate: true });
  const { bridge } = setup({ ctx });
  await assert.rejects(bridge.run('dm:22', { text: 'hi' }), /无法创建 DSH 会话/);
  ctx.failCreate = false;
  const result = await bridge.run('dm:22', { text: 'retry' });
  assert.equal(result.finalText, 'fake reply');
  await bridge.dispose();
});

test('attaches created and resumed sessions to the workspace registry', async () => {
  const calls = [];
  const workspaceRegistry = {
    async resolveByPath(path) {
      calls.push('resolve:' + path);
      return {
        path,
        async attachSession(sessionId) {
          calls.push('attach:' + sessionId);
        },
      };
    },
  };
  const { ctx, bridge } = setup({
    config: { workspace: 'E:/workspace', provider: 'test-provider', model: 'test-model' },
    ctxOptions: { services: { workspaceRegistry } },
  });
  const first = await bridge.run('dm:1', { text: 'hi' });
  assert.deepEqual(calls, ['resolve:E:/workspace', 'attach:' + first.sessionId]);
  await bridge.dispose();
});

test('reconcileWorkspaces attaches every persisted session to its workspace', async () => {
  const attached = [];
  const workspaceRegistry = {
    async resolveByPath(path) {
      return { path, async attachSession(id) { attached.push(id); } };
    },
  };
  const store = createMemoryStore({ 'dm:1': 'session-aaa', 'dm:2': 'session-bbb' });
  const { bridge } = setup({
    config: { workspace: 'E:/workspace', provider: 'test-provider', model: 'test-model' },
    ctxOptions: { services: { workspaceRegistry } },
    store,
  });
  const examined = await bridge.reconcileWorkspaces();
  assert.equal(examined, 2);
  assert.deepEqual(attached.sort(), ['session-aaa', 'session-bbb']);
  await bridge.dispose();
});
