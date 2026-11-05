/**
 * Discord channel for dsh-plugin-discord.
 *
 * The channel owns one discord.js Client. It normalizes inbound messages into
 * DiscordInbound values and calls the plugin-provided onMessage callback; the
 * plugin entry bridges those to DSH sessions. Replies travel back through the
 * reply object on each inbound (send/update/delete/typing), which wraps either
 * a discord.js channel or a deferred ephemeral slash-command response.
 *
 * Slash commands are thin shims over the plugin's text command parser:
 * /dsh status becomes "!status". Failures never throw out of the message or
 * interaction handlers: they are logged and (where relevant) reported back.
 */

import {
  EMPTY_REPLY_TEXT,
  detectMentionsBot,
  isAllowedId,
  isCommandText,
  locationFromChannel,
  resolveConversation,
  splitDiscordText,
  stripBotMention,
} from './conversation.js';
import { resolveDiscordOptions } from './options.js';
import { DSH_COMMAND_NAME, interactionCommandText, registerDshCommands } from './commands.js';
import {
  appendPromptNotes,
  classifyAttachment,
  downloadAttachment,
  formatAttachmentCountNote,
  formatAttachmentFailureNote,
  formatAttachmentSkipNote,
  formatSavedFileNote,
  saveAttachmentFile,
} from './attachments.js';
import { DISCORD_EVENTS, createDefaultDiscordClient } from './client.js';
import { createSafeLogger, errorMessage, isUnknownMessageError } from './util.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create the Discord channel.
 *
 * @param {object} options
 * @param {unknown} options.config  raw plugin/channel options
 * @param {unknown} options.logger  host logger (cordis logger, console or fake)
 * @param {(inbound: object) => void | Promise<void>} options.onMessage
 * @param {() => object} [options.clientFactory] test seam: fake discord.js client
 * @param {typeof fetch} [options.fetchImpl] test seam: attachment fetch
 * @param {() => number} [options.now] test seam: clock
 * @param {object} [options.env] test seam: environment (defaults to process.env)
 * @param {string} [options.stateDir] attachment state directory (also read from config.stateDir)
 * @returns {{ start(): Promise<void>, stop(): Promise<void>, readonly client: unknown }}
 */
export function createDiscordChannel(options = {}) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('createDiscordChannel options must be an object');
  }
  if (typeof options.onMessage !== 'function') {
    throw new TypeError('createDiscordChannel requires an onMessage callback');
  }
  return new DiscordChannel(options);
}

// ---------------------------------------------------------------------------
// Small structural views of the discord.js objects we touch
// ---------------------------------------------------------------------------

const event = DISCORD_EVENTS;

function createChannelReply(channel, config) {
  const logger = config.logger;
  const typingEnabled = config.typingEnabled;
  const activityUpdatesEnabled = config.activityUpdatesEnabled;

  return {
    async send(text) {
      const chunks = splitDiscordText(text);
      if (chunks.length === 0) chunks.push(EMPTY_REPLY_TEXT);
      const messages = [];
      for (let index = 0; index < chunks.length; index += 1) {
        try {
          messages.push(await channel.send(chunks[index]));
        } catch (error) {
          if (messages.length === 0) throw error;
          logger.error('Discord 消息分片发送失败', error, { chunk: index, totalChunks: chunks.length });
          break;
        }
      }
      return { id: messages[0] && messages[0].id, raw: { messages } };
    },

    async update(sent, text) {
      if (!activityUpdatesEnabled) {
        logger.debug('Discord 活动状态更新已禁用，跳过 update');
        return;
      }
      const messages = messagesOf(sent);
      const first = messages[0];
      if (!first) {
        logger.debug('Discord update 缺少可编辑消息，跳过');
        return;
      }
      const chunks = splitDiscordText(text);
      if (chunks.length === 0) chunks.push(EMPTY_REPLY_TEXT);
      try {
        await first.edit(chunks[0]);
      } catch (error) {
        if (isUnknownMessageError(error)) {
          logger.debug('Discord 状态消息已被删除，忽略本次 update', { messageId: first.id });
          return;
        }
        logger.warn('Discord 消息编辑失败', { messageId: first.id, error: errorMessage(error) });
        return;
      }
      for (let index = 1; index < chunks.length; index += 1) {
        try {
          messages.push(await channel.send(chunks[index]));
        } catch (error) {
          logger.warn('Discord 消息编辑分片发送失败', { chunk: index, error: errorMessage(error) });
          break;
        }
      }
    },

    async delete(sent) {
      const messages = messagesOf(sent);
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        try {
          if (typeof message.delete === 'function') await message.delete();
        } catch (error) {
          logger.debug('Discord 消息删除失败', { messageId: message.id, error: errorMessage(error) });
        }
      }
    },

    async typing() {
      if (!typingEnabled) return;
      try {
        if (typeof channel.sendTyping === 'function') await channel.sendTyping();
      } catch (error) {
        logger.debug('Discord typing 指示发送失败', { error: errorMessage(error) });
      }
    },
  };
}

function createInteractionReply(interaction, config) {
  const logger = config.logger;
  const activityUpdatesEnabled = config.activityUpdatesEnabled;
  const messages = [];
  let initialSent = false;

  return {
    async send(text) {
      const chunks = splitDiscordText(text);
      if (chunks.length === 0) chunks.push(EMPTY_REPLY_TEXT);
      let firstMessage = null;
      for (let index = 0; index < chunks.length; index += 1) {
        const content = chunks[index];
        try {
          let message;
          if (!initialSent) {
            initialSent = true;
            message = await interaction.editReply(content);
          } else {
            message = await interaction.followUp({ content, ephemeral: true });
          }
          messages.push(message);
          if (!firstMessage) firstMessage = message;
        } catch (error) {
          if (!firstMessage) throw error;
          logger.error('Discord 交互回复分片发送失败', error, { chunk: index, totalChunks: chunks.length });
          break;
        }
      }
      return { id: firstMessage && firstMessage.id, raw: { messages } };
    },

    async update(sent, text) {
      if (!activityUpdatesEnabled) return;
      const target = messagesOf(sent)[0];
      if (!target) return;
      const chunks = splitDiscordText(text);
      if (chunks.length === 0) chunks.push(EMPTY_REPLY_TEXT);
      try {
        await target.edit(chunks[0]);
      } catch (error) {
        if (isUnknownMessageError(error)) {
          logger.debug('Discord 交互回复已被删除，忽略本次 update');
          return;
        }
        logger.warn('Discord 交互回复编辑失败', { error: errorMessage(error) });
      }
    },

    async delete(sent) {
      const targets = messagesOf(sent);
      if (targets.length === 0) {
        try {
          if (interaction.deferred || interaction.replied) await interaction.deleteReply();
        } catch (error) {
          logger.debug('Discord 交互回复删除失败', { error: errorMessage(error) });
        }
        return;
      }
      for (let index = targets.length - 1; index >= 0; index -= 1) {
        try {
          if (typeof targets[index].delete === 'function') await targets[index].delete();
        } catch (error) {
          logger.debug('Discord 交互回复删除失败', { error: errorMessage(error) });
        }
      }
    },

    async typing() {
      // Ephemeral interaction replies do not show typing indicators.
    },
  };
}

function messagesOf(sent) {
  const raw = sent && sent.raw;
  if (!raw || typeof raw !== 'object') return [];
  const messages = raw.messages;
  if (!Array.isArray(messages)) return [];
  return messages.filter((item) => {
    return Boolean(item) && typeof item.edit === 'function';
  });
}

// ---------------------------------------------------------------------------
// Channel implementation
// ---------------------------------------------------------------------------

class DiscordChannel {
  constructor(input) {
    this.rawConfig = input.config;
    this.onMessage = input.onMessage;
    this.injectedClientFactory = typeof input.clientFactory === 'function' ? input.clientFactory : null;
    this.injectedFetch = typeof input.fetchImpl === 'function' ? input.fetchImpl : undefined;
    this.clock = typeof input.now === 'function' ? input.now : () => Date.now();
    this.env = input.env;
    this.explicitStateDir = input.stateDir;
    this.logger = createSafeLogger(input.logger, { adapter: 'discord' });
    this.options = null;
    this.botUserId = '';
    this.started = false;
    this._client = null;
  }

  /** Underlying discord.js Client (undefined before start). */
  get client() {
    return this._client;
  }

  async start() {
    if (this.started) return;

    const options = resolveDiscordOptions(this.rawConfig || {}, {
      env: this.env,
      stateDir: this.explicitStateDir,
    });
    this.options = options;
    if (options.unknownKeys.length > 0) {
      this.logger.warn('discord 配置包含未知配置项（已忽略）', { keys: options.unknownKeys });
    }

    const client = await this.createClient();
    this._client = client;
    this.attachListeners(client);

    try {
      await client.login(options.token);
      if (!client.isReady()) await waitForReady(client, options.readyTimeoutMs);
      const botUserId = client.user && client.user.id;
      if (!botUserId) throw new Error('Discord 登录后无法解析机器人用户 ID');
      this.botUserId = botUserId;
      this.started = true;
      this.logger.info('Discord 频道已启动', {
        botUserId,
        applicationId: options.applicationId || (client.application && client.application.id) || null,
        sessionScope: options.sessionScope,
        requireMentionInGuild: options.requireMentionInGuild,
        allowGuilds: options.allowGuilds.length,
        allowChannels: options.allowChannels.length,
        allowUsers: options.allowUsers.length,
        attachments: options.attachments.enabled,
        stateDir: options.stateDir,
      });

      if (options.registerSlashCommands) {
        const applicationId = options.applicationId || (client.application && client.application.id) || null;
        const registrar = client.application && client.application.commands;
        await registerDshCommands(registrar, this.logger, applicationId);
      }
    } catch (error) {
      await this.teardown();
      throw normalizeStartError(error);
    }
  }

  async stop() {
    await this.teardown();
  }

  async createClient() {
    if (this.injectedClientFactory) return this.injectedClientFactory();
    return createDefaultDiscordClient();
  }

  async teardown() {
    const client = this._client;
    this._client = null;
    this.started = false;
    this.options = null;
    this.botUserId = '';
    if (!client) return;
    try {
      await client.destroy();
    } catch (error) {
      this.logger.warn('Discord 客户端关闭失败', { error: errorMessage(error) });
    }
  }

  attachListeners(client) {
    client.on(event.MESSAGE_CREATE, (message) => {
      this.handleMessage(message).catch((error) => this.logger.error('处理 Discord 消息失败', error));
    });
    client.on(event.INTERACTION_CREATE, (interaction) => {
      this.handleInteraction(interaction).catch((error) => this.logger.error('处理 Discord 交互失败', error));
    });
    client.on(event.ERROR, (error) => {
      this.logger.error('Discord 客户端错误', error);
    });
    client.on(event.SHARD_ERROR, (error, shardId) => {
      this.logger.error('Discord shard 错误', error, { shardId });
    });
    client.on(event.SHARD_DISCONNECT, (payload, shardId) => {
      if (payload && payload.code === 4014) {
        this.logger.error(
          'Discord 网关关闭 (4014): 使用了未启用的 intents。请在 Discord Developer Portal 的 Bot 页面开启 MESSAGE CONTENT INTENT 后重启 DSH。',
          undefined,
          { shardId },
        );
        return;
      }
      this.logger.debug('Discord shard 断开', { shardId, code: payload && payload.code });
    });
    client.once(event.CLIENT_READY, (readyClient) => {
      this.logger.info('Discord 网关已就绪', { botUserId: readyClient.user && readyClient.user.id });
    });
  }

  async handleMessage(message) {
    const options = this.options;
    const logger = this.logger;
    if (!options || !logger || !this.botUserId || !this.started) return;

    try {
      if (!message || !message.author || message.author.bot) return;
      if (message.author.id === this.botUserId) return;
      if (message.system) return;
      if (message.webhookId) return;

      const channel = message.channel;
      if (!channel || typeof channel.send !== 'function') return;
      const isDirect = typeof channel.isDMBased === 'function' ? channel.isDMBased() : !message.guildId;
      const guildId = isDirect ? null : message.guildId || (message.guild && message.guild.id) || null;
      if (!isDirect && !guildId) {
        logger.debug('Discord 消息缺少 guildId，忽略');
        return;
      }
      const channelId = message.channelId || channel.id;
      const parentId = typeof channel.parentId === 'string' ? channel.parentId : null;
      if (!this.isAllowed(message.author.id, isDirect, guildId, channelId, parentId)) {
        logger.debug('Discord 消息被 allowlist 拒绝', { guildId, channelId, userId: message.author.id });
        return;
      }

      const content = typeof message.content === 'string' ? message.content : '';
      const mentionedUserIds =
        message.mentions && message.mentions.users && typeof message.mentions.users.keys === 'function'
          ? message.mentions.users.keys()
          : null;
      const mentionsBot = detectMentionsBot({
        isDirect,
        botId: this.botUserId,
        mentionedUserIds,
        content,
      });
      const command = isCommandText(content, options.commandPrefix);
      if (!isDirect && options.requireMentionInGuild && !mentionsBot && !command) {
        logger.debug('Discord 消息未提及机器人，忽略', { guildId, channelId });
        return;
      }

      const author = message.author;
      const userName = author.globalName || author.displayName || author.username || author.id;
      const channelInfo = {
        id: channelId,
        name: channel.name || null,
        parentId,
        isDM: isDirect,
        isThread: typeof channel.isThread === 'function' ? channel.isThread() : false,
      };
      const location = locationFromChannel({
        guildId: isDirect ? null : guildId,
        guildName: (message.guild && message.guild.name) || null,
        channel: channelInfo,
        userId: author.id,
        userName,
      });
      const conversation = resolveConversation(location, options.sessionScope, author.id);
      const cleanedText = stripBotMention(content, this.botUserId);
      const attachmentResult = await this.collectAttachments(message, conversation.id, options, logger);
      const text = appendPromptNotes(cleanedText, attachmentResult.notes);
      if (!text && attachmentResult.refs.length === 0) {
        logger.debug('Discord 消息清理后为空，忽略', { conversationId: conversation.id });
        return;
      }

      const reply = createChannelReply(channel, {
        logger,
        typingEnabled: options.reply.typingIndicator,
        activityUpdatesEnabled: options.reply.activityUpdates,
      });
      const inbound = {
        conversationId: conversation.id,
        conversationLabel: conversation.label,
        userId: author.id,
        userName,
        text,
        isDirect,
        mentionsBot,
        attachments: attachmentResult.refs,
        commandPrefix: options.commandPrefix,
        reply,
      };
      logger.debug('Dispatch Discord 消息', {
        conversationId: conversation.id,
        userId: author.id,
        chars: text.length,
        attachments: attachmentResult.refs.length,
        mentionsBot,
      });
      this.emitInbound(inbound);
    } catch (error) {
      logger.error('处理 Discord 消息失败', error);
    }
  }

  async handleInteraction(interaction) {
    const options = this.options;
    const logger = this.logger;
    if (!options || !logger) return;

    try {
      if (!interaction || typeof interaction.isChatInputCommand !== 'function' || !interaction.isChatInputCommand()) return;
      if (interaction.commandName !== DSH_COMMAND_NAME) return;
      const subcommand = readSubcommand(interaction);
      const text = interactionCommandText(options.commandPrefix, interaction.commandName, subcommand);
      if (!text) {
        logger.debug('忽略不支持的 /dsh 子命令', { subcommand });
        return;
      }

      const rawChannel = interaction.channel;
      const channelId = interaction.channelId || (rawChannel && rawChannel.id) || null;
      if (!channelId) {
        logger.warn('忽略 Discord 交互: 频道不可用');
        return;
      }
      const guildId = interaction.guildId || (interaction.guild && interaction.guild.id) || null;
      const isDirect = !guildId;
      const parentId = rawChannel && typeof rawChannel.parentId === 'string' ? rawChannel.parentId : null;
      if (!this.isAllowed(interaction.user.id, isDirect, isDirect ? null : guildId, channelId, parentId)) {
        await replyInteractionNotice(interaction, '你没有权限使用此命令。', logger);
        return;
      }

      const channelInfo = {
        id: channelId,
        name: (rawChannel && rawChannel.name) || null,
        parentId,
        isDM: isDirect,
        isThread: rawChannel && typeof rawChannel.isThread === 'function' ? rawChannel.isThread() : false,
      };
      const user = interaction.user;
      const userName = user.globalName || user.displayName || user.username || user.id;
      const location = locationFromChannel({
        guildId: isDirect ? null : guildId,
        guildName: (interaction.guild && interaction.guild.name) || null,
        channel: channelInfo,
        userId: user.id,
        userName,
      });
      const conversation = resolveConversation(location, options.sessionScope, user.id);

      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
      }
      const reply = createInteractionReply(interaction, {
        logger,
        activityUpdatesEnabled: options.reply.activityUpdates,
      });
      const inbound = {
        conversationId: conversation.id,
        conversationLabel: conversation.label,
        userId: user.id,
        userName,
        text,
        isDirect,
        mentionsBot: !isDirect,
        attachments: [],
        commandPrefix: options.commandPrefix,
        reply,
      };
      logger.debug('Dispatch Discord 斜杠命令', {
        command: interaction.commandName,
        subcommand,
        conversationId: conversation.id,
      });
      this.emitInbound(inbound);
    } catch (error) {
      logger.error('处理 Discord 交互失败', error);
    }
  }

  emitInbound(inbound) {
    try {
      const result = this.onMessage(inbound);
      if (result && typeof result.then === 'function') {
        result.catch((error) => this.logger.error('onMessage 回调失败', error));
      }
    } catch (error) {
      this.logger.error('onMessage 回调失败', error);
    }
  }

  isAllowed(userId, isDirect, guildId, channelId, parentId) {
    const options = this.options;
    if (!options) return false;
    if (!isAllowedId(options.allowUsers, userId)) return false;
    if (isDirect) return true;
    if (!isAllowedId(options.allowGuilds, guildId)) return false;
    if (options.allowChannels.length > 0 && !isAllowedId(options.allowChannels, channelId, parentId)) {
      return false;
    }
    return true;
  }

  async collectAttachments(message, conversationId, options, logger) {
    const refs = [];
    const notes = [];
    const collection = message.attachments;
    const all = collection && typeof collection.values === 'function' ? Array.from(collection.values()) : [];
    if (all.length === 0) return { refs, notes };

    const limits = options.attachments;
    if (!limits.enabled) {
      logger.debug('Discord 附件处理已关闭，忽略附件', { count: all.length });
      return { refs, notes };
    }

    const selected = all.slice(0, limits.maxCount);
    if (all.length > selected.length) {
      notes.push(formatAttachmentCountNote(all.length - selected.length));
    }

    for (let index = 0; index < selected.length; index += 1) {
      const attachment = selected[index] || {};
      const name = attachment.name || 'attachment-' + (index + 1);
      const descriptor = {
        name,
        contentType: attachment.contentType || null,
        size: attachment.size === undefined ? null : attachment.size,
        url: attachment.url || null,
      };
      const classification = classifyAttachment(descriptor, limits, index);
      if (classification.action === 'skip') {
        if (classification.reason === 'too-large' || classification.reason === 'unavailable') {
          notes.push(formatAttachmentSkipNote(name, classification.reason));
        }
        continue;
      }
      if (!descriptor.url) continue;

      try {
        const data = await downloadAttachment(descriptor.url, {
          maxBytes: limits.maxBytes,
          fetchImpl: this.injectedFetch,
        });
        if (classification.action === 'image') {
          refs.push({ kind: 'image', name, mimeType: classification.mimeType, data });
          continue;
        }
        const savedPath = await saveAttachmentFile(options.stateDir, conversationId, name, data, {
          timestamp: this.clock(),
          index,
        });
        refs.push({ kind: 'file', name, mimeType: classification.mimeType, path: savedPath });
        notes.push(formatSavedFileNote(savedPath));
      } catch (error) {
        logger.warn('Discord 附件处理失败（仅记录并继续处理消息）', { name, error: errorMessage(error) });
        notes.push(formatAttachmentFailureNote(name));
      }
    }

    return { refs, notes };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readSubcommand(interaction) {
  try {
    const value = interaction.options.getSubcommand(false);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

async function replyInteractionNotice(interaction, message, logger) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: message, ephemeral: true });
    } else {
      await interaction.reply({ content: message, ephemeral: true });
    }
  } catch (error) {
    logger.debug('Discord 交互提示发送失败', { error: errorMessage(error) });
  }
}

function waitForReady(client, timeoutMs) {
  if (typeof client.isReady === 'function' && client.isReady()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const onReady = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof client.off === 'function') client.off(event.CLIENT_READY, onReady);
      resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (typeof client.off === 'function') client.off(event.CLIENT_READY, onReady);
      reject(new Error('等待 Discord 网关就绪超时 (' + timeoutMs + 'ms)，请检查网络、token 与 intents。'));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    client.once(event.CLIENT_READY, onReady);
  });
}

function normalizeStartError(error) {
  const message = errorMessage(error);
  const code = error && typeof error === 'object' ? error.code : undefined;
  if (code === 4014 || /disallowed intents/i.test(message)) {
    return new Error(
      'Discord 拒绝了网关连接 (4014 disallowed intents)：请在 Discord Developer Portal 的 Bot 页面开启 MESSAGE CONTENT INTENT，然后重启 DSH。原始错误: ' +
        message,
    );
  }
  if (code === 4013 || /invalid intents/i.test(message)) {
    return new Error(
      'Discord 拒绝了网关连接 (4013 invalid intents)：请检查 Bot 的 privileged intents 设置与 discord.js 版本。原始错误: ' + message,
    );
  }
  if (/invalid token|tokeninvalid|401: unauthorized/i.test(message)) {
    return new Error(
      'Discord 登录失败: bot token 无效。请重新生成 token 并更新 DISCORD_BOT_TOKEN 环境变量。原始错误: ' + message,
    );
  }
  return new Error('Discord 频道启动失败: ' + message);
}

// ---------------------------------------------------------------------------
// Re-exports for the plugin entry and tests
// ---------------------------------------------------------------------------

export {
  DISCORD_MAX_MESSAGE_CHARS,
  EMPTY_REPLY_TEXT,
  detectMentionsBot,
  isAllowedId,
  isCommandText,
  locationFromChannel,
  resolveConversation,
  splitDiscordText,
  stripBotMention,
} from './conversation.js';
export {
  IMAGE_MIME_ALLOWLIST,
  appendPromptNotes,
  classifyAttachment,
  normalizeImageMime,
  safeConversationDirName,
  sanitizeFileName,
} from './attachments.js';
export { DiscordOptionsError, resolveDiscordOptions } from './options.js';
export {
  DSH_COMMAND_NAME,
  DSH_SUBCOMMANDS,
  buildDshCommandData,
  interactionCommandText,
  isDshSubcommand,
  registerDshCommands,
} from './commands.js';
export { DISCORD_EVENTS, createDefaultDiscordClient } from './client.js';
export { createSafeLogger, isUnknownMessageError } from './util.js';
