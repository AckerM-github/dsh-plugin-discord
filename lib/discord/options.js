/**
 * Discord channel options: defaults, validation, token resolution.
 *
 * The plugin config layer may resolve options early by calling
 * resolveDiscordOptions(raw); the channel factory calls it again defensively at
 * start(). Errors carry the offending option path (DiscordOptionsError.option)
 * so the plugin can point at the bad config key.
 *
 * Token resolution order: token (literal or env:NAME) -> DISCORD_BOT_TOKEN.
 * Attachment state directory: options.stateDir -> context.stateDir ->
 * <DSH_HOME or ~/.dsh>/dsh-plugin-discord.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export class DiscordOptionsError extends Error {
  constructor(option, message) {
    super(message);
    this.name = 'DiscordOptionsError';
    this.option = option;
  }
}

export const DISCORD_DEFAULTS = {
  requireMentionInGuild: true,
  sessionScope: 'thread',
  commandPrefix: '!',
  registerSlashCommands: true,
  readyTimeoutMs: 30000,
  attachments: { enabled: true, maxBytes: 8 * 1024 * 1024, maxCount: 4 },
  reply: { typingIndicator: true, activityUpdates: true },
};

const SESSION_SCOPES = ['thread', 'channel', 'user'];

const TOP_LEVEL_KEYS = [
  'token',
  'applicationId',
  'stateDir',
  'typingIndicator',
  'activityUpdates',
  'unknownKeys',
  'requireMentionInGuild',
  'sessionScope',
  'commandPrefix',
  'allowGuilds',
  'allowChannels',
  'allowUsers',
  'attachments',
  'registerSlashCommands',
  'reply',
  'readyTimeoutMs',
];

const ATTACHMENT_KEYS = ['enabled', 'maxBytes', 'maxCount'];
const REPLY_KEYS = ['typingIndicator', 'activityUpdates'];

const MIN_ATTACHMENT_BYTES = 1024;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 10;

/**
 * Validate raw discord options and fill in defaults.
 * Returns { ...options, stateDir, unknownKeys }. Unknown keys are reported (not
 * rejected) so the plugin entry can log typos while staying forward-compatible.
 */
export function resolveDiscordOptions(raw, context = {}) {
  if (!isPlainObject(raw)) {
    throw new DiscordOptionsError('options', 'discord 频道配置必须是一个对象');
  }
  const env = isPlainObject(context.env) ? context.env : process.env;
  const unknownKeys = Object.keys(raw).filter((key) => !TOP_LEVEL_KEYS.includes(key));

  const token = resolveToken(raw.token, env);
  const stateDir = resolveStateDir(raw.stateDir, context.stateDir, env);
  const applicationId = readApplicationId(raw.applicationId);
  const requireMentionInGuild = readBoolean(raw, 'requireMentionInGuild', DISCORD_DEFAULTS.requireMentionInGuild, 'options');
  const sessionScope = readSessionScope(raw.sessionScope);
  const commandPrefix = readCommandPrefix(raw.commandPrefix);
  const allowGuilds = readIdList(raw, 'allowGuilds');
  const allowChannels = readIdList(raw, 'allowChannels');
  const allowUsers = readIdList(raw, 'allowUsers');
  const attachments = readAttachments(raw.attachments);
  const registerSlashCommands = readBoolean(raw, 'registerSlashCommands', DISCORD_DEFAULTS.registerSlashCommands, 'options');
  const reply = readReply(raw.reply);
  // The plugin entry may merge its top-level display flags into the channel config.
  if (raw.typingIndicator !== undefined) {
    reply.typingIndicator = readBoolean(raw, 'typingIndicator', reply.typingIndicator, 'options');
  }
  if (raw.activityUpdates !== undefined) {
    reply.activityUpdates = readBoolean(raw, 'activityUpdates', reply.activityUpdates, 'options');
  }
  const readyTimeoutMs = readInteger(raw, 'readyTimeoutMs', DISCORD_DEFAULTS.readyTimeoutMs, 'options', 1000, 300000);

  return {
    token,
    stateDir,
    applicationId,
    requireMentionInGuild,
    sessionScope,
    commandPrefix,
    allowGuilds,
    allowChannels,
    allowUsers,
    attachments,
    registerSlashCommands,
    reply,
    readyTimeoutMs,
    unknownKeys,
  };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionPath(path, key) {
  return path === 'options' ? key : path + '.' + key;
}

function resolveToken(value, env) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('env:')) {
      const envName = trimmed.slice(4).trim();
      if (!envName) {
        throw new DiscordOptionsError('token', 'token 的 env: 引用缺少环境变量名（例如 env:DISCORD_BOT_TOKEN）');
      }
      const resolved = env[envName];
      if (typeof resolved !== 'string' || resolved.trim() === '') {
        throw new DiscordOptionsError('token', 'token 引用的环境变量 ' + envName + ' 未设置或为空');
      }
      return resolved.trim();
    }
    if (trimmed) return trimmed;
  }
  const fallback = env.DISCORD_BOT_TOKEN;
  if (typeof fallback === 'string' && fallback.trim() !== '') return fallback.trim();
  throw new DiscordOptionsError(
    'token',
    'discord 缺少 bot token：请配置 token（推荐 token: env:DISCORD_BOT_TOKEN）或设置环境变量 DISCORD_BOT_TOKEN',
  );
}

function resolveStateDir(value, contextStateDir, env) {
  if (value !== undefined && value !== null) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new DiscordOptionsError('stateDir', 'stateDir 必须是非空字符串路径');
    }
    return value.trim();
  }
  if (typeof contextStateDir === 'string' && contextStateDir.trim() !== '') {
    return contextStateDir.trim();
  }
  const dshHome = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : join(homedir(), '.dsh');
  return join(dshHome, 'dsh-plugin-discord');
}

function readApplicationId(value) {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,25}$/.test(text)) {
    throw new DiscordOptionsError('applicationId', 'applicationId 必须是 Discord 应用 ID（纯数字）');
  }
  return text;
}

function readBoolean(obj, key, fallback, path) {
  const value = obj[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new DiscordOptionsError(optionPath(path, key), key + ' 必须是 true 或 false');
  }
  return value;
}

function readInteger(obj, key, fallback, path, min, max) {
  const value = obj[key];
  if (value === undefined || value === null) return fallback;
  const num = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isInteger(num) || num < min || num > max) {
    throw new DiscordOptionsError(optionPath(path, key), key + ' 必须是 ' + min + ' 到 ' + max + ' 之间的整数');
  }
  return num;
}

function readSessionScope(value) {
  if (value === undefined || value === null) return DISCORD_DEFAULTS.sessionScope;
  if (typeof value === 'string' && SESSION_SCOPES.includes(value)) return value;
  throw new DiscordOptionsError('sessionScope', 'sessionScope 必须是 thread、channel 或 user 之一');
}

function readCommandPrefix(value) {
  if (value === undefined || value === null) return DISCORD_DEFAULTS.commandPrefix;
  if (typeof value !== 'string') {
    throw new DiscordOptionsError('commandPrefix', 'commandPrefix 必须是字符串（例如 "!"）');
  }
  if (value.length === 0 || value.length > 5 || /\s/.test(value)) {
    throw new DiscordOptionsError('commandPrefix', 'commandPrefix 必须是 1-5 个非空白字符（例如 "!"）');
  }
  return value;
}

function readIdList(obj, key) {
  const value = obj[key];
  if (value === undefined || value === null) return [];
  if (typeof value !== 'string' && !Array.isArray(value)) {
    throw new DiscordOptionsError(key, key + ' 必须是 ID 数组，或逗号分隔的 ID 字符串');
  }
  const items = typeof value === 'string' ? value.split(',') : value;
  const result = [];
  for (const item of items) {
    const text = typeof item === 'number' ? String(item) : typeof item === 'string' ? item.trim() : '';
    if (!text) {
      throw new DiscordOptionsError(key, key + ' 不能包含空值');
    }
    if (!result.includes(text)) result.push(text);
  }
  return result;
}

function readAttachments(value) {
  if (value === undefined || value === null) return { ...DISCORD_DEFAULTS.attachments };
  if (!isPlainObject(value)) {
    throw new DiscordOptionsError('attachments', 'attachments 必须是一个对象');
  }
  assertNestedKeys(value, ATTACHMENT_KEYS, 'attachments');
  return {
    enabled: readBoolean(value, 'enabled', DISCORD_DEFAULTS.attachments.enabled, 'attachments'),
    maxBytes: readInteger(value, 'maxBytes', DISCORD_DEFAULTS.attachments.maxBytes, 'attachments', MIN_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES),
    maxCount: readInteger(value, 'maxCount', DISCORD_DEFAULTS.attachments.maxCount, 'attachments', 0, MAX_ATTACHMENT_COUNT),
  };
}

function readReply(value) {
  if (value === undefined || value === null) return { ...DISCORD_DEFAULTS.reply };
  if (!isPlainObject(value)) {
    throw new DiscordOptionsError('reply', 'reply 必须是一个对象');
  }
  assertNestedKeys(value, REPLY_KEYS, 'reply');
  return {
    typingIndicator: readBoolean(value, 'typingIndicator', DISCORD_DEFAULTS.reply.typingIndicator, 'reply'),
    activityUpdates: readBoolean(value, 'activityUpdates', DISCORD_DEFAULTS.reply.activityUpdates, 'reply'),
  };
}

function assertNestedKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new DiscordOptionsError(path + '.' + key, '未知的 discord 配置项 "' + key + '"（可用项: ' + allowed.join(', ') + '）');
    }
  }
}
