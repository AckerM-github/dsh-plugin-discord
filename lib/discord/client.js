/**
 * discord.js client factory and gateway event names.
 *
 * discord.js is imported lazily so unit tests (which inject a fake client) do
 * not need the dependency installed, and so a broken dependency only fails the
 * Discord channel start instead of the whole DSH host process.
 */

export const DISCORD_EVENTS = {
  MESSAGE_CREATE: 'messageCreate',
  INTERACTION_CREATE: 'interactionCreate',
  ERROR: 'error',
  SHARD_ERROR: 'shardError',
  SHARD_DISCONNECT: 'shardDisconnect',
  CLIENT_READY: 'clientReady',
  READY: 'ready',
};

export const REQUIRED_INTENTS = ['Guilds', 'GuildMessages', 'DirectMessages', 'MessageContent'];
export const REQUIRED_PARTIALS = ['Channel', 'Message', 'User'];

/** Build a real discord.js Client. Throws a helpful error when discord.js is missing. */
export async function createDefaultDiscordClient() {
  let discord;
  try {
    discord = await import('discord.js');
  } catch (error) {
    throw new Error(
      '无法加载 discord.js：请确认 dsh-plugin-discord 的依赖已安装（pnpm install）。原始错误: ' + (error && error.message ? error.message : String(error)),
    );
  }
  return new discord.Client({
    intents: [
      discord.GatewayIntentBits.Guilds,
      discord.GatewayIntentBits.GuildMessages,
      discord.GatewayIntentBits.DirectMessages,
      discord.GatewayIntentBits.MessageContent,
    ],
    partials: [discord.Partials.Channel, discord.Partials.Message, discord.Partials.User],
  });
}
