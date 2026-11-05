/**
 * dsh-plugin-discord — native DeepSeek Harness plugin entry.
 *
 * Runs a Discord bot inside the DSH host process and bridges each Discord
 * conversation (channel / thread / DM) to a persistent DSH session through the
 * public ctx.agents API.
 *
 * Bundle/install metadata lives in package.json + cordis.patch.yml. The plugin
 * never aborts host startup: configuration or Discord login failures leave it
 * dormant and logged.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePluginConfig } from './config.js';
import { installDiscordProxy } from './proxy.js';
import { splitMessage } from './chunker.js';
import { createSessionStore } from './session-store.js';
import { createAgentBridge } from './agent-bridge.js';
import { resolveDiscordOptions } from './discord/options.js';
import { startDebugServer } from './debug-server.js';

export const name = 'discord';
export const inject = ['agents'];

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const HELP_TEXT = [
  '**dsh-plugin-discord 命令**',
  '!new      开启新会话（清空当前会话上下文）',
  '!status   查看会话 / 运行时状态',
  '!help     显示本帮助',
  '其余消息（服务器频道需 @bot）会交给 DSH agent 处理。',
].join('\n');

const STOP_TEXT = [
  '⚠️ DSH 插件不支持中断正在执行的回合。',
  '请等待本轮结束；想换全新上下文请发送 !new。',
].join('\n');

function resolveDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function makeLogger(ctx) {
  try {
    if (typeof ctx.logger === 'function') {
      const logger = ctx.logger('discord');
      if (logger && typeof logger.info === 'function' && typeof logger.error === 'function') return logger;
    }
  } catch {
    // fall through to console
  }
  return {
    debug: (...args) => console.debug('[discord]', ...args),
    info: (...args) => console.info('[discord]', ...args),
    warn: (...args) => console.warn('[discord]', ...args),
    error: (...args) => console.error('[discord]', ...args),
  };
}

function clip(text, max) {
  const value = String(text);
  return value.length <= max ? value : value.slice(0, Math.max(0, max - 1)) + '…';
}

function parseCommand(text, prefix) {
  if (!prefix || !text.startsWith(prefix)) return undefined;
  const body = text.slice(prefix.length).trim();
  if (!body) return undefined;
  const parts = body.split(/\s+/);
  const command = parts[0].toLowerCase();
  return { name: command, args: parts.slice(1) };
}

function createRateLimiter(rateLimit) {
  const hits = new Map();
  return {
    take(key) {
      const now = Date.now();
      const cutoff = now - rateLimit.windowMs;
      const list = (hits.get(key) || []).filter((time) => time > cutoff);
      if (list.length >= rateLimit.maxMessages) {
        hits.set(key, list);
        return { allowed: false, retryAfterMs: Math.max(0, list[0] + rateLimit.windowMs - now) };
      }
      list.push(now);
      hits.set(key, list);
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}

function safeFileName(value) {
  return String(value || 'attachment').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

function errorText(error) {
  if (error instanceof Error) return clip(error.message || error.name, 500);
  return clip(String(error), 500);
}

export function apply(ctx, rawConfig) {
  const logger = makeLogger(ctx);

  let config;
  try {
    config = resolvePluginConfig(rawConfig);
  } catch (error) {
    logger.error('dsh-plugin-discord: invalid configuration; plugin disabled', error);
    return;
  }

  const dshHome = resolveDshHome();
  const stateDir = config.stateDir || join(dshHome, 'dsh-plugin-discord');
  const store = createSessionStore({ filePath: join(stateDir, 'sessions.json'), logger });
  const bridge = createAgentBridge({
    ctx,
    logger,
    config: {
      ...config.runtime,
      channelContext: config.channelContext,
      instructions: config.instructions,
    },
    sessionStore: store,
  });
  void bridge.reconcileWorkspaces?.()
    .then((examined) => {
      if (typeof examined === 'number' && examined > 0) logger.info('workspace reconcile: attached ' + examined + ' Discord session(s) to workspaces');
    })
    .catch((error) => logger.debug('workspace reconcile failed: ' + errorText(error)));
  const rateLimiter = createRateLimiter(config.rateLimit);
  const rateNotices = new Map();
  const cleanupTasks = [];

  let stopped = false;
  const cleanup = async () => {
    if (stopped) return;
    stopped = true;
    for (const task of cleanupTasks.reverse()) {
      try {
        await task();
      } catch (error) {
        logger.warn('dsh-plugin-discord cleanup step failed', error);
      }
    }
    try {
      await bridge.dispose();
    } catch (error) {
      logger.warn('dsh-plugin-discord bridge dispose failed', error);
    }
    try {
      await store.flush();
    } catch (error) {
      logger.warn('dsh-plugin-discord session store flush failed', error);
    }
  };
  try {
    ctx.effect(() => () => {
      void cleanup();
    });
  } catch (error) {
    logger.warn('dsh-plugin-discord: failed to register cleanup effect', error);
  }

  const safeSend = async (inbound, text) => {
    try {
      return await inbound.reply.send(text);
    } catch (error) {
      logger.warn('failed to send Discord message', error);
      return undefined;
    }
  };
  const safeUpdate = async (inbound, sent, text) => {
    if (!sent) return;
    try {
      await inbound.reply.update(sent, text);
    } catch (error) {
      logger.debug('status message update failed', error);
    }
  };

  const renderStatus = (activities, done, durationMs) => {
    const head = done ? '✅ 已完成 · ' + (durationMs / 1000).toFixed(1) + 's' : '🤖 正在处理…';
    return clip([head, ...activities.slice(-6)].join('\n'), 1900);
  };

  const buildPromptText = (inbound) => {
    const lines = [];
    if (config.instructions) lines.push(config.instructions.trim());
    if (config.channelContext) {
      lines.push('[Discord 频道: ' + (inbound.conversationLabel || inbound.conversationId) + ' · 用户: ' + (inbound.userName || inbound.userId) + ']');
    }
    const text = String(inbound.text || '').trim();
    if (text) lines.push(text);
    if (!text && inbound.attachments.length > 0) lines.push('[用户发送了附件]');
    return lines.join('\n');
  };

  const saveImageAttachments = async (inbound, promptText) => {
    const images = inbound.attachments.filter((attachment) => attachment.kind === 'image' && attachment.data);
    if (images.length === 0) return promptText;
    const dir = join(stateDir, 'attachments', safeFileName(inbound.conversationId));
    await mkdir(dir, { recursive: true });
    const notes = [];
    for (const image of images) {
      const fileName = Date.now() + '-' + safeFileName(image.name || 'image.png');
      const filePath = join(dir, fileName);
      await writeFile(filePath, Buffer.from(image.data));
      notes.push('[图片已保存，可用 read_image 查看: ' + filePath + ']');
    }
    const extra = notes.join('\n');
    return promptText ? promptText + '\n' + extra : extra;
  };

  const handleCommand = async (inbound, command, sessionKey) => {
    if (command.name === 'new' || command.name === 'reset') {
      bridge.reset(sessionKey);
      await safeSend(inbound, '🆕 已开启新会话，下一条消息使用全新上下文。');
      return;
    }
    if (command.name === 'status') {
      const record = store.get(sessionKey);
      const runtimeStatus = bridge.status();
      const lines = [
        '**dsh-plugin-discord 状态**',
        '- 运行时: ' + (runtimeStatus.ready ? '✅ ready' : '⏳ 未就绪'),
        '- 当前会话: ' + (record ? record.sessionId : '尚未创建'),
        '- 活跃会话: ' + runtimeStatus.liveSessions,
        '- 工作区: ' + (config.runtime.workspace || '(DSH 默认)'),
      ];
      await safeSend(inbound, lines.join('\n'));
      return;
    }
    if (command.name === 'stop' || command.name === 'cancel') {
      await safeSend(inbound, STOP_TEXT);
      return;
    }
    await safeSend(inbound, '未知命令: ' + command.name + '\n\n' + HELP_TEXT);
  };

  const handleInbound = async (inbound) => {
    const sessionKey = inbound.conversationId;
    const text = String(inbound.text || '').trim();
    const command = parseCommand(text, inbound.commandPrefix || '!');
    if (command) {
      await handleCommand(inbound, command, sessionKey);
      return;
    }
    if (!text && inbound.attachments.length === 0) return;

    const userKey = inbound.userId || 'unknown';
    const decision = rateLimiter.take(userKey);
    if (!decision.allowed) {
      const last = rateNotices.get(userKey) || 0;
      if (Date.now() - last >= config.rateLimit.windowMs) {
        rateNotices.set(userKey, Date.now());
        await safeSend(inbound, '⏳ 发送太快，请 ' + Math.max(1, Math.ceil(decision.retryAfterMs / 1000)) + ' 秒后再试。');
      }
      return;
    }
    if (text.length > config.maxPromptChars) {
      await safeSend(inbound, '消息过长（' + text.length + ' 字符，上限 ' + config.maxPromptChars + '）。');
      return;
    }

    let statusMessage;
    if (config.activityUpdates) statusMessage = await safeSend(inbound, '🤖 正在处理…');
    const activities = [];
    let updateTimer;
    let typingTimer;
    const refresh = async (done, durationMs) => {
      if (!statusMessage) return;
      await safeUpdate(inbound, statusMessage, renderStatus(activities, done, durationMs));
    };
    const scheduleRefresh = () => {
      if (!statusMessage || updateTimer) return;
      updateTimer = setTimeout(() => {
        updateTimer = undefined;
        void refresh(false, 0);
      }, config.activityIntervalMs);
      if (typeof updateTimer.unref === 'function') updateTimer.unref();
    };
    if (config.typingIndicator && inbound.reply.typing) {
      const typing = () => {
        Promise.resolve(inbound.reply.typing()).catch(() => undefined);
      };
      typing();
      typingTimer = setInterval(typing, 8000);
      if (typeof typingTimer.unref === 'function') typingTimer.unref();
    }

    try {
      let promptText;
      try {
        promptText = await saveImageAttachments(inbound, buildPromptText(inbound));
      } catch (error) {
        logger.warn('failed to persist image attachments', error);
        promptText = buildPromptText(inbound);
      }
      const result = await bridge.run(
        sessionKey,
        {
          text: promptText,
          conversationLabel: inbound.conversationLabel,
          userName: inbound.userName,
        },
        {
          onActivity(line) {
            activities.push(clip(line, 120));
            scheduleRefresh();
          },
          onStatus(status) {
            if (status === 'idle') scheduleRefresh();
          },
        },
      );
      if (updateTimer) {
        clearTimeout(updateTimer);
        updateTimer = undefined;
      }
      await refresh(true, result.durationMs);
      const chunks = splitMessage(result.finalText, 1900);
      if (chunks.length === 0) {
        if (!statusMessage) await safeSend(inbound, '✅ 完成（本轮没有文本输出）。');
      } else {
        for (const chunk of chunks) await safeSend(inbound, chunk);
      }
      logger.info('turn finished', {
        conversation: inbound.conversationId,
        sessionId: result.sessionId,
        durationMs: result.durationMs,
        replyChars: result.finalText.length,
      });
    } catch (error) {
      logger.error('turn failed', error, { conversation: inbound.conversationId });
      if (updateTimer) {
        clearTimeout(updateTimer);
        updateTimer = undefined;
      }
      if (statusMessage) await safeUpdate(inbound, statusMessage, '❌ 处理失败');
      await safeSend(inbound, '❌ 处理失败：' + errorText(error) + '\n（可发送 !new 开启新会话后重试）');
    } finally {
      if (typingTimer) clearInterval(typingTimer);
      if (updateTimer) clearTimeout(updateTimer);
    }
  };

  // ---- Discord channel -----------------------------------------------------
  let channel;
  const RETRY_DELAYS_MS = [10_000, 20_000, 30_000, 60_000, 120_000, 300_000];
  const startDiscord = async () => {
    let proxySupport;
    if (config.proxy) {
      try {
        proxySupport = await installDiscordProxy({ proxyUrl: config.proxy, logger, pluginDir: PLUGIN_DIR });
        logger.info('Discord proxy enabled: ' + config.proxy + ' (instrumented ' + proxySupport.copies + ' transports)');
      } catch (error) {
        logger.error('dsh-plugin-discord: failed to install Discord proxy', error);
      }
    }
    cleanupTasks.push(async () => {
      try {
        if (channel) await channel.stop();
      } finally {
        await proxySupport?.restore();
      }
    });

    // Token sources, in order: discord.token (literal/env:NAME), then tokenFile.
    // tokenFile exists because Windows apps do not reliably inherit a newly
    // setx'd user environment variable until a full sign-out / reboot.
    let token = typeof config.discord.token === 'string' ? config.discord.token : undefined;
    if (config.tokenFile) {
      try {
        const filePath = config.tokenFile.startsWith('~/')
          ? join(dshHome, config.tokenFile.slice(2))
          : config.tokenFile;
        const fromFile = (await readFile(filePath, 'utf8')).trim().replace(/^DISCORD_BOT_TOKENs*=s*/i, '');
        if (fromFile) token = fromFile;
      } catch (error) {
        logger.warn('dsh-plugin-discord: cannot read tokenFile ' + config.tokenFile + ': ' + errorText(error));
      }
    }

    let discordOptions;
    try {
      discordOptions = resolveDiscordOptions({ ...config.discord, ...(token ? { token } : {}) });
    } catch (error) {
      logger.warn('dsh-plugin-discord: Discord options invalid; Discord disabled: ' + errorText(error));
      await proxySupport?.restore();
      return;
    }
    if (!discordOptions.token) {
      logger.info('dsh-plugin-discord: no Discord token configured; Discord channel disabled');
      await proxySupport?.restore();
      return;
    }

    let attempt = 0;
    while (!stopped) {
      try {
        const { createDiscordChannel } = await import('./discord/index.js');
        channel = createDiscordChannel({
          config: {
            ...discordOptions,
            stateDir,
            typingIndicator: config.typingIndicator && (!discordOptions.reply || discordOptions.reply.typingIndicator !== false),
            activityUpdates: config.activityUpdates && (!discordOptions.reply || discordOptions.reply.activityUpdates !== false),
          },
          logger,
          ...(proxySupport ? { fetchImpl: proxySupport.fetchImpl } : {}),
          onMessage(inbound) {
            void handleInbound(inbound).catch((error) => {
              logger.error('inbound handling failed', error);
            });
          },
        });
        await channel.start();
        logger.info('Discord channel started as ' + (channel.client && channel.client.user ? channel.client.user.tag : '(unknown)'));
        return;
      } catch (error) {
        attempt += 1;
        const message = errorText(error);
        const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
        if (/disallowed intents|4014/i.test(message)) {
          logger.warn('Discord login rejected (4014 Used disallowed intents). Open Discord Developer Portal -> your app -> Bot -> Privileged Gateway Intents -> enable MESSAGE CONTENT INTENT, then Save. Retrying in ' + Math.round(delay / 1000) + 's.');
        } else {
          logger.warn('Discord channel failed to start (attempt ' + attempt + '): ' + message + '; retrying in ' + Math.round(delay / 1000) + 's.');
        }
        try {
          if (channel) await channel.stop();
        } catch {
          // ignore teardown failure before retry
        }
        channel = undefined;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, delay);
          if (typeof timer.unref === 'function') timer.unref();
        });
      }
    }
    await proxySupport?.restore();
  };
  void startDiscord().catch((error) => logger.error('dsh-plugin-discord: Discord startup failed', error));

  // ---- Loopback debug / self-test endpoint (development only) ------------
  if (config.debugHttpPort > 0) {
    try {
      const debug = startDebugServer({ port: config.debugHttpPort, bridge, logger });
      cleanupTasks.push(() => debug.close());
      debug.ready
        .then((info) => logger.info('plugin debug endpoint listening on ' + info.url))
        .catch((error) => logger.warn('debug endpoint failed to listen', error));
    } catch (error) {
      logger.warn('dsh-plugin-discord: failed to start debug endpoint', error);
    }
  }

  logger.info('dsh-plugin-discord loaded', {
    stateDir,
    debugHttpPort: config.debugHttpPort,
    proxy: config.proxy || '(none)',
  });
}
