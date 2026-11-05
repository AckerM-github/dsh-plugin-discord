/**
 * Pure conversation routing, mention and message-formatting helpers.
 *
 * These functions operate on plain data (no discord.js objects) so they are
 * cheap to unit test: the channel extracts channel info and passes it in.
 */

/** Discord rejects messages longer than 2000 characters; keep a margin for markdown. */
export const DISCORD_MAX_MESSAGE_CHARS = 1900;

/** Fallback text when the model produced no visible text. */
export const EMPTY_REPLY_TEXT = '（模型没有返回文本内容）';

/**
 * Derive the stable conversation id and a human label.
 *
 * - DM:            dm:<userId>
 * - guild channel: guild:<guildId>:<channelId>
 * - thread:        thread:<guildId>:<threadId>
 * - sessionScope=channel collapses threads onto guild:<guildId>:<parentChannelId>
 * - sessionScope=user appends :user:<userId> to guild/thread keys
 */
export function resolveConversation(location, sessionScope, actorUserId) {
  if (location.kind === 'dm') {
    const name = location.userName || location.userId;
    return { id: 'dm:' + location.userId, label: 'DM @' + name };
  }

  const guildName = location.guildName || location.guildId;
  const userSuffix = sessionScope === 'user' ? ':user:' + actorUserId : '';

  if (location.kind === 'thread') {
    const threadName = location.threadName || location.threadId;
    const label = '#' + threadName + ' (thread) @ ' + guildName;
    if (sessionScope === 'channel') {
      const parentChannelId = location.parentChannelId || location.threadId;
      return { id: 'guild:' + location.guildId + ':' + parentChannelId, label };
    }
    return { id: 'thread:' + location.guildId + ':' + location.threadId + userSuffix, label };
  }

  const channelName = location.channelName || location.channelId;
  return {
    id: 'guild:' + location.guildId + ':' + location.channelId + userSuffix,
    label: '#' + channelName + ' @ ' + guildName,
  };
}

/**
 * Build a location from extracted channel fields.
 * Throws when a required id is missing.
 */
export function locationFromChannel(input) {
  const channel = input.channel;
  if (!channel || typeof channel.id !== 'string' || channel.id === '') {
    throw new Error('discord location requires a channel id');
  }
  if (channel.isDM) {
    if (!input.userId) throw new Error('discord DM location requires a user id');
    return { kind: 'dm', userId: input.userId, userName: input.userName || undefined };
  }
  const guildId = input.guildId || undefined;
  if (!guildId) throw new Error('discord guild location requires a guild id');
  const guildName = input.guildName || undefined;
  if (channel.isThread) {
    return {
      kind: 'thread',
      guildId,
      guildName,
      threadId: channel.id,
      threadName: channel.name || undefined,
      parentChannelId: channel.parentId || undefined,
    };
  }
  return {
    kind: 'guild',
    guildId,
    guildName,
    channelId: channel.id,
    channelName: channel.name || undefined,
  };
}

/**
 * Allowlist check. An empty allowlist means "allow everything"; a thread is
 * allowed when either its thread id or its parent channel id is listed.
 */
export function isAllowedId(allowlist, ...ids) {
  if (allowlist.length === 0) return true;
  for (const id of ids) {
    if (typeof id === 'string' && id !== '' && allowlist.includes(id)) return true;
  }
  return false;
}

/**
 * Detect whether a guild message mentions the bot. DMs always return false
 * (the conversation is already addressed to the bot).
 */
export function detectMentionsBot(input) {
  if (input.isDirect) return false;
  if (!input.botId) return false;
  if (input.mentionedUserIds) {
    for (const id of input.mentionedUserIds) {
      if (id === input.botId) return true;
    }
  }
  return isMentionOfUser(input.content || '', input.botId);
}

/** True when the text contains a raw user mention for userId. */
export function isMentionOfUser(text, userId) {
  if (!text || !userId) return false;
  return botMentionPattern(userId, false).test(text);
}

/**
 * Remove the bot mention from a message and tidy the whitespace left behind.
 * Only the bot's own mention is removed so references to other users survive.
 */
export function stripBotMention(text, botId) {
  if (!text) return '';
  const stripped = botId ? text.replace(botMentionPattern(botId, true), ' ') : text;
  return stripped.replace(/[ \t]{2,}/g, ' ').trim();
}

/** A text message that starts with the command prefix (and has a body). */
export function isCommandText(text, commandPrefix) {
  if (!text || !commandPrefix) return false;
  const trimmed = text.replace(/^\s+/, '');
  return trimmed.startsWith(commandPrefix) && trimmed.length > commandPrefix.length;
}

function botMentionPattern(userId, global) {
  return new RegExp('<@!?' + escapeRegExp(userId) + '>', global ? 'g' : '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
}

/**
 * Split text into chunks of at most maxChars characters for Discord messages.
 * Prefers newline boundaries, never splits a surrogate pair, and never emits an
 * empty chunk. Empty or whitespace-only text produces no chunks.
 */
export function splitDiscordText(text, maxChars = DISCORD_MAX_MESSAGE_CHARS) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new RangeError('maxChars must be a positive integer');

  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];

  const chunks = [];
  let rest = normalized;

  while (rest.length > maxChars) {
    const newlineCut = rest.lastIndexOf('\n', maxChars - 1);
    const useNewline = newlineCut >= Math.floor(maxChars / 2);
    if (useNewline) {
      const chunk = rest.slice(0, newlineCut).trimEnd();
      if (chunk) chunks.push(chunk);
      rest = rest.slice(newlineCut + 1).replace(/^\n+/, '');
      continue;
    }
    const cut = safeCutIndex(rest, maxChars);
    const chunk = rest.slice(0, cut).trimEnd();
    if (chunk) chunks.push(chunk);
    rest = rest.slice(cut).replace(/^\n+/, '');
  }

  const tail = rest.trimEnd();
  if (tail) chunks.push(tail);
  return chunks;
}

function safeCutIndex(text, maxChars) {
  let cut = Math.min(maxChars, text.length);
  if (cut < 1) return 1;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return Math.max(1, cut);
}
