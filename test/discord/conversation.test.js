import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DISCORD_MAX_MESSAGE_CHARS,
  EMPTY_REPLY_TEXT,
  detectMentionsBot,
  isAllowedId,
  isCommandText,
  isMentionOfUser,
  locationFromChannel,
  resolveConversation,
  splitDiscordText,
  stripBotMention,
} from '../../lib/discord/conversation.js';

const guildChannel = { id: 'channel-1', name: 'general', parentId: null, isDM: false, isThread: false };
const threadChannel = { id: 'thread-1', name: 'dev', parentId: 'forum-1', isDM: false, isThread: true };
const dmChannel = { id: 'dm-channel-1', name: null, parentId: null, isDM: true, isThread: false };

test('locationFromChannel builds dm, guild and thread locations', () => {
  assert.deepEqual(
    locationFromChannel({ guildId: null, guildName: null, channel: dmChannel, userId: 'u1', userName: 'Alice' }),
    { kind: 'dm', userId: 'u1', userName: 'Alice' },
  );
  assert.deepEqual(
    locationFromChannel({ guildId: 'g1', guildName: 'Guild One', channel: guildChannel, userId: 'u1', userName: 'Alice' }),
    { kind: 'guild', guildId: 'g1', guildName: 'Guild One', channelId: 'channel-1', channelName: 'general' },
  );
  assert.deepEqual(
    locationFromChannel({ guildId: 'g1', guildName: 'Guild One', channel: threadChannel, userId: 'u1', userName: 'Alice' }),
    {
      kind: 'thread',
      guildId: 'g1',
      guildName: 'Guild One',
      threadId: 'thread-1',
      threadName: 'dev',
      parentChannelId: 'forum-1',
    },
  );
});

test('locationFromChannel rejects incomplete locations', () => {
  assert.throws(() => locationFromChannel({ guildId: null, channel: guildChannel, userId: 'u1' }), /guild id/);
  assert.throws(
    () => locationFromChannel({ guildId: null, channel: { ...dmChannel, id: '' }, userId: 'u1' }),
    /channel id/,
  );
  assert.throws(() => locationFromChannel({ guildId: null, channel: dmChannel, userId: '' }), /user id/);
});

test('resolveConversation derives stable ids for DMs', () => {
  const dm = locationFromChannel({ guildId: null, channel: dmChannel, userId: 'u1', userName: 'Alice' });
  assert.deepEqual(resolveConversation(dm, 'thread', 'u1'), { id: 'dm:u1', label: 'DM @Alice' });
  assert.deepEqual(resolveConversation(dm, 'channel', 'u1'), { id: 'dm:u1', label: 'DM @Alice' });
  assert.deepEqual(resolveConversation(dm, 'user', 'u1'), { id: 'dm:u1', label: 'DM @Alice' });
});

test('resolveConversation derives guild channel ids and labels', () => {
  const guild = locationFromChannel({
    guildId: 'g1',
    guildName: 'Guild One',
    channel: guildChannel,
    userId: 'u1',
    userName: 'Alice',
  });
  assert.deepEqual(resolveConversation(guild, 'thread', 'u1'), {
    id: 'guild:g1:channel-1',
    label: '#general @ Guild One',
  });
  assert.deepEqual(resolveConversation(guild, 'channel', 'u1'), {
    id: 'guild:g1:channel-1',
    label: '#general @ Guild One',
  });
  assert.deepEqual(resolveConversation(guild, 'user', 'u1'), {
    id: 'guild:g1:channel-1:user:u1',
    label: '#general @ Guild One',
  });
});

test('resolveConversation derives thread ids per session scope', () => {
  const thread = locationFromChannel({
    guildId: 'g1',
    guildName: 'Guild One',
    channel: threadChannel,
    userId: 'u1',
    userName: 'Alice',
  });
  assert.deepEqual(resolveConversation(thread, 'thread', 'u1'), {
    id: 'thread:g1:thread-1',
    label: '#dev (thread) @ Guild One',
  });
  assert.deepEqual(resolveConversation(thread, 'channel', 'u1'), {
    id: 'guild:g1:forum-1',
    label: '#dev (thread) @ Guild One',
  });
  assert.deepEqual(resolveConversation(thread, 'user', 'u1'), {
    id: 'thread:g1:thread-1:user:u1',
    label: '#dev (thread) @ Guild One',
  });
});

test('resolveConversation falls back to ids when names are unknown', () => {
  const guild = resolveConversation({ kind: 'guild', guildId: 'g1', channelId: 'c1' }, 'thread', 'u1');
  assert.deepEqual(guild, { id: 'guild:g1:c1', label: '#c1 @ g1' });
  const thread = resolveConversation(
    { kind: 'thread', guildId: 'g1', threadId: 't1', parentChannelId: 'c1' },
    'channel',
    'u1',
  );
  assert.deepEqual(thread, { id: 'guild:g1:c1', label: '#t1 (thread) @ g1' });
  const dm = resolveConversation({ kind: 'dm', userId: 'u1' }, 'thread', 'u1');
  assert.deepEqual(dm, { id: 'dm:u1', label: 'DM @u1' });
});

test('isAllowedId treats an empty allowlist as allow-all', () => {
  assert.equal(isAllowedId([], '111'), true);
  assert.equal(isAllowedId(['111'], '111'), true);
  assert.equal(isAllowedId(['111'], '222'), false);
  assert.equal(isAllowedId(['111'], undefined, null), false);
  assert.equal(isAllowedId(['parent'], 'thread', 'parent'), true);
});

test('stripBotMention removes both mention forms and tidies spaces', () => {
  assert.equal(stripBotMention('<@123> hello', '123'), 'hello');
  assert.equal(stripBotMention('<@!123> hello world', '123'), 'hello world');
  assert.equal(stripBotMention('hi <@123> there', '123'), 'hi there');
  assert.equal(stripBotMention('<@456> hello', '123'), '<@456> hello');
  assert.equal(stripBotMention('  a   b  ', '123'), 'a b');
  assert.equal(stripBotMention('<@123>', '123'), '');
  assert.equal(stripBotMention('', '123'), '');
});

test('detectMentionsBot prefers the mention collection and falls back to text', () => {
  assert.equal(detectMentionsBot({ isDirect: false, botId: '123', mentionedUserIds: ['123'], content: 'hi' }), true);
  assert.equal(detectMentionsBot({ isDirect: false, botId: '123', mentionedUserIds: ['456'], content: '<@123> hi' }), true);
  assert.equal(detectMentionsBot({ isDirect: false, botId: '123', mentionedUserIds: ['456'], content: 'hi' }), false);
  assert.equal(detectMentionsBot({ isDirect: true, botId: '123', mentionedUserIds: ['123'], content: '<@123> hi' }), false);
  assert.equal(detectMentionsBot({ isDirect: false, botId: '', mentionedUserIds: ['123'], content: '<@123>' }), false);
  assert.equal(isMentionOfUser('<@!123>', '123'), true);
  assert.equal(isMentionOfUser('<@123>', '456'), false);
  assert.equal(isMentionOfUser('', '123'), false);
});

test('isCommandText recognises the configured prefix', () => {
  assert.equal(isCommandText('!new', '!'), true);
  assert.equal(isCommandText('!new args', '!'), true);
  assert.equal(isCommandText('  !new', '!'), true);
  assert.equal(isCommandText('!', '!'), false);
  assert.equal(isCommandText('hello', '!'), false);
  assert.equal(isCommandText('', '!'), false);
  assert.equal(isCommandText(null, '!'), false);
  assert.equal(isCommandText('!new', ''), false);
});

test('splitDiscordText returns no chunks for empty text', () => {
  assert.deepEqual(splitDiscordText(''), []);
  assert.deepEqual(splitDiscordText('   \n  '), []);
});

test('splitDiscordText keeps short text in one chunk', () => {
  assert.deepEqual(splitDiscordText('hello'), ['hello']);
  assert.deepEqual(splitDiscordText('  hello  '), ['hello']);
  assert.deepEqual(splitDiscordText('a\r\nb'), ['a\nb']);
});

test('splitDiscordText hard-splits long single-line text under the limit', () => {
  const chunks = splitDiscordText('a'.repeat(5000));
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [1900, 1900, 1200]);
  assert.equal(chunks.join('').length, 5000);
  assert.ok(chunks.every((chunk) => chunk.length <= DISCORD_MAX_MESSAGE_CHARS));
});

test('splitDiscordText prefers newline boundaries', () => {
  const line = 'line of text\n';
  const text = line.repeat(400);
  const chunks = splitDiscordText(text);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= DISCORD_MAX_MESSAGE_CHARS);
    assert.ok(!chunk.startsWith('\n'));
    assert.ok(!chunk.endsWith('\n'));
  }
  assert.equal(chunks.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
});

test('splitDiscordText respects a custom maxChars and never emits empty chunks', () => {
  const chunks = splitDiscordText('abcdefghij'.repeat(5), 10);
  assert.ok(chunks.length >= 5);
  assert.ok(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 10));
  assert.equal(chunks.join(''), 'abcdefghij'.repeat(5));
});

test('splitDiscordText never splits a surrogate pair', () => {
  const text = '😀'.repeat(1000);
  const chunks = splitDiscordText(text);
  assert.equal(chunks.length, 2);
  for (const chunk of chunks) {
    const last = chunk.charCodeAt(chunk.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'chunk must not end with a high surrogate');
  }
  assert.equal(chunks.join(''), text);
});

test('splitDiscordText validates its arguments', () => {
  assert.throws(() => splitDiscordText('text', 0), RangeError);
  assert.throws(() => splitDiscordText('text', 1.5), RangeError);
});

test('EMPTY_REPLY_TEXT is user-facing Chinese text', () => {
  assert.ok(EMPTY_REPLY_TEXT.length > 0);
});
