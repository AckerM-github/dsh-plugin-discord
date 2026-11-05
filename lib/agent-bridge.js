/**
 * Native DSH agent bridge for dsh-plugin-discord.
 *
 * Each Discord conversation (channel / thread / DM) maps to one persistent DSH
 * session, driven through the public `ctx.agents` API inside the host process:
 *
 *   conversation key -> sessionId -> live Agent or owned AgentHandle
 *
 * Session resolution order for a key:
 *   1. live agent handle cached by this bridge (same host lifetime);
 *   2. persisted session id whose Agent is already live in this host
 *      (e.g. opened in the Web UI) -> reuse WITHOUT taking ownership;
 *   3. persisted session id -> `ctx.agents.resume({ resumeSessionId })`;
 *   4. resume failure (missing / incompatible / occupied) -> warn and create a
 *      fresh session with a caller-minted `session-<uuid-no-dashes>` id.
 *
 * Runs are serialized per conversation key. Events are observed through one
 * plugin-lifetime `session/event` subscription with a per-run sequence
 * watermark, so a run only reports assistant text from its own interval.
 *
 * Failure policy: agent failures/timeouts reject the run with a readable Error
 * while leaving the session (and agent) alive for the next message.
 *
 * @module dsh-plugin-discord/agent-bridge
 */

import { randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/** Hard bound for one rendered activity line. */
export const MAX_ACTIVITY_CHARS = 120;
/** Bound for the argument summary embedded in a tool-call line. */
export const MAX_ARG_SUMMARY_CHARS = 60;

const TOOL_ARG_KEYS = {
  pwsh: ['command', 'cmd'],
  powershell: ['command'],
  bash: ['command', 'cmd'],
  shell: ['command'],
  read: ['file_path', 'path'],
  write: ['file_path', 'path'],
  edit: ['file_path', 'path'],
  str_replace: ['file_path', 'path'],
  glob: ['pattern', 'path'],
  grep: ['pattern', 'path'],
  ls: ['path'],
  list: ['path'],
  web_fetch: ['url'],
  web_search: ['query', 'queries'],
};

const GENERIC_ARG_KEYS = [
  'command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'queries', 'url',
  'name', 'task', 'prompt', 'description', 'text',
];

const CONTEXT_LINE_PREFIX = '[Discord 频道: ';

function noop() {}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error) {
  if (error instanceof Error) {
    if (error.message) return error.message;
    return error.name;
  }
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return String(error);
}

function normalizeLogger(logger) {
  const safe = logger || {};
  return {
    debug: typeof safe.debug === 'function' ? safe.debug.bind(safe) : noop,
    info: typeof safe.info === 'function' ? safe.info.bind(safe) : noop,
    warn: typeof safe.warn === 'function' ? safe.warn.bind(safe) : noop,
    error: typeof safe.error === 'function' ? safe.error.bind(safe) : noop,
  };
}

/** Collapse whitespace and truncate one activity line. */
export function clipLine(text, maxChars = MAX_ACTIVITY_CHARS) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxChars) return oneLine;
  return oneLine.slice(0, Math.max(0, maxChars - 1)) + '…';
}

function scalarText(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const items = value.map(scalarText).filter((item) => item !== undefined);
    return items.length > 0 ? items.join(', ') : undefined;
  }
  return undefined;
}

function parseArguments(rawArguments) {
  if (isRecord(rawArguments)) return rawArguments;
  if (typeof rawArguments !== 'string') return undefined;
  const text = rawArguments.trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Summarize a tool call's raw argument JSON without dumping it into chat. */
export function summarizeToolArguments(toolName, rawArguments) {
  const name = String(toolName || '').toLowerCase();
  const object = parseArguments(rawArguments);
  if (object) {
    const keys = [...(TOOL_ARG_KEYS[name] || []), ...GENERIC_ARG_KEYS];
    for (const key of keys) {
      const summary = scalarText(object[key]);
      if (summary !== undefined) return clipLine(summary, MAX_ARG_SUMMARY_CHARS);
    }
    try {
      return clipLine(JSON.stringify(object), MAX_ARG_SUMMARY_CHARS);
    } catch {
      return '';
    }
  }
  if (typeof rawArguments === 'string') return clipLine(rawArguments, MAX_ARG_SUMMARY_CHARS);
  return '';
}

function toolCallLine(name, rawArguments) {
  const summary = summarizeToolArguments(name, rawArguments);
  return clipLine(summary ? '🛠 ' + name + ': ' + summary : '🛠 ' + name);
}

function toolResultLine(name, isError) {
  return isError ? '⚠️ ' + name + ' 失败' : '✅ ' + name + ' 完成';
}

/** Concatenate visible text blocks of an assistant/tool message content array. */
export function textOfContent(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'text') continue;
    if (typeof block.text === 'string' && block.text) parts.push(block.text);
  }
  return parts.join('');
}

/**
 * Resolve the provider/model route for SDK-created agents.
 *
 * Config wins when it names both provider and model; otherwise the deployment
 * default (`ctx.agentDefaultModel.currentSelection()`) is used. Returns
 * `undefined` when no complete route is available, so the caller omits
 * `agentOptions` entirely and the host/default driver decides.
 *
 * @param {object} ctx cordis context (reads optional `agentDefaultModel`).
 * @param {object} [config] bridge config with provider/model/reasoningEffort/maxTokens.
 * @returns {{provider: string, model: string, reasoningEffort?: string, maxTokens?: number} | undefined}
 */
export function resolveAgentOptions(ctx, config = {}) {
  const options = {};
  const configured = isRecord(config) ? config : {};
  const provider = typeof configured.provider === 'string' && configured.provider ? configured.provider : undefined;
  const model = typeof configured.model === 'string' && configured.model ? configured.model : undefined;
  let selection;
  if (provider && model) {
    options.provider = provider;
    options.model = model;
    selection = undefined;
  } else {
    selection = readDefaultSelection(ctx);
    if (!selection) return undefined;
    options.provider = selection.provider;
    options.model = selection.model;
  }
  const effort = typeof configured.reasoningEffort === 'string' && configured.reasoningEffort
    ? configured.reasoningEffort
    : selection && typeof selection.reasoningEffort === 'string'
      ? selection.reasoningEffort
      : undefined;
  if (effort) options.reasoningEffort = effort;
  if (Number.isInteger(configured.maxTokens) && configured.maxTokens > 0) options.maxTokens = configured.maxTokens;
  return options;
}

function readDefaultSelection(ctx) {
  try {
    // The plugin only injects ['agents'], so the default-model service must be
    // resolved through the context service registry rather than a property
    // shortcut; keep the property as a fallback for older hosts/test doubles.
    let service;
    if (ctx && typeof ctx.get === 'function') {
      try {
        service = ctx.get('agentDefaultModel');
      } catch {
        service = undefined;
      }
    }
    if (!service && ctx && ctx.agentDefaultModel) service = ctx.agentDefaultModel;
    const selection = service && typeof service.currentSelection === 'function' ? service.currentSelection() : service;
    if (!isRecord(selection)) return undefined;
    if (typeof selection.provider !== 'string' || !selection.provider) return undefined;
    if (typeof selection.model !== 'string' || !selection.model) return undefined;
    return selection;
  } catch {
    return undefined;
  }
}

/**
 * Build the prompt text handed to the agent.
 *
 * Adds configured instructions and a one-line Discord channel context. This is
 * idempotent with the plugin entry's own prompt builder: when the caller
 * already prefixed the instruction block or the exact context line, it is not
 * duplicated.
 *
 * @param {{ text?: string, conversationLabel?: string, userName?: string }} input
 * @param {{ channelContext?: boolean, instructions?: string }} [config]
 * @returns {string}
 */
export function buildPromptText(input, config = {}) {
  const value = isRecord(input) ? input : {};
  const rawText = typeof value.text === 'string' ? value.text : String(value.text ?? '');
  const text = rawText.trim();
  const lines = [];
  const instructions = typeof config.instructions === 'string' ? config.instructions.trim() : '';
  if (instructions && !text.startsWith(instructions)) lines.push(instructions);
  if (config.channelContext) {
    const label = typeof value.conversationLabel === 'string' ? value.conversationLabel : '';
    const user = typeof value.userName === 'string' ? value.userName : '';
    if (label || user) {
      const contextLine = CONTEXT_LINE_PREFIX + (label || 'unknown') + ' · 用户: ' + (user || 'unknown') + ']';
      if (!text.includes(contextLine)) lines.push(contextLine);
    }
  }
  if (text) lines.push(text);
  return lines.join('\n');
}

/** Local fallback when the dsh-llm factory is unavailable or throws. */
function localUserMessage(text) {
  return {
    id: 'msg-' + randomUUID().replaceAll('-', ''),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}

function mintSessionId() {
  return 'session-' + randomUUID().replaceAll('-', '');
}

function readSessionSeq(session) {
  try {
    const seq = session && session.seq;
    return Number.isInteger(seq) && seq >= 0 ? seq : 0;
  } catch {
    return 0;
  }
}

function statusPayloadOf(args) {
  for (const arg of args) {
    if (isRecord(arg) && typeof arg.status === 'string' && isRecord(arg.agent)) return arg;
  }
  return undefined;
}

function errorPayloadOf(args) {
  for (const arg of args) {
    if (isRecord(arg) && isRecord(arg.agent) && 'error' in arg) return arg;
  }
  return undefined;
}

function failureFromTurnReason(reason) {
  const detail = isRecord(reason) && isRecord(reason.error) ? reason.error : undefined;
  const message = detail && typeof detail.message === 'string' && detail.message
    ? detail.message
    : '模型返回错误';
  const code = detail && typeof detail.code === 'string' && detail.code ? '（' + detail.code + '）' : '';
  return new Error('DSH 回合失败：' + message + code);
}

function failureFromAgentError(error) {
  return new Error('DSH 回合失败：' + describeError(error));
}

/**
 * Create the plugin's agent bridge.
 *
 * @param {object} options
 * @param {object} options.ctx cordis context with the `agents` service.
 * @param {object} [options.logger] host logger.
 * @param {object} [options.config] bridge config: workspace, provider, model,
 *   reasoningEffort, maxTokens, channelContext, instructions, turnTimeoutMs.
 * @param {object} options.sessionStore persisted mapping store.
 * @param {Function} [options.createUserMessage] test seam for the message factory.
 * @param {() => number} [options.now] clock seam.
 * @returns {{
 *   run(sessionKey: string, input: object, observer?: object): Promise<{sessionId: string, finalText: string, durationMs: number}>,
 *   reset(sessionKey: string): void,
 *   status(): {ready: boolean, liveSessions: number},
 *   dispose(): Promise<void>,
 *   reconcileWorkspaces(): Promise<number>
 * }}
 */
export function createAgentBridge(options = {}) {
  const ctx = options.ctx;
  if (!ctx || typeof ctx !== 'object') throw new TypeError('createAgentBridge: options.ctx is required');
  const sessionStore = options.sessionStore;
  if (!sessionStore || typeof sessionStore.get !== 'function' || typeof sessionStore.set !== 'function') {
    throw new TypeError('createAgentBridge: options.sessionStore with get/set is required');
  }
  const logger = normalizeLogger(options.logger);
  const config = isRecord(options.config) ? options.config : {};
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const injectedMessageFactory = typeof options.createUserMessage === 'function' ? options.createUserMessage : undefined;

  /** @type {Map<string, { sessionId: string, agent: object, handle?: object, owned: boolean }>} */
  const sessions = new Map();
  /** @type {Map<string, object>} sessionId -> active run collector */
  const activeCollectors = new Map();
  /** @type {Map<string, { running: boolean, waiters: Function[] }>} */
  const queues = new Map();
  const listenerDisposers = [];
  let disposed = false;

  const subscribe = () => {
    if (typeof ctx.on !== 'function') return;
    try {
      listenerDisposers.push(disposeOf(ctx.on('session/event', onSessionEvent)));
    } catch (error) {
      logger.warn('agent bridge: failed to subscribe to session/event: ' + describeError(error));
    }
    try {
      listenerDisposers.push(disposeOf(ctx.on('agent/status', (...args) => onAgentStatus(args))));
    } catch (error) {
      logger.debug('agent bridge: agent/status subscription unavailable: ' + describeError(error));
    }
    try {
      listenerDisposers.push(disposeOf(ctx.on('agent/error', (...args) => onAgentError(args))));
    } catch (error) {
      logger.debug('agent bridge: agent/error subscription unavailable: ' + describeError(error));
    }
  };

  const disposeOf = (result) => (typeof result === 'function' ? result : noop);

  const notify = (collector, method, value) => {
    try {
      const observer = collector.observer;
      const listener = observer && observer[method];
      if (typeof listener === 'function') listener(value);
    } catch (error) {
      logger.debug('agent bridge: observer ' + method + ' threw: ' + describeError(error));
    }
  };

  const setStatus = (collector, status) => {
    if (collector.status === status) return;
    collector.status = status;
    notify(collector, 'onStatus', status);
  };

  const sequenceFilter = (collector, event) => {
    const seq = typeof event.seq === 'number' ? event.seq : undefined;
    if (seq !== undefined) return seq >= collector.watermark;
    // No sequence number: only accept events after the run's first turn/start.
    if (event.type === 'turn/start') collector.sawTurnStart = true;
    return collector.sawTurnStart === true;
  };

  function onSessionEvent(subject, event) {
    try {
      if (!isRecord(event) || typeof event.type !== 'string') return;
      const sessionId = subject && subject.id;
      if (typeof sessionId !== 'string') return;
      const collector = activeCollectors.get(sessionId);
      if (!collector) return;
      if (!sequenceFilter(collector, event)) return;
      const data = isRecord(event.data) ? event.data : {};
      switch (event.type) {
        case 'turn/start': {
          collector.sawTurnStart = true;
          setStatus(collector, 'running');
          return;
        }
        case 'turn/end': {
          setStatus(collector, 'idle');
          if (isRecord(data.reason) && data.reason.kind === 'error' && !collector.failure) {
            collector.failure = failureFromTurnReason(data.reason);
          }
          return;
        }
        case 'tool/call': {
          const name = typeof data.name === 'string' && data.name ? data.name : 'tool';
          const callId = typeof data.callId === 'string' ? data.callId : '';
          if (callId) collector.callNames.set(callId, name);
          notify(collector, 'onActivity', toolCallLine(name, data.arguments));
          return;
        }
        case 'tool/result': {
          const message = isRecord(data.message) ? data.message : {};
          const callId = typeof message.toolCallId === 'string' ? message.toolCallId : '';
          const name = (callId && collector.callNames.get(callId)) || 'tool';
          const isError = message.isError === true || isRecord(data.error);
          notify(collector, 'onActivity', toolResultLine(name, isError));
          return;
        }
        case 'assistant/message': {
          const message = isRecord(data.message) ? data.message : {};
          const text = textOfContent(message.content);
          if (!text) return;
          collector.assistantTexts.push(text);
          notify(collector, 'onAssistantText', text);
          return;
        }
        default:
          return;
      }
    } catch (error) {
      logger.debug('agent bridge: session/event mapping failed: ' + describeError(error));
    }
  }

  function onAgentStatus(args) {
    try {
      const payload = statusPayloadOf(args);
      if (!payload) return;
      const sessionId = payload.agent.id;
      if (typeof sessionId !== 'string') return;
      const collector = activeCollectors.get(sessionId);
      if (!collector) return;
      if (payload.status === 'running' || payload.status === 'idle') setStatus(collector, payload.status);
    } catch (error) {
      logger.debug('agent bridge: agent/status mapping failed: ' + describeError(error));
    }
  }

  function onAgentError(args) {
    try {
      const payload = errorPayloadOf(args);
      if (!payload) return;
      const sessionId = payload.agent.id;
      if (typeof sessionId !== 'string') return;
      const collector = activeCollectors.get(sessionId);
      if (!collector) return;
      if (!collector.failure) collector.failure = failureFromAgentError(payload.error);
    } catch (error) {
      logger.debug('agent bridge: agent/error mapping failed: ' + describeError(error));
    }
  }

  const liveAgent = (sessionId) => {
    try {
      return typeof ctx.agents?.get === 'function' ? ctx.agents.get(sessionId) : undefined;
    } catch (error) {
      logger.debug('agent bridge: ctx.agents.get failed: ' + describeError(error));
      return undefined;
    }
  };

  /** Resolve the host workspace registry defensively (absent in some compositions). */
  const workspaceRegistry = () => {
    try {
      const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined;
      return registry || ctx.workspaceRegistry;
    } catch (error) {
      logger.debug('agent bridge: workspaceRegistry lookup failed: ' + describeError(error));
      return undefined;
    }
  };

  /**
   * Register a session under the DSH Workspace whose directory it runs in, so
   * the Web sidebar groups it as a project conversation instead of "未分组".
   * The workspace registry is the only owner of workspace membership; attaching
   * is idempotent and validated against the session header cwd.
   */
  const attachSessionToWorkspace = async (sessionId, cwdHint) => {
    const path = typeof cwdHint === 'string' && cwdHint.trim()
      ? cwdHint
      : (typeof config.workspace === 'string' && config.workspace.trim() ? config.workspace : undefined);
    if (!path) return;
    const registry = workspaceRegistry();
    if (!registry || typeof registry.resolveByPath !== 'function') return;
    try {
      const workspace = await registry.resolveByPath(path);
      if (!workspace || typeof workspace.attachSession !== 'function') {
        logger.debug('agent bridge: no registered workspace for ' + path + '; session stays ungrouped');
        return;
      }
      await workspace.attachSession(sessionId);
      logger.info('agent bridge: session ' + sessionId + ' attached to workspace ' + (typeof workspace.path === 'string' ? workspace.path : path));
    } catch (error) {
      logger.debug('agent bridge: workspace attach failed for ' + sessionId + ': ' + describeError(error));
    }
  };

  const persist = (sessionKey, entry, input) => {
    const meta = {};
    if (isRecord(input)) {
      if (typeof input.conversationLabel === 'string' && input.conversationLabel) {
        meta.conversationLabel = input.conversationLabel;
      }
      if (typeof input.userName === 'string' && input.userName) meta.userName = input.userName;
    }
    try {
      if (typeof sessionStore.set === 'function') sessionStore.set(sessionKey, entry.sessionId, meta);
    } catch (error) {
      logger.warn('agent bridge: failed to persist session mapping: ' + describeError(error));
    }
  };

  const entryFromHandle = (sessionId, handle) => {
    const agent = isRecord(handle) && handle.agent ? handle.agent : handle;
    const owned = Boolean(isRecord(handle) && typeof handle.dispose === 'function');
    return {
      sessionId,
      agent,
      ...(owned ? { handle } : {}),
      owned,
    };
  };

  async function resolveSession(sessionKey, input) {
    const cached = sessions.get(sessionKey);
    if (cached) {
      const live = liveAgent(cached.sessionId);
      if (live) {
        cached.agent = live;
        await attachSessionToWorkspace(cached.sessionId);
        return cached;
      }
      sessions.delete(sessionKey);
      if (cached.owned && cached.handle && typeof cached.handle.dispose === 'function') {
        Promise.resolve()
          .then(() => cached.handle.dispose())
          .catch((error) => logger.warn('agent bridge: stale handle dispose failed: ' + describeError(error)));
      }
    }

    let persistedId;
    try {
      const record = sessionStore.get(sessionKey);
      if (record && typeof record.sessionId === 'string' && record.sessionId) persistedId = record.sessionId;
    } catch (error) {
      logger.warn('agent bridge: session store read failed: ' + describeError(error));
    }

    if (persistedId) {
      const live = liveAgent(persistedId);
      if (live) {
        const entry = { sessionId: persistedId, agent: live, owned: false };
        sessions.set(sessionKey, entry);
        persist(sessionKey, entry, input);
        await attachSessionToWorkspace(persistedId);
        logger.info('agent bridge: reusing live host session ' + persistedId + ' for ' + sessionKey);
        return entry;
      }
      const agentOptions = resolveAgentOptions(ctx, config);
      try {
        const handle = await ctx.agents.resume({
          resumeSessionId: persistedId,
          ...(agentOptions ? { agentOptions } : {}),
        });
        const entry = entryFromHandle(persistedId, handle);
        sessions.set(sessionKey, entry);
        persist(sessionKey, entry, input);
        await attachSessionToWorkspace(persistedId);
        logger.info('agent bridge: resumed session ' + persistedId + ' for ' + sessionKey);
        return entry;
      } catch (error) {
        logger.warn('agent bridge: resume failed for ' + persistedId + '; creating a fresh session: ' + describeError(error));
      }
    }

    const sessionId = mintSessionId();
    const createOptions = { sessionId };
    if (typeof config.workspace === 'string' && config.workspace.trim()) {
      createOptions.meta = { cwd: config.workspace };
    }
    const agentOptions = resolveAgentOptions(ctx, config);
    if (!agentOptions) {
      throw new Error('no model route: configure runtime.provider/model or ensure agentDefaultModel is available');
    }
    createOptions.agentOptions = agentOptions;
    if (!ctx.agents || typeof ctx.agents.create !== 'function') {
      throw new Error('DSH agents 服务不可用，无法创建会话');
    }
    let handle;
    try {
      handle = await ctx.agents.create(createOptions);
    } catch (error) {
      throw new Error('无法创建 DSH 会话：' + describeError(error), { cause: error });
    }
    const entry = entryFromHandle(sessionId, handle);
    if (!entry.agent || typeof entry.agent.followup !== 'function') {
      throw new Error('ctx.agents.create 未返回可用的 Agent（缺少 followup）');
    }
    sessions.set(sessionKey, entry);
    persist(sessionKey, entry, input);
    await attachSessionToWorkspace(sessionId);
    logger.info('agent bridge: created session ' + sessionId + ' for ' + sessionKey);
    return entry;
  }

  /**
   * Attach every persisted conversation session to its Workspace so historical
   * Discord conversations stop appearing as "未分组". Idempotent; safe to call
   * once at plugin startup after the workspace registry is available.
   *
   * @returns {Promise<number>} number of persisted mappings examined
   */
  async function reconcileWorkspaces() {
    if (disposed) return 0;
    let records = [];
    try {
      records = typeof sessionStore.entries === 'function' ? sessionStore.entries() : [];
    } catch (error) {
      logger.debug('agent bridge: workspace reconcile could not read session store: ' + describeError(error));
      return 0;
    }
    let examined = 0;
    for (const record of records) {
      if (disposed) break;
      if (!record || typeof record.sessionId !== 'string' || !record.sessionId) continue;
      examined += 1;
      await attachSessionToWorkspace(record.sessionId);
    }
    return examined;
  }

  async function buildUserMessage(text) {
    const factory = injectedMessageFactory || (typeof createUserMessage === 'function' ? createUserMessage : undefined);
    if (factory) {
      try {
        return factory({ content: [{ type: 'text', text }], source: { kind: 'user' } });
      } catch (error) {
        logger.warn('agent bridge: createUserMessage failed; using local message: ' + describeError(error));
      }
    }
    return localUserMessage(text);
  }

  function waitForIdle(agent, timeoutMs) {
    const idle = Promise.resolve().then(() => agent.whenIdle());
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) return idle;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          if (typeof agent.cancel === 'function') agent.cancel({ kind: 'user' });
        } catch (error) {
          logger.debug('agent bridge: cancel after timeout failed: ' + describeError(error));
        }
        reject(new Error('DSH 回合超时（' + timeoutMs + 'ms）'));
      }, timeoutMs);
      idle.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async function executeRun(sessionKey, input, observer) {
    const startedAt = now();
    const entry = await resolveSession(sessionKey, input);
    const collector = {
      sessionId: entry.sessionId,
      observer: isRecord(observer) ? observer : {},
      watermark: readSessionSeq(entry.agent.session),
      sawTurnStart: false,
      status: undefined,
      failure: null,
      assistantTexts: [],
      callNames: new Map(),
    };
    activeCollectors.set(entry.sessionId, collector);
    try {
      setStatus(collector, 'running');
      const promptText = buildPromptText(input, config);
      const message = await buildUserMessage(promptText);
      collector.watermark = readSessionSeq(entry.agent.session);
      entry.agent.followup(message);
      const configuredTimeout = Number.isInteger(config.turnTimeoutMs) ? config.turnTimeoutMs : undefined;
      await waitForIdle(entry.agent, configuredTimeout);
      if (collector.failure) throw collector.failure;
      const finalText = collector.assistantTexts.length > 0
        ? collector.assistantTexts[collector.assistantTexts.length - 1]
        : '';
      persist(sessionKey, entry, input);
      const durationMs = Math.max(0, now() - startedAt);
      logger.debug('agent bridge: turn finished for ' + sessionKey + ' in ' + durationMs + 'ms (' + finalText.length + ' chars)');
      return { sessionId: entry.sessionId, finalText, durationMs };
    } finally {
      activeCollectors.delete(entry.sessionId);
    }
  }

  function runSerialized(sessionKey, task) {
    return new Promise((resolve, reject) => {
      let queue = queues.get(sessionKey);
      if (!queue) {
        queue = { running: false, waiters: [] };
        queues.set(sessionKey, queue);
      }
      const ownQueue = queue;
      const finish = () => {
        ownQueue.running = false;
        const next = ownQueue.waiters.shift();
        if (next) {
          next();
        } else if (queues.get(sessionKey) === ownQueue) {
          queues.delete(sessionKey);
        }
      };
      const launch = () => {
        ownQueue.running = true;
        Promise.resolve()
          .then(task)
          .then(
            (result) => {
              finish();
              resolve(result);
            },
            (error) => {
              finish();
              reject(error);
            },
          );
      };
      if (ownQueue.running) ownQueue.waiters.push(launch);
      else launch();
    });
  }

  const run = (sessionKey, input, observer) => {
    if (disposed) return Promise.reject(new Error('agent bridge 已关闭，无法执行回合'));
    if (typeof sessionKey !== 'string' || !sessionKey) {
      return Promise.reject(new TypeError('agentBridge.run: sessionKey must be a non-empty string'));
    }
    return runSerialized(sessionKey, () => executeRun(sessionKey, input, observer));
  };

  const reset = (sessionKey) => {
    const entry = sessions.get(sessionKey);
    sessions.delete(sessionKey);
    if (entry) activeCollectors.delete(entry.sessionId);
    try {
      if (typeof sessionStore.delete === 'function') sessionStore.delete(sessionKey);
    } catch (error) {
      logger.warn('agent bridge: failed to delete persisted mapping: ' + describeError(error));
    }
    if (entry && entry.owned && entry.handle && typeof entry.handle.dispose === 'function') {
      Promise.resolve()
        .then(() => entry.handle.dispose())
        .catch((error) => logger.warn('agent bridge: reset dispose failed: ' + describeError(error)));
    }
    logger.info('agent bridge: reset ' + sessionKey + (entry && entry.owned ? ' (disposed owned session)' : ''));
  };

  const status = () => ({
    ready: !disposed && Boolean(ctx.agents && typeof ctx.agents.get === 'function'),
    liveSessions: sessions.size,
  });

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    for (const disposeListener of listenerDisposers.splice(0)) {
      try {
        disposeListener();
      } catch (error) {
        logger.debug('agent bridge: listener dispose failed: ' + describeError(error));
      }
    }
    const entries = [...sessions.values()];
    sessions.clear();
    activeCollectors.clear();
    const owned = entries.filter((entry) => entry.owned && entry.handle && typeof entry.handle.dispose === 'function');
    const results = await Promise.allSettled(owned.map((entry) => Promise.resolve().then(() => entry.handle.dispose())));
    for (const result of results) {
      if (result.status === 'rejected') logger.warn('agent bridge: session dispose failed: ' + describeError(result.reason));
    }
    try {
      if (typeof sessionStore.flush === 'function') await sessionStore.flush();
    } catch (error) {
      logger.warn('agent bridge: session store flush failed: ' + describeError(error));
    }
    logger.info('agent bridge: disposed (' + owned.length + ' owned session(s))');
  };

  subscribe();

  return { run, reset, status, dispose, reconcileWorkspaces };
}
