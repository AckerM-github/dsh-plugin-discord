/**
 * /dsh slash command definition and registration.
 *
 * Slash commands stay thin: /dsh status becomes the text command "!status" and
 * the plugin entry's command parser handles both forms identically. The command
 * payload uses the raw Discord API shape so this module needs no discord.js
 * import (ApplicationCommandOptionType.Subcommand === 1).
 */

export const DSH_COMMAND_NAME = 'dsh';
export const DSH_COMMAND_DESCRIPTION = 'DSH 会话管理';
export const DSH_SUBCOMMANDS = ['new', 'status', 'help'];

const SUBCOMMAND_TYPE = 1;

export function isDshSubcommand(value) {
  return typeof value === 'string' && DSH_SUBCOMMANDS.includes(value);
}

/** Raw payload for the single /dsh command with new/status/help subcommands. */
export function buildDshCommandData() {
  return {
    name: DSH_COMMAND_NAME,
    description: DSH_COMMAND_DESCRIPTION,
    options: [
      { type: SUBCOMMAND_TYPE, name: 'new', description: '开启新的 DSH 会话（丢弃当前上下文）' },
      { type: SUBCOMMAND_TYPE, name: 'status', description: '查看运行时与会话状态' },
      { type: SUBCOMMAND_TYPE, name: 'help', description: '查看命令帮助' },
    ],
  };
}

/**
 * Convert a /dsh subcommand interaction into the equivalent text command.
 * Returns null for foreign commands or unknown subcommands.
 */
export function interactionCommandText(commandPrefix, commandName, subcommand) {
  if (commandName !== DSH_COMMAND_NAME) return null;
  if (!isDshSubcommand(subcommand)) return null;
  return commandPrefix + subcommand;
}

/**
 * Registrar is the discord.js ApplicationCommandManager (or any { set } fake).
 * Registration is best effort: failures only log a warning.
 */
export async function registerDshCommands(registrar, logger, applicationId) {
  if (!registrar || typeof registrar.set !== 'function') {
    logger.warn('Discord application.commands 不可用，跳过 /dsh 斜杠命令注册', {
      applicationId: applicationId || null,
    });
    return false;
  }
  try {
    await registrar.set([buildDshCommandData()]);
    logger.info('Discord /dsh 斜杠命令已注册', {
      applicationId: applicationId || null,
      subcommands: [...DSH_SUBCOMMANDS],
    });
    return true;
  } catch (error) {
    logger.warn('Discord /dsh 斜杠命令注册失败（已忽略，斜杠命令可能暂时不可用）', {
      applicationId: applicationId || null,
      error: error && error.message ? error.message : String(error),
    });
    return false;
  }
}
