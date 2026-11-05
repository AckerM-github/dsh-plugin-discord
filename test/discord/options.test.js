import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  DISCORD_DEFAULTS,
  DiscordOptionsError,
  resolveDiscordOptions,
} from '../../lib/discord/options.js';

const baseOptions = { token: 'test-token' };

test('resolveDiscordOptions fills every default', () => {
  const options = resolveDiscordOptions(baseOptions, { env: {} });
  assert.equal(options.token, 'test-token');
  assert.equal(options.applicationId, undefined);
  assert.equal(options.requireMentionInGuild, DISCORD_DEFAULTS.requireMentionInGuild);
  assert.equal(options.sessionScope, 'thread');
  assert.equal(options.commandPrefix, '!');
  assert.deepEqual(options.allowGuilds, []);
  assert.deepEqual(options.allowChannels, []);
  assert.deepEqual(options.allowUsers, []);
  assert.deepEqual(options.attachments, { enabled: true, maxBytes: 8 * 1024 * 1024, maxCount: 4 });
  assert.equal(options.registerSlashCommands, true);
  assert.deepEqual(options.reply, { typingIndicator: true, activityUpdates: true });
  assert.equal(options.readyTimeoutMs, 30000);
  assert.deepEqual(options.unknownKeys, []);
  assert.equal(options.stateDir, join(homedir(), '.dsh', 'dsh-plugin-discord'));
});

test('resolveDiscordOptions accepts custom values from plugin config', () => {
  const options = resolveDiscordOptions(
    {
      token: 'abc.def',
      applicationId: '111111111111111111',
      stateDir: 'C:/tmp/state',
      requireMentionInGuild: false,
      sessionScope: 'channel',
      commandPrefix: '?',
      allowGuilds: ['111111111111111111'],
      allowChannels: ['222222222222222222'],
      allowUsers: ['333333333333333333'],
      attachments: { enabled: false, maxBytes: 4096, maxCount: 2 },
      registerSlashCommands: false,
      reply: { typingIndicator: false, activityUpdates: false },
      readyTimeoutMs: 5000,
    },
    { env: {} },
  );
  assert.equal(options.applicationId, '111111111111111111');
  assert.equal(options.stateDir, 'C:/tmp/state');
  assert.equal(options.requireMentionInGuild, false);
  assert.equal(options.sessionScope, 'channel');
  assert.equal(options.commandPrefix, '?');
  assert.deepEqual(options.allowGuilds, ['111111111111111111']);
  assert.deepEqual(options.allowChannels, ['222222222222222222']);
  assert.deepEqual(options.allowUsers, ['333333333333333333']);
  assert.deepEqual(options.attachments, { enabled: false, maxBytes: 4096, maxCount: 2 });
  assert.equal(options.registerSlashCommands, false);
  assert.deepEqual(options.reply, { typingIndicator: false, activityUpdates: false });
  assert.equal(options.readyTimeoutMs, 5000);
});

test('token falls back to DISCORD_BOT_TOKEN', () => {
  const options = resolveDiscordOptions({}, { env: { DISCORD_BOT_TOKEN: 'from-env-token' } });
  assert.equal(options.token, 'from-env-token');
  const empty = resolveDiscordOptions({ token: '   ' }, { env: { DISCORD_BOT_TOKEN: 'from-env-token' } });
  assert.equal(empty.token, 'from-env-token');
});

test('token can be supplied as an env reference', () => {
  const options = resolveDiscordOptions(
    { token: 'env:DSH_PLUGIN_TEST_TOKEN' },
    { env: { DSH_PLUGIN_TEST_TOKEN: 'resolved-token' } },
  );
  assert.equal(options.token, 'resolved-token');
});

test('env references resolve from process.env when the plugin entry calls with one argument', (t) => {
  process.env.DSH_PLUGIN_PROCESS_TOKEN = 'process-token';
  t.after(() => {
    delete process.env.DSH_PLUGIN_PROCESS_TOKEN;
  });
  const options = resolveDiscordOptions({ token: 'env:DSH_PLUGIN_PROCESS_TOKEN' });
  assert.equal(options.token, 'process-token');
});

test('missing token throws a clear option error', () => {
  for (const raw of [{}, { token: '' }, { token: '   ' }]) {
    assert.throws(
      () => resolveDiscordOptions(raw, { env: {} }),
      (error) => {
        assert.ok(error instanceof DiscordOptionsError);
        assert.equal(error.option, 'token');
        assert.match(error.message, /token/);
        return true;
      },
    );
  }
});

test('unresolved env reference names the environment variable', () => {
  assert.throws(
    () => resolveDiscordOptions({ token: 'env:DSH_PLUGIN_TEST_MISSING_TOKEN' }, { env: {} }),
    (error) => {
      assert.ok(error instanceof DiscordOptionsError);
      assert.equal(error.option, 'token');
      assert.match(error.message, /DSH_PLUGIN_TEST_MISSING_TOKEN/);
      return true;
    },
  );
});

test('stateDir resolves from config, context and DSH_HOME fallbacks', () => {
  assert.equal(resolveDiscordOptions({ token: 'x', stateDir: 'C:/a' }, { env: {} }).stateDir, 'C:/a');
  assert.equal(resolveDiscordOptions({ token: 'x' }, { env: {}, stateDir: 'C:/b' }).stateDir, 'C:/b');
  assert.equal(
    resolveDiscordOptions({ token: 'x' }, { env: { DSH_HOME: 'C:/dsh-home' } }).stateDir,
    join('C:/dsh-home', 'dsh-plugin-discord'),
  );
  assert.throws(
    () => resolveDiscordOptions({ token: 'x', stateDir: 42 }, { env: {} }),
    (error) => error instanceof DiscordOptionsError && error.option === 'stateDir',
  );
});

test('non-object options are rejected', () => {
  for (const raw of [undefined, null, 42, 'token', []]) {
    assert.throws(() => resolveDiscordOptions(raw, { env: {} }), DiscordOptionsError);
  }
});

test('unknown top-level keys are reported but tolerated', () => {
  const options = resolveDiscordOptions({ token: 'x', bogus: true }, { env: {} });
  assert.deepEqual(options.unknownKeys, ['bogus']);
});

test('plugin-entry display flags override reply flags and resolved options round-trip cleanly', () => {
  const resolved = resolveDiscordOptions({ token: 'x' }, { env: {} });
  const merged = resolveDiscordOptions(
    {
      ...resolved,
      typingIndicator: false,
      activityUpdates: false,
    },
    { env: {} },
  );
  assert.equal(merged.reply.typingIndicator, false);
  assert.equal(merged.reply.activityUpdates, false);
  assert.deepEqual(merged.unknownKeys, []);
  assert.equal(merged.token, 'x');
});

test('unknown nested keys are rejected', () => {
  assert.throws(
    () => resolveDiscordOptions({ token: 'x', attachments: { enabled: true, foo: 1 } }, { env: {} }),
    (error) => {
      assert.ok(error instanceof DiscordOptionsError);
      assert.equal(error.option, 'attachments.foo');
      return true;
    },
  );
  assert.throws(
    () => resolveDiscordOptions({ token: 'x', reply: { typingIndicator: true, extra: false } }, { env: {} }),
    (error) => {
      assert.ok(error instanceof DiscordOptionsError);
      assert.equal(error.option, 'reply.extra');
      return true;
    },
  );
});

test('invalid scalar values are rejected with option paths', () => {
  const cases = [
    [{ token: 'x', sessionScope: 'guild' }, 'sessionScope'],
    [{ token: 'x', commandPrefix: '' }, 'commandPrefix'],
    [{ token: 'x', commandPrefix: 'a b' }, 'commandPrefix'],
    [{ token: 'x', commandPrefix: 'toolong' }, 'commandPrefix'],
    [{ token: 'x', requireMentionInGuild: 'yes' }, 'requireMentionInGuild'],
    [{ token: 'x', registerSlashCommands: 1 }, 'registerSlashCommands'],
    [{ token: 'x', readyTimeoutMs: 10 }, 'readyTimeoutMs'],
    [{ token: 'x', readyTimeoutMs: 999999 }, 'readyTimeoutMs'],
    [{ token: 'x', applicationId: 'not-a-snowflake' }, 'applicationId'],
    [{ token: 'x', attachments: { enabled: 'true' } }, 'attachments.enabled'],
    [{ token: 'x', attachments: { maxBytes: 100 } }, 'attachments.maxBytes'],
    [{ token: 'x', attachments: { maxCount: 11 } }, 'attachments.maxCount'],
    [{ token: 'x', reply: { activityUpdates: 'no' } }, 'reply.activityUpdates'],
  ];
  for (const [raw, expectedPath] of cases) {
    assert.throws(
      () => resolveDiscordOptions(raw, { env: {} }),
      (error) => {
        assert.ok(error instanceof DiscordOptionsError);
        assert.equal(error.option, expectedPath);
        return true;
      },
    );
  }
});

test('allowlists accept arrays, numbers, comma strings and de-duplicate', () => {
  const options = resolveDiscordOptions(
    {
      token: 'x',
      allowGuilds: '111, 222 ,111',
      allowChannels: ['333', 444, '333'],
      allowUsers: [],
    },
    { env: {} },
  );
  assert.deepEqual(options.allowGuilds, ['111', '222']);
  assert.deepEqual(options.allowChannels, ['333', '444']);
  assert.deepEqual(options.allowUsers, []);
});

test('allowlists reject malformed values', () => {
  assert.throws(
    () => resolveDiscordOptions({ token: 'x', allowGuilds: { id: '1' } }, { env: {} }),
    (error) => error instanceof DiscordOptionsError && error.option === 'allowGuilds',
  );
  assert.throws(
    () => resolveDiscordOptions({ token: 'x', allowUsers: [''] }, { env: {} }),
    (error) => error instanceof DiscordOptionsError && error.option === 'allowUsers',
  );
});

test('applicationId accepts numbers and numeric strings', () => {
  assert.equal(resolveDiscordOptions({ token: 'x', applicationId: 123 }, { env: {} }).applicationId, '123');
  assert.equal(resolveDiscordOptions({ token: 'x', applicationId: ' 456 ' }, { env: {} }).applicationId, '456');
});
