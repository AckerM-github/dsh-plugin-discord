/**
 * Plugin configuration resolution and validation.
 *
 * The cordis patch entry carries this shape:
 *   config:
 *     discord:
 *       token: env:DISCORD_BOT_TOKEN
 *     runtime:
 *       workspace: E:/some/project
 *       provider: deepseek-official
 *       model: deepseek-flash
 *     stateDir: ...          # optional, defaults to <DSH_HOME>/dsh-plugin-discord
 *     debugHttpPort: 0       # dev-only loopback self-test server
 *
 * Validation is fail-soft at the plugin boundary: apply() catches these errors,
 * logs them, and leaves the plugin dormant instead of aborting host startup.
 */

export class PluginConfigError extends Error {
  constructor(issues) {
    const list = Array.isArray(issues) ? issues : [issues];
    super('invalid dsh-plugin-discord configuration:\n- ' + list.join('\n- '));
    this.name = 'PluginConfigError';
    this.issues = list;
  }
}

const DEFAULTS = {
  channelContext: true,
  activityUpdates: true,
  activityIntervalMs: 1200,
  typingIndicator: true,
  maxPromptChars: 20_000,
  maxPendingPerSession: 5,
  debugHttpPort: 0,
  rateLimit: { windowMs: 10_000, maxMessages: 8 },
};

const TOP_LEVEL_KEYS = new Set([
  'discord', 'runtime', 'stateDir', 'proxy', 'tokenFile', 'debugHttpPort', 'channelContext', 'instructions',
  'activityUpdates', 'activityIntervalMs', 'typingIndicator', 'maxPromptChars',
  'maxPendingPerSession', 'rateLimit',
]);
const RUNTIME_KEYS = new Set(['workspace', 'provider', 'model', 'reasoningEffort', 'maxTokens']);
const RATE_LIMIT_KEYS = new Set(['windowMs', 'maxMessages']);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value, path, issues, options) {
  const optional = Boolean(options && options.optional);
  if (value === undefined) {
    if (optional) return undefined;
    issues.push(path + ': expected a non-empty string');
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(path + ': expected a non-empty string');
    return undefined;
  }
  return value;
}

function readBool(value, path, issues, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    issues.push(path + ': expected a boolean');
    return fallback;
  }
  return value;
}

function readInt(value, path, issues, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    issues.push(path + ': expected an integer between ' + min + ' and ' + max);
    return fallback;
  }
  return value;
}

function checkKnownKeys(value, allowed, path, issues) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(path + '.' + key + ': unknown configuration key');
  }
}

/** Resolve bridge-side runtime options (workspace/model route). */
export function resolveRuntimeOptions(raw, issues) {
  const problems = issues || [];
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    problems.push('runtime: expected an object');
    return {};
  }
  checkKnownKeys(raw, RUNTIME_KEYS, 'runtime', problems);
  const out = {};
  const workspace = requireString(raw.workspace, 'runtime.workspace', problems, { optional: true });
  if (workspace !== undefined) out.workspace = workspace;
  const provider = requireString(raw.provider, 'runtime.provider', problems, { optional: true });
  if (provider !== undefined) out.provider = provider;
  const model = requireString(raw.model, 'runtime.model', problems, { optional: true });
  if (model !== undefined) out.model = model;
  const reasoningEffort = requireString(raw.reasoningEffort, 'runtime.reasoningEffort', problems, { optional: true });
  if (reasoningEffort !== undefined) out.reasoningEffort = reasoningEffort;
  if (raw.maxTokens !== undefined) {
    out.maxTokens = readInt(raw.maxTokens, 'runtime.maxTokens', problems, 0, 1, 10_000_000);
  }
  if ((out.provider === undefined) !== (out.model === undefined)) {
    problems.push('runtime.provider and runtime.model must be set together');
  }
  return out;
}

function resolveProxy(raw, issues) {
  const value = requireString(raw, 'config.proxy', issues, { optional: true });
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      issues.push('config.proxy: expected an http(s) proxy URL');
      return undefined;
    }
  } catch {
    issues.push('config.proxy: expected an absolute http(s) proxy URL (e.g. http://127.0.0.1:7890)');
    return undefined;
  }
  return value;
}

function resolveRateLimit(raw, issues) {
  if (raw === undefined) return { ...DEFAULTS.rateLimit };
  if (!isRecord(raw)) {
    issues.push('rateLimit: expected an object');
    return { ...DEFAULTS.rateLimit };
  }
  checkKnownKeys(raw, RATE_LIMIT_KEYS, 'rateLimit', issues);
  return {
    windowMs: readInt(raw.windowMs, 'rateLimit.windowMs', issues, DEFAULTS.rateLimit.windowMs, 100, 86_400_000),
    maxMessages: readInt(raw.maxMessages, 'rateLimit.maxMessages', issues, DEFAULTS.rateLimit.maxMessages, 1, 10_000),
  };
}

/**
 * Resolve the plugin config. Unknown top-level keys are reported (typo
 * protection); the nested "discord" block is validated separately by the
 * Discord adapter module so this function stays independent of discord.js.
 */
export function resolvePluginConfig(raw) {
  const issues = [];
  if (raw !== undefined && !isRecord(raw)) throw new PluginConfigError('config: expected an object');
  const value = raw || {};
  checkKnownKeys(value, TOP_LEVEL_KEYS, 'config', issues);
  const discordRaw = value.discord === undefined ? {} : value.discord;
  if (!isRecord(discordRaw)) issues.push('config.discord: expected an object');
  const runtime = resolveRuntimeOptions(value.runtime, issues);
  const stateDir = requireString(value.stateDir, 'config.stateDir', issues, { optional: true });
  const proxy = resolveProxy(value.proxy, issues);
  const tokenFile = requireString(value.tokenFile, 'config.tokenFile', issues, { optional: true });
  const instructions = value.instructions === undefined
    ? undefined
    : requireString(value.instructions, 'config.instructions', issues, { optional: true });
  const resolved = {
    discord: isRecord(discordRaw) ? discordRaw : {},
    runtime,
    stateDir,
    proxy,
    tokenFile,
    instructions,
    channelContext: readBool(value.channelContext, 'config.channelContext', issues, DEFAULTS.channelContext),
    activityUpdates: readBool(value.activityUpdates, 'config.activityUpdates', issues, DEFAULTS.activityUpdates),
    activityIntervalMs: readInt(value.activityIntervalMs, 'config.activityIntervalMs', issues, DEFAULTS.activityIntervalMs, 200, 60_000),
    typingIndicator: readBool(value.typingIndicator, 'config.typingIndicator', issues, DEFAULTS.typingIndicator),
    maxPromptChars: readInt(value.maxPromptChars, 'config.maxPromptChars', issues, DEFAULTS.maxPromptChars, 100, 200_000),
    maxPendingPerSession: readInt(value.maxPendingPerSession, 'config.maxPendingPerSession', issues, DEFAULTS.maxPendingPerSession, 1, 100),
    debugHttpPort: readInt(value.debugHttpPort, 'config.debugHttpPort', issues, DEFAULTS.debugHttpPort, 0, 65_535),
    rateLimit: resolveRateLimit(value.rateLimit, issues),
  };
  if (issues.length > 0) throw new PluginConfigError(issues);
  return resolved;
}
