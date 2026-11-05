/**
 * Unit tests for the pure helpers exported by lib/agent-bridge.js.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_ACTIVITY_CHARS,
  clipLine,
  buildPromptText,
  resolveAgentOptions,
  summarizeToolArguments,
  textOfContent,
} from '../../lib/agent-bridge.js';
import { createFakeCtx } from './fake-ctx.js';

test('buildPromptText adds instructions and Discord context for raw input', () => {
  const text = buildPromptText(
    { text: 'hello', conversationLabel: 'guild:1', userName: 'alice' },
    { instructions: 'Be concise.', channelContext: true },
  );
  assert.equal(text, 'Be concise.\n[Discord 频道: guild:1 · 用户: alice]\nhello');
});

test('buildPromptText is idempotent with the plugin entry prompt builder', () => {
  const already = [
    'Be concise.',
    '[Discord 频道: guild:1 · 用户: alice]',
    'hello',
  ].join('\n');
  const text = buildPromptText(
    { text: already, conversationLabel: 'guild:1', userName: 'alice' },
    { instructions: 'Be concise.', channelContext: true },
  );
  assert.equal(text, already, 'pre-contextualized text must not be duplicated');
});

test('buildPromptText omits context when disabled and keeps plain text', () => {
  assert.equal(buildPromptText({ text: 'hello' }, {}), 'hello');
  assert.equal(
    buildPromptText({ text: 'hello', conversationLabel: 'x', userName: 'y' }, { channelContext: false }),
    'hello',
  );
});

test('resolveAgentOptions prefers the configured route', () => {
  const ctx = createFakeCtx({
    agentDefaultModel: { currentSelection: () => ({ provider: 'default-p', model: 'default-m', reasoningEffort: 'max' }) },
  });
  assert.deepEqual(
    resolveAgentOptions(ctx, {
      provider: 'configured-p',
      model: 'configured-m',
      reasoningEffort: 'high',
      maxTokens: 100,
    }),
    { provider: 'configured-p', model: 'configured-m', reasoningEffort: 'high', maxTokens: 100 },
  );
});

test('resolveAgentOptions falls back to the deployment default selection', () => {
  const ctx = createFakeCtx({
    agentDefaultModel: { currentSelection: () => ({ provider: 'default-p', model: 'default-m', reasoningEffort: 'max' }) },
  });
  assert.deepEqual(resolveAgentOptions(ctx, {}), {
    provider: 'default-p',
    model: 'default-m',
    reasoningEffort: 'max',
  });
});

test('resolveAgentOptions omits an unavailable route and ignores invalid caps', () => {
  const ctx = createFakeCtx();
  assert.equal(resolveAgentOptions(ctx, { maxTokens: 100 }), undefined);
  assert.equal(resolveAgentOptions(createFakeCtx({ agentDefaultModel: { currentSelection: () => undefined } }), {}), undefined);
  const withRoute = resolveAgentOptions(ctx, { provider: 'p', model: 'm', maxTokens: -5 });
  assert.deepEqual(withRoute, { provider: 'p', model: 'm' });
});

test('summarizeToolArguments picks tool-specific fields and clips', () => {
  assert.equal(summarizeToolArguments('pwsh', JSON.stringify({ command: 'Get-ChildItem' })), 'Get-ChildItem');
  assert.equal(summarizeToolArguments('read', '{"file_path":"src/index.js"}'), 'src/index.js');
  assert.equal(summarizeToolArguments('grep', '{"pattern":"TODO","path":"lib"}'), 'TODO');
  assert.equal(summarizeToolArguments('web_search', '{"query":["a","b"]}'), 'a, b');
  assert.equal(summarizeToolArguments('mystery', '{"description":"do a thing"}'), 'do a thing');
  assert.equal(summarizeToolArguments('mystery', 'not json'), 'not json');
  assert.equal(summarizeToolArguments('mystery', ''), '');
});

test('summarizeToolArguments bounds long summaries', () => {
  const summary = summarizeToolArguments('pwsh', JSON.stringify({ command: 'x'.repeat(500) }));
  assert.ok(summary.length <= 60);
  assert.ok(summary.endsWith('…'));
});

test('textOfContent keeps only visible text blocks', () => {
  assert.equal(
    textOfContent([
      { type: 'reasoning', text: 'secret' },
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]),
    'ab',
  );
  assert.equal(textOfContent(undefined), '');
  assert.equal(textOfContent([]), '');
});

test('clipLine collapses whitespace and bounds a line', () => {
  assert.equal(clipLine('  a\n b\tc  '), 'a b c');
  assert.equal(clipLine('x'.repeat(MAX_ACTIVITY_CHARS + 10)).length, MAX_ACTIVITY_CHARS);
});
