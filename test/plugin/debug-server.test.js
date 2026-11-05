import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDebugServer } from '../../lib/debug-server.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function createBridge(handler) {
  return {
    async run(conversationId, input, observer) {
      return handler(conversationId, input, observer);
    },
  };
}

async function start(handler) {
  const bridge = createBridge(handler);
  const server = startDebugServer({ port: 0, bridge, logger });
  const info = await server.ready;
  return { server, info };
}

test('health endpoint answers ok', async () => {
  const { server, info } = await start(async () => ({ sessionId: 's', finalText: 'x', durationMs: 1 }));
  try {
    const response = await fetch(info.url + '/health');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await server.close();
  }
});

test('selftest runs the bridge and returns the reply', async () => {
  let seen;
  const { server, info } = await start(async (conversationId, input) => {
    seen = { conversationId, input };
    return { sessionId: 'session-debug', finalText: 'REPLY_OK', durationMs: 12 };
  });
  try {
    const response = await fetch(info.url + '/selftest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, reply: 'REPLY_OK', sessionId: 'session-debug', durationMs: 12 });
    assert.equal(seen.conversationId, 'debug:selftest');
    assert.equal(seen.input.text, 'hello');
  } finally {
    await server.close();
  }
});

test('selftest validates the body and reports bridge failures', async () => {
  const { server, info } = await start(async () => {
    throw new Error('boom');
  });
  try {
    const bad = await fetch(info.url + '/selftest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    assert.equal(bad.status, 400);

    const failed = await fetch(info.url + '/selftest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(failed.status, 500);
    const payload = await failed.json();
    assert.equal(payload.ok, false);
    assert.match(payload.error, /boom/);
  } finally {
    await server.close();
  }
});

test('unknown routes are 404', async () => {
  const { server, info } = await start(async () => ({ sessionId: 's', finalText: 'x', durationMs: 1 }));
  try {
    const response = await fetch(info.url + '/nope');
    assert.equal(response.status, 404);
  } finally {
    await server.close();
  }
});
