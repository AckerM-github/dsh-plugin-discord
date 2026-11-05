import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PluginConfigError, resolvePluginConfig, resolveRuntimeOptions } from '../../lib/config.js';

test('applies defaults', () => {
  const config = resolvePluginConfig({});
  assert.equal(config.channelContext, true);
  assert.equal(config.activityUpdates, true);
  assert.equal(config.typingIndicator, true);
  assert.equal(config.maxPromptChars, 20000);
  assert.equal(config.debugHttpPort, 0);
  assert.deepEqual(config.rateLimit, { windowMs: 10000, maxMessages: 8 });
  assert.deepEqual(config.discord, {});
  assert.deepEqual(config.runtime, {});
});

test('passes the discord block through untouched', () => {
  const config = resolvePluginConfig({ discord: { token: 'env:FOO', unknownToDiscord: 1 } });
  assert.deepEqual(config.discord, { token: 'env:FOO', unknownToDiscord: 1 });
});

test('resolves runtime options and requires provider+model together', () => {
  const config = resolvePluginConfig({ runtime: { workspace: 'E:/work', provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 4096 } });
  assert.deepEqual(config.runtime, { workspace: 'E:/work', provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 4096 });
  assert.throws(() => resolvePluginConfig({ runtime: { provider: 'deepseek-official' } }), PluginConfigError);
});

test('rejects unknown top-level keys', () => {
  assert.throws(() => resolvePluginConfig({ unknownKey: true }), (error) => {
    assert.ok(error instanceof PluginConfigError);
    assert.ok(error.issues.some((issue) => issue.includes('unknownKey')));
    return true;
  });
});

test('validates numeric and boolean fields', () => {
  assert.throws(() => resolvePluginConfig({ debugHttpPort: 70000 }), PluginConfigError);
  assert.throws(() => resolvePluginConfig({ activityIntervalMs: 10 }), PluginConfigError);
  assert.throws(() => resolvePluginConfig({ channelContext: 'yes' }), PluginConfigError);
  assert.throws(() => resolvePluginConfig({ rateLimit: { maxMessages: 0 } }), PluginConfigError);
});

test('accepts explicit values', () => {
  const config = resolvePluginConfig({
    channelContext: false,
    instructions: 'Answer in Chinese',
    debugHttpPort: 1234,
    activityIntervalMs: 2000,
    rateLimit: { windowMs: 5000, maxMessages: 3 },
  });
  assert.equal(config.channelContext, false);
  assert.equal(config.instructions, 'Answer in Chinese');
  assert.equal(config.debugHttpPort, 1234);
  assert.equal(config.activityIntervalMs, 2000);
  assert.deepEqual(config.rateLimit, { windowMs: 5000, maxMessages: 3 });
});

test('resolveRuntimeOptions reports type problems without throwing', () => {
  const issues = [];
  const out = resolveRuntimeOptions({ workspace: 42, provider: 'p', model: 'm' }, issues);
  assert.deepEqual(out, { provider: 'p', model: 'm' });
  assert.ok(issues.some((issue) => issue.includes('workspace')));
});

test('accepts an http(s) proxy URL and rejects malformed ones', () => {
  assert.equal(resolvePluginConfig({ proxy: 'http://127.0.0.1:7890' }).proxy, 'http://127.0.0.1:7890');
  assert.throws(() => resolvePluginConfig({ proxy: 'socks5://127.0.0.1:7890' }), PluginConfigError);
  assert.throws(() => resolvePluginConfig({ proxy: 'not-a-url' }), PluginConfigError);
  assert.throws(() => resolvePluginConfig({ proxy: 42 }), PluginConfigError);
});

test('accepts a tokenFile path and rejects non-string values', () => {
  const config = resolvePluginConfig({ tokenFile: 'C:/Users/me/.dsh/dsh-plugin-discord/token.txt' });
  assert.equal(config.tokenFile, 'C:/Users/me/.dsh/dsh-plugin-discord/token.txt');
  assert.throws(() => resolvePluginConfig({ tokenFile: 42 }), PluginConfigError);
});
