import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DiscordOptionsError,
  createDiscordChannel,
  resolveDiscordOptions,
} from '../../lib/discord/index.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function createTestLogger() {
  const entries = [];
  const logger = {
    debug(message, meta) {
      entries.push({ level: 'debug', message, meta });
    },
    info(message, meta) {
      entries.push({ level: 'info', message, meta });
    },
    warn(message, meta) {
      entries.push({ level: 'warn', message, meta });
    },
    error(message, error, meta) {
      entries.push({ level: 'error', message, error, meta });
    },
    child() {
      return logger;
    },
  };
  return { logger, entries };
}

function createSilentLogger() {
  const noop = () => undefined;
  const logger = { debug: noop, info: noop, warn: noop, error: noop };
  logger.child = () => logger;
  return logger;
}

let sentCounter = 0;

class FakeSent {
  constructor(id, content) {
    this.id = id;
    this.content = content;
    this.edits = [];
    this.deleted = false;
    this.editError = null;
  }

  async edit(content) {
    if (this.editError) throw this.editError;
    this.edits.push(content);
    this.content = content;
    return this;
  }

  async delete() {
    this.deleted = true;
  }
}

class FakeChannel {
  constructor(options) {
    this.id = options.id;
    this.name = options.name || 'general';
    this.parentId = options.parentId || null;
    this.dm = Boolean(options.dm);
    this.thread = Boolean(options.thread);
    this.sent = [];
    this.typingCount = 0;
  }

  isDMBased() {
    return this.dm;
  }

  isThread() {
    return this.thread;
  }

  async send(content) {
    sentCounter += 1;
    const message = new FakeSent('sent-' + sentCounter, content);
    this.sent.push(message);
    return message;
  }

  async sendTyping() {
    this.typingCount += 1;
  }
}

class FakeClient {
  constructor() {
    this.user = { id: 'bot-1', username: 'dsh-bot' };
    this.application = {
      id: 'app-1',
      commands: {
        set: async (commands) => {
          this.registeredCommands = commands;
          return new Map();
        },
      },
    };
    this.registeredCommands = null;
    this.loginToken = null;
    this.loginCalls = 0;
    this.destroyed = false;
    this.ready = false;
    this.handlers = new Map();
  }

  async login(token) {
    this.loginCalls += 1;
    this.loginToken = token;
    this.ready = true;
    return token;
  }

  isReady() {
    return this.ready;
  }

  on(event, handler) {
    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  once(event, handler) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      handler(...args);
    };
    return this.on(event, wrapper);
  }

  off(event, handler) {
    const list = this.handlers.get(event);
    if (list) {
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    }
    return this;
  }

  emit(event, ...args) {
    const list = this.handlers.get(event) || [];
    for (const handler of [...list]) handler(...args);
  }

  async destroy() {
    this.destroyed = true;
  }
}

function makeConfig(stateDir, overrides = {}) {
  return { token: 'test-token', stateDir, ...overrides };
}

async function setup(t, input = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-plugin-discord-channel-'));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });
  const client = new FakeClient();
  const config = makeConfig(stateDir, input.config || {});
  const { logger, entries } = createTestLogger();
  const inbounds = [];
  const onMessage =
    input.onMessage ||
    ((inbound) => {
      inbounds.push(inbound);
    });
  const channel = createDiscordChannel({
    config,
    logger,
    onMessage,
    clientFactory: () => client,
    fetchImpl: input.fetchImpl,
    now: () => 1700000000000,
    env: input.env || {},
  });
  t.after(async () => {
    await channel.stop();
  });
  await channel.start();
  return { channel, client, config, inbounds, logger: entries, stateDir };
}

function fakeMessage(input) {
  const channel = input.channel;
  const dm = channel.dm;
  const message = {
    id: 'message-1',
    content: input.content || '',
    author: input.author || {
      id: 'user-1',
      username: 'alice',
      globalName: 'Alice',
      displayName: 'Alice',
      bot: false,
    },
    guildId: input.guildId === undefined ? (dm ? null : 'guild-1') : input.guildId,
    guild: input.guild === undefined ? (dm ? null : { id: 'guild-1', name: 'Guild One' }) : input.guild,
    channelId: channel.id,
    channel,
    mentions: { users: input.mentions || new Map() },
    attachments: input.attachments || new Map(),
    system: false,
    webhookId: null,
    createdTimestamp: 1700000000000,
  };
  return { ...message, ...(input.overrides || {}) };
}

function fakeFetch(bytes, calls) {
  return async (input) => {
    if (calls) calls.push(String(input));
    return {
      ok: true,
      status: 200,
      headers: {
        get() {
          return null;
        },
      },
      body: null,
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  };
}

class FakeInteraction {
  constructor(subcommand, channel) {
    this.commandName = 'dsh';
    this.guildId = 'guild-1';
    this.guild = { id: 'guild-1', name: 'Guild One' };
    this.user = { id: 'user-1', username: 'alice', globalName: 'Alice', displayName: 'Alice' };
    this.channel = channel;
    this.channelId = channel.id;
    this.deferred = false;
    this.replied = false;
    this.deferOptions = [];
    this.replies = [];
    this.edits = [];
    this.follows = [];
    this.subcommand = subcommand;
    this.options = {
      getSubcommand: () => this.subcommand,
    };
  }

  isChatInputCommand() {
    return true;
  }

  async deferReply(options) {
    this.deferred = true;
    this.deferOptions.push(options);
  }

  async editReply(content) {
    this.edits.push(content);
    return new FakeSent('interaction-reply-1', content);
  }

  async followUp(payload) {
    this.follows.push(payload);
    return new FakeSent('interaction-reply-2', payload.content);
  }

  async reply(payload) {
    this.replies.push(payload);
  }

  async deleteReply() {
    this.replyDeleted = true;
  }
}

async function waitFor(predicate, label) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2000) throw new Error('timed out waiting for ' + label);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('createDiscordChannel exposes start/stop/client and rejects bad options', () => {
  assert.throws(() => createDiscordChannel(), TypeError);
  assert.throws(() => createDiscordChannel({ logger: console }), /onMessage/);
  const channel = createDiscordChannel({
    config: { token: 'x' },
    logger: createSilentLogger(),
    onMessage: () => undefined,
    clientFactory: () => new FakeClient(),
  });
  assert.equal(channel.client, null);
  assert.equal(typeof channel.start, 'function');
  assert.equal(typeof channel.stop, 'function');
});

test('start logs in, registers /dsh and exposes the client', async (t) => {
  const { channel, client } = await setup(t);
  assert.equal(client.loginToken, 'test-token');
  assert.ok(client.registeredCommands);
  assert.equal(client.registeredCommands[0].name, 'dsh');
  assert.equal(channel.client, client);
});

test('start validates options before constructing a client', async () => {
  let factoryCalls = 0;
  const channel = createDiscordChannel({
    config: {},
    logger: createSilentLogger(),
    onMessage: () => undefined,
    env: {},
    clientFactory: () => {
      factoryCalls += 1;
      return new FakeClient();
    },
  });
  await assert.rejects(() => channel.start(), DiscordOptionsError);
  assert.equal(factoryCalls, 0);
  assert.equal(channel.client, null);
});

test('missing token falls back to DISCORD_BOT_TOKEN', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-plugin-discord-env-'));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });
  const client = new FakeClient();
  const channel = createDiscordChannel({
    config: { stateDir },
    logger: createSilentLogger(),
    onMessage: () => undefined,
    clientFactory: () => client,
    env: { DISCORD_BOT_TOKEN: 'env-token' },
  });
  t.after(async () => {
    await channel.stop();
  });
  await channel.start();
  assert.equal(client.loginToken, 'env-token');
});

test('stop destroys the client and is idempotent', async (t) => {
  const { channel, client } = await setup(t);
  await channel.stop();
  assert.equal(client.destroyed, true);
  await channel.stop();
  assert.equal(client.destroyed, true);
});

test('start is idempotent', async (t) => {
  const { channel, client } = await setup(t);
  await channel.start();
  assert.equal(client.loginCalls, 1);
});

test('unknown config keys are tolerated and logged as warnings', async (t) => {
  const { logger } = await setup(t, { config: { bogus: true } });
  assert.ok(
    logger.some((entry) => entry.level === 'warn' && entry.message.includes('未知配置项')),
  );
});

test('accepts the plugin-entry merged config without unknown-key warnings', async (t) => {
  const resolved = resolveDiscordOptions({ token: 'test-token' }, { env: {} });
  const { logger } = await setup(t, {
    config: { ...resolved, typingIndicator: false, activityUpdates: false },
  });
  assert.ok(!logger.some((entry) => entry.level === 'warn' && entry.message.includes('未知配置项')));
});

test('unsupported intents errors get an actionable message', async () => {
  const client = new FakeClient();
  client.login = async () => {
    const error = new Error('Used disallowed intents');
    error.code = 4014;
    throw error;
  };
  const channel = createDiscordChannel({
    config: { token: 'test-token' },
    logger: createSilentLogger(),
    onMessage: () => undefined,
    clientFactory: () => client,
    env: {},
  });
  await assert.rejects(() => channel.start(), /MESSAGE CONTENT INTENT/);
  assert.equal(client.destroyed, true);
});

test('default client factory uses the required discord.js intents and partials', async (t) => {
  let discord;
  try {
    discord = await import('discord.js');
  } catch {
    t.skip('discord.js 尚未安装（package/install 任务负责）');
    return;
  }
  const { createDefaultDiscordClient } = await import('../../lib/discord/client.js');
  const client = await createDefaultDiscordClient();
  const intents = client.options.intents;
  assert.equal(intents.has(discord.GatewayIntentBits.Guilds), true);
  assert.equal(intents.has(discord.GatewayIntentBits.GuildMessages), true);
  assert.equal(intents.has(discord.GatewayIntentBits.DirectMessages), true);
  assert.equal(intents.has(discord.GatewayIntentBits.MessageContent), true);
  const partials = client.options.partials || [];
  assert.ok(partials.includes(discord.Partials.Channel));
  assert.ok(partials.includes(discord.Partials.Message));
  assert.ok(partials.includes(discord.Partials.User));
  try {
    await client.destroy();
  } catch {
    // never-connected client may throw on destroy; ignore
  }
});

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

test('dispatches a guild message that mentions the bot', async (t) => {
  const { channel: discordChannel, inbounds } = await setup(t);
  const fake = new FakeChannel({ id: 'channel-1', name: 'general' });
  discordChannel.client.emit('messageCreate', fakeMessage({ channel: fake, content: '<@bot-1> hello world' }));
  await waitFor(() => inbounds.length === 1, 'guild dispatch');

  const inbound = inbounds[0];
  assert.equal(inbound.conversationId, 'guild:guild-1:channel-1');
  assert.equal(inbound.conversationLabel, '#general @ Guild One');
  assert.equal(inbound.userId, 'user-1');
  assert.equal(inbound.userName, 'Alice');
  assert.equal(inbound.text, 'hello world');
  assert.equal(inbound.isDirect, false);
  assert.equal(inbound.mentionsBot, true);
  assert.equal(inbound.commandPrefix, '!');
  assert.deepEqual(inbound.attachments, []);
  assert.equal(typeof inbound.reply.send, 'function');
  assert.equal(typeof inbound.reply.update, 'function');
  assert.equal(typeof inbound.reply.delete, 'function');
  assert.equal(typeof inbound.reply.typing, 'function');
});

test('ignores guild messages that do not mention the bot', async (t) => {
  const { channel: discordChannel, inbounds } = await setup(t);
  const fake = new FakeChannel({ id: 'channel-1' });
  discordChannel.client.emit('messageCreate', fakeMessage({ channel: fake, content: 'hello there' }));
  await sleep(30);
  assert.equal(inbounds.length, 0);
});

test('dispatches text commands without a mention', async (t) => {
  const { channel: discordChannel, inbounds } = await setup(t);
  const fake = new FakeChannel({ id: 'channel-1' });
  discordChannel.client.emit('messageCreate', fakeMessage({ channel: fake, content: '!status' }));
  await waitFor(() => inbounds.length === 1, 'command dispatch');
  assert.equal(inbounds[0].text, '!status');
  assert.equal(inbounds[0].mentionsBot, false);
});

test('accepts guild messages without a mention when configured', async (t) => {
  const { channel: discordChannel, inbounds } = await setup(t, { config: { requireMentionInGuild: false } });
  const fake = new FakeChannel({ id: 'channel-1' });
  discordChannel.client.emit('messageCreate', fakeMessage({ channel: fake, content: 'hello there' }));
  await waitFor(() => inbounds.length === 1, 'unmentioned dispatch');
  assert.equal(inbounds[0].text, 'hello there');
});

test('accepts DMs without a mention and marks them direct', async (t) => {
  const { channel: discordChannel, inbounds } = await setup(t);
  const fake = new FakeChannel({ id: 'dm-channel-1', dm: true });
  discordChannel.client.emit('messageCreate', fakeMessage({ channel: fake, content: 'hello' }));
  await waitFor(() => inbounds.length === 1, 'dm dispatch');
  const inbound = inbounds[0];
  assert.equal(inbound.conversationId, 'dm:user-1');
  assert.equal(inbound.conversationLabel, 'DM @Alice');
  assert.equal(inbound.isDirect, true);
  assert.equal(inbound.mentionsBot, false);
});

test('ignores bots, webhooks, system messages and the bot itself', async (t) => {
  const { channel: discordChannel, inbounds } = await setup(t);
  const fake = new FakeChannel({ id: 'channel-1' });
  discordChannel.client.emit(
    'messageCreate',
    fakeMessage({ channel: fake, content: 'bot', author: { id: 'other-bot', username: 'bot', bot: true } }),
  );
  discordChannel.client.emit(
    'messageCreate',
    fakeMessage({ channel: fake, content: 'webhook', overrides: { webhookId: 'webhook-1' } }),
  );
  discordChannel.client.emit('messageCreate', fakeMessage({ channel: fake, content: 'system', overrides: { system: true } }));
  discordChannel.client.emit(
    'messageCreate',
    fakeMessage({ channel: fake, content: 'self', author: { id: 'bot-1', username: 'dsh-bot', bot: true } }),
  );
  await sleep(30);
  assert.equal(inbounds.length, 0);
});

test('ignores mention-only and empty messages', async (t) => {
  const { channel: discordChannel, inbounds } = await setup(t);
  const fake = new FakeChannel({ id: 'channel-1' });
  discordChannel.client.emit('messageCreate', fakeMessage({ channel: fake, content: '<@bot-1>' }));
  await sleep(30);
  assert.equal(inbounds.length, 0);
});

test('applies user, guild and channel allowlists', async (t) => {
  const deniedUser = await setup(t, { config: { allowUsers: ['someone-else'] } });
  const fake = new FakeChannel({ id: 'channel-1' });
  deniedUser.channel.client.emit('messageCreate', fakeMessage({ channel: fake, content: '<@bot-1> hi' }));
  await sleep(30);
  assert.equal(deniedUser.inbounds.length, 0);

  const deniedGuild = await setup(t, { config: { allowGuilds: ['other-guild'] } });
  deniedGuild.channel.client.emit('messageCreate', fakeMessage({ channel: fake, content: '<@bot-1> hi' }));
  await sleep(30);
  assert.equal(deniedGuild.inbounds.length, 0);

  const allowedThread = await setup(t, { config: { allowChannels: ['forum-1'] } });
  const thread = new FakeChannel({ id: 'thread-1', name: 'dev', parentId: 'forum-1', thread: true });
  allowedThread.channel.client.emit('messageCreate', fakeMessage({ channel: thread, content: '<@bot-1> hi' }));
  await waitFor(() => allowedThread.inbounds.length === 1, 'thread allowlist dispatch');
  assert.equal(allowedThread.inbounds[0].conversationId, 'thread:guild-1:thread-1');
});

test('replies to thread messages go back into the thread', async (t) => {
  const { channel: discordChannel, inbounds } = await setup(t);
  const thread = new FakeChannel({ id: 'thread-1', name: 'dev', parentId: 'forum-1', thread: true });
  discordChannel.client.emit('messageCreate', fakeMessage({ channel: thread, content: '<@bot-1> hi' }));
  await waitFor(() => inbounds.length === 1, 'thread reply dispatch');
  const sent = await inbounds[0].reply.send('thread answer');
  assert.equal(thread.sent.length, 1);
  assert.equal(thread.sent[0].content, 'thread answer');
  assert.ok(sent.id);
});

test('sessionScope=channel collapses threads onto the parent channel', async (t) => {
  const { channel: discordChannel, inbounds } = await setup(t, { config: { sessionScope: 'channel' } });
  const thread = new FakeChannel({ id: 'thread-1', name: 'dev', parentId: 'forum-1', thread: true });
  discordChannel.client.emit('messageCreate', fakeMessage({ channel: thread, content: '<@bot-1> hi' }));
  await waitFor(() => inbounds.length === 1, 'thread dispatch');
  assert.equal(inbounds[0].conversationId, 'guild:guild-1:forum-1');
});

test('onMessage failures never escape the message handler', async (t) => {
  const { channel: discordChannel, logger } = await setup(t, {
    onMessage: () => {
      throw new Error('handler boom');
    },
  });
  const fake = new FakeChannel({ id: 'channel-1' });
  discordChannel.client.emit('messageCreate', fakeMessage({ channel: fake, content: '<@bot-1> hi' }));
  await waitFor(
    () => logger.some((entry) => entry.level === 'error' && entry.message.includes('onMessage 回调失败')),
    'onMessage error log',
  );
});

// ---------------------------------------------------------------------------
// Reply object
// ---------------------------------------------------------------------------

async function dispatchOne(t, input = {}) {
  const result = await setup(t, input);
  const fake = new FakeChannel({ id: 'channel-1', name: 'general' });
  result.channel.client.emit('messageCreate', fakeMessage({ channel: fake, content: '<@bot-1> hi' }));
  await waitFor(() => result.inbounds.length === 1, 'dispatch for reply');
  return { ...result, fake, inbound: result.inbounds[0] };
}

test('reply.send splits long text and reply.update edits the first message', async (t) => {
  const { fake, inbound } = await dispatchOne(t);
  const sent = await inbound.reply.send('x'.repeat(2500));
  assert.equal(fake.sent.length, 2);
  assert.deepEqual(fake.sent.map((message) => message.content.length), [1900, 600]);
  assert.equal(sent.id, fake.sent[0].id);

  await inbound.reply.update(sent, 'updated status');
  assert.deepEqual(fake.sent[0].edits, ['updated status']);
});

test('reply.update tolerates deleted status messages', async (t) => {
  const { fake, inbound, logger } = await dispatchOne(t);
  const sent = await inbound.reply.send('status');
  fake.sent[0].editError = Object.assign(new Error('Unknown Message'), { code: 10008 });
  await inbound.reply.update(sent, 'next status');
  assert.ok(logger.some((entry) => entry.level === 'debug' && entry.message.includes('已被删除')));
});

test('reply.update is a no-op when activity updates are disabled', async (t) => {
  const { fake, inbound } = await dispatchOne(t, {
    config: { reply: { typingIndicator: true, activityUpdates: false } },
  });
  const sent = await inbound.reply.send('status');
  await inbound.reply.update(sent, 'next status');
  assert.deepEqual(fake.sent[0].edits, []);
});

test('reply.typing sends typing indicators and respects the option', async (t) => {
  const enabled = await dispatchOne(t);
  await enabled.inbound.reply.typing();
  assert.equal(enabled.fake.typingCount, 1);

  const disabled = await dispatchOne(t, { config: { reply: { typingIndicator: false } } });
  await disabled.inbound.reply.typing();
  assert.equal(disabled.fake.typingCount, 0);
});

test('reply.delete deletes every message it sent', async (t) => {
  const { fake, inbound } = await dispatchOne(t);
  const sent = await inbound.reply.send('x'.repeat(2500));
  await inbound.reply.delete(sent);
  assert.equal(fake.sent.length, 2);
  assert.equal(fake.sent.every((message) => message.deleted), true);
});

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

test('image attachments are downloaded and returned as image refs', async (t) => {
  const fetchCalls = [];
  const { channel: discordChannel, inbounds } = await setup(t, { fetchImpl: fakeFetch(new Uint8Array([1, 2, 3]), fetchCalls) });
  const fake = new FakeChannel({ id: 'channel-1' });
  const attachments = new Map([
    ['att-1', { name: 'pic.png', contentType: 'image/png', size: 3, url: 'https://cdn.example/pic.png' }],
  ]);
  discordChannel.client.emit('messageCreate', fakeMessage({ channel: fake, content: '<@bot-1> look', attachments }));
  await waitFor(() => inbounds.length === 1, 'image dispatch');
  const inbound = inbounds[0];
  assert.equal(inbound.attachments.length, 1);
  const ref = inbound.attachments[0];
  assert.equal(ref.kind, 'image');
  assert.equal(ref.mimeType, 'image/png');
  assert.ok(ref.data);
  assert.deepEqual([...ref.data], [1, 2, 3]);
  assert.equal(inbound.text, 'look');
  assert.deepEqual(fetchCalls, ['https://cdn.example/pic.png']);
});

test('non-image attachments are saved under stateDir and referenced in the prompt', async (t) => {
  const { channel: discordChannel, inbounds, stateDir } = await setup(t, {
    fetchImpl: fakeFetch(new Uint8Array([104, 105])),
  });
  const fake = new FakeChannel({ id: 'channel-1' });
  const attachments = new Map([
    ['att-1', { name: 'note.txt', contentType: 'text/plain', size: 2, url: 'https://cdn.example/note.txt' }],
  ]);
  discordChannel.client.emit('messageCreate', fakeMessage({ channel: fake, content: '<@bot-1> file', attachments }));
  await waitFor(() => inbounds.length === 1, 'file dispatch');
  const inbound = inbounds[0];
  assert.equal(inbound.attachments.length, 1);
  const ref = inbound.attachments[0];
  assert.equal(ref.kind, 'file');
  assert.ok(ref.path);
  assert.ok(inbound.text.startsWith('file\n[附件已保存: '));
  const match = /\[附件已保存: (.+?)\]/.exec(inbound.text);
  assert.ok(match);
  const savedPath = match[1];
  assert.ok(savedPath.startsWith(stateDir));
  assert.ok(savedPath.includes(join('attachments', 'guild_guild-1_channel-1')));
  const stats = await stat(savedPath);
  assert.equal(stats.size, 2);
  const content = await readFile(savedPath, 'utf8');
  assert.equal(content, 'hi');
});

test('oversized attachments are skipped without downloading', async (t) => {
  const fetchCalls = [];
  const { channel: discordChannel, inbounds } = await setup(t, {
    config: { attachments: { enabled: true, maxBytes: 1024, maxCount: 4 } },
    fetchImpl: fakeFetch(new Uint8Array(1), fetchCalls),
  });
  const fake = new FakeChannel({ id: 'channel-1' });
  const attachments = new Map([
    ['att-1', { name: 'big.bin', contentType: 'application/octet-stream', size: 5000, url: 'https://cdn.example/big.bin' }],
  ]);
  discordChannel.client.emit('messageCreate', fakeMessage({ channel: fake, content: '<@bot-1> big', attachments }));
  await waitFor(() => inbounds.length === 1, 'oversized dispatch');
  assert.equal(inbounds[0].attachments.length, 0);
  assert.ok(inbounds[0].text.includes('[附件已跳过: big.bin'));
  assert.deepEqual(fetchCalls, []);
});

test('attachment count is capped and noted', async (t) => {
  const { channel: discordChannel, inbounds } = await setup(t, {
    config: { attachments: { enabled: true, maxBytes: 1024, maxCount: 2 } },
    fetchImpl: fakeFetch(new Uint8Array([1])),
  });
  const fake = new FakeChannel({ id: 'channel-1' });
  const attachments = new Map([
    ['a1', { name: 'a.png', contentType: 'image/png', size: 1, url: 'https://cdn.example/a.png' }],
    ['a2', { name: 'b.png', contentType: 'image/png', size: 1, url: 'https://cdn.example/b.png' }],
    ['a3', { name: 'c.png', contentType: 'image/png', size: 1, url: 'https://cdn.example/c.png' }],
  ]);
  discordChannel.client.emit('messageCreate', fakeMessage({ channel: fake, content: '<@bot-1> many', attachments }));
  await waitFor(() => inbounds.length === 1, 'capped dispatch');
  assert.equal(inbounds[0].attachments.length, 2);
  assert.ok(inbounds[0].text.includes('[已跳过 1 个附件'));
});

test('attachment failures never drop the message', async (t) => {
  const { channel: discordChannel, inbounds } = await setup(t, {
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });
  const fake = new FakeChannel({ id: 'channel-1' });
  const attachments = new Map([
    ['att-1', { name: 'note.txt', contentType: 'text/plain', size: 2, url: 'https://cdn.example/note.txt' }],
  ]);
  discordChannel.client.emit('messageCreate', fakeMessage({ channel: fake, content: '<@bot-1> file', attachments }));
  await waitFor(() => inbounds.length === 1, 'failure dispatch');
  assert.ok(inbounds[0].text.includes('[附件下载失败: note.txt]'));
  assert.equal(inbounds[0].attachments.length, 0);
});

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

test('slash command dispatches the equivalent text command and replies ephemerally', async (t) => {
  const { channel: discordChannel, inbounds } = await setup(t);
  const fake = new FakeChannel({ id: 'channel-1', name: 'general' });
  const interaction = new FakeInteraction('status', fake);
  discordChannel.client.emit('interactionCreate', interaction);
  await waitFor(() => inbounds.length === 1, 'interaction dispatch');

  const inbound = inbounds[0];
  assert.equal(inbound.text, '!status');
  assert.equal(inbound.isDirect, false);
  assert.equal(inbound.conversationId, 'guild:guild-1:channel-1');
  assert.deepEqual(interaction.deferOptions, [{ ephemeral: true }]);

  const sent = await inbound.reply.send('status text');
  assert.deepEqual(interaction.edits, ['status text']);
  await inbound.reply.send('final answer');
  assert.equal(interaction.follows[0].content, 'final answer');
  assert.equal(interaction.follows[0].ephemeral, true);

  await inbound.reply.update(sent, 'updated status');
  const sentStates = sent.raw.messages;
  assert.deepEqual(sentStates[0].edits, ['updated status']);
});

test('unknown dsh subcommands and foreign commands are ignored', async (t) => {
  const { channel: discordChannel, inbounds } = await setup(t);
  const fake = new FakeChannel({ id: 'channel-1' });
  const unknownSub = new FakeInteraction('reset', fake);
  const foreign = new FakeInteraction('help', fake);
  foreign.commandName = 'other';
  discordChannel.client.emit('interactionCreate', unknownSub);
  discordChannel.client.emit('interactionCreate', foreign);
  await sleep(30);
  assert.equal(inbounds.length, 0);
  assert.deepEqual(unknownSub.deferOptions, []);
  assert.deepEqual(foreign.deferOptions, []);
});

test('slash commands respect allowlists and reply with a denial', async (t) => {
  const { channel: discordChannel, inbounds } = await setup(t, { config: { allowUsers: ['someone-else'] } });
  const fake = new FakeChannel({ id: 'channel-1' });
  const interaction = new FakeInteraction('help', fake);
  discordChannel.client.emit('interactionCreate', interaction);
  await waitFor(() => interaction.replies.length === 1, 'denial reply');
  assert.equal(inbounds.length, 0);
  assert.match(interaction.replies[0].content, /权限/);
  assert.deepEqual(interaction.deferOptions, []);
});
