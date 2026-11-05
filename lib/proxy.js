/**
 * Discord proxy support.
 *
 * Node's built-in fetch and the host process ignore the Windows system proxy.
 * Discord is usually reachable from this machine only through a local HTTP
 * proxy (127.0.0.1:7890 for Clash/v2rayN), and discord.js uses two different
 * network stacks:
 *
 *   1. REST + CDN: the npm "undici" package (global dispatcher per isolated
 *      copy), plus our injected fetchImpl for attachment downloads.
 *   2. Gateway WebSocket: @discordjs/ws imports { WebSocket } from "ws" on
 *      Node, and Node's ws connects with https.globalAgent by default.
 *
 * We therefore:
 *   - set a ProxyAgent as the global dispatcher of every plugin-local undici
 *     copy (pnpm isolates one copy per dependency tree),
 *   - patch the CJS "ws" exports with a subclass that passes a
 *     HttpsProxyAgent, *before* discord.js is imported (the plugin entry
 *     imports ./discord/index.js lazily after this runs).
 *
 * Only the plugin's own dependency copies are touched; the DSH host's own
 * network policy is unchanged. restore() puts everything back on unload.
 */
import { existsSync } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetch as undiciFetch } from 'undici';

const require = createRequire(import.meta.url);

const DISCORD_HOSTS = [
  'discord.com',
  'discordapp.com',
  'discord.gg',
  'discord.media',
  'discordapp.net',
  'discord.co',
];

/** Extract a hostname from an undici dispatch origin value. */
export function hostnameOf(origin) {
  if (!origin) return '';
  if (typeof origin === 'string') {
    try {
      return new URL(origin).hostname;
    } catch {
      return '';
    }
  }
  if (typeof origin.hostname === 'string') return origin.hostname;
  try {
    return new URL(String(origin)).hostname;
  } catch {
    return '';
  }
}

/** True when the hostname belongs to Discord (gateway, API, CDN). */
export function isDiscordHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return DISCORD_HOSTS.some((suffix) => host === suffix || host.endsWith('.' + suffix));
}

/**
 * Find every undici package copy that this plugin's dependency tree may load.
 *
 * Works with all install shapes we care about:
 *   - local dev checkout (plugin/node_modules/undici, plugin/node_modules/.pnpm/undici@*)
 *   - pnpm hoisted profile install (profile/node_modules/undici)
 *   - pnpm virtual-store tarball install
 *     (.pnpm/<pkg>/node_modules/dsh-plugin-discord with sibling undici symlink)
 * The module-resolution lookup is the reliable one for installed copies; the
 * filesystem walks are kept as a fallback for isolated development trees.
 *
 * @param {string} pluginDir absolute plugin package directory
 * @returns {Promise<string[]>} absolute index.js paths, de-duplicated by realpath
 */
export async function discoverUndiciCopies(pluginDir) {
  const candidates = [];
  try {
    candidates.push(require.resolve('undici'));
  } catch {
    // undici is missing; fall through to filesystem discovery
  }

  const addPnpmCopies = async (baseDir) => {
    const pnpmDir = join(baseDir, 'node_modules', '.pnpm');
    try {
      for (const entry of await readdir(pnpmDir)) {
        if (!entry.startsWith('undici@')) continue;
        const indexFile = join(pnpmDir, entry, 'node_modules', 'undici', 'index.js');
        if (existsSync(indexFile)) candidates.push(indexFile);
      }
    } catch {
      // no virtual store at this level
    }
  };

  const addTopLevel = (baseDir) => {
    const indexFile = join(baseDir, 'node_modules', 'undici', 'index.js');
    if (existsSync(indexFile)) candidates.push(indexFile);
  };

  addTopLevel(pluginDir);
  await addPnpmCopies(pluginDir);

  // Walk up: hoisted profile installs resolve dependencies from an ancestor
  // node_modules, and virtual-store packages sit beside their dependency links.
  let dir = pluginDir;
  for (let depth = 0; depth < 6; depth += 1) {
    dir = dirname(dir);
    if (!dir || dir === dirname(dir)) break;
    addTopLevel(dir);
    await addPnpmCopies(dir);
  }

  const unique = [];
  for (const candidate of candidates) {
    try {
      unique.push(await realpath(candidate));
    } catch {
      unique.push(candidate);
    }
  }
  return [...new Set(unique)];
}

/**
 * Point every plugin-local undici copy at the proxy and patch ws for the
 * gateway. Must run before ./discord/index.js (discord.js) is imported.
 *
 * @param {{ proxyUrl: string, logger: object, pluginDir: string }} options
 * @returns {Promise<{ copies: number, fetchImpl: (url: string, init?: object) => Promise<Response>, restore: () => Promise<void> }>}
 */
export async function installDiscordProxy(options) {
  const { proxyUrl, logger, pluginDir } = options;
  const copies = await discoverUndiciCopies(pluginDir);
  const restores = [];

  for (const indexFile of copies) {
    try {
      const module = await import(pathToFileURL(indexFile).href);
      if (
        typeof module.setGlobalDispatcher !== 'function'
        || typeof module.getGlobalDispatcher !== 'function'
        || typeof module.ProxyAgent !== 'function'
      ) {
        continue;
      }
      const previous = module.getGlobalDispatcher();
      const agent = new module.ProxyAgent(proxyUrl);
      module.setGlobalDispatcher(agent);
      restores.push(() => {
        try {
          module.setGlobalDispatcher(previous);
        } catch {
          // best effort restore
        }
        try {
          Promise.resolve(agent.close()).catch(() => undefined);
        } catch {
          // best effort close
        }
      });
    } catch (error) {
      logger.warn('discord proxy: failed to instrument ' + indexFile + ': ' + (error && error.message ? error.message : error));
    }
  }
  if (restores.length === 0) {
    logger.warn('discord proxy: no undici copy instrumented; Discord REST may fail through ' + proxyUrl);
  }

  // Gateway: patch the CommonJS "ws" exports BEFORE discord.js imports it.
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const wsExports = require('ws');
    const BaseWebSocket = wsExports.WebSocket;
    if (typeof BaseWebSocket === 'function' && typeof HttpsProxyAgent === 'function') {
      const wsAgent = new HttpsProxyAgent(proxyUrl);
      class ProxiedWebSocket extends BaseWebSocket {
        constructor(address, protocols, options) {
          super(address, protocols, { ...(options || {}), agent: wsAgent });
        }
      }
      wsExports.WebSocket = ProxiedWebSocket;
      restores.push(() => {
        try {
          wsExports.WebSocket = BaseWebSocket;
        } catch {
          // best effort restore
        }
        try {
          wsAgent.destroy();
        } catch {
          // best effort destroy
        }
      });
    }
  } catch (error) {
    logger.warn('discord proxy: failed to patch ws gateway transport: ' + (error && error.message ? error.message : error));
  }

  return {
    copies: restores.length,
    fetchImpl(url, init) {
      return undiciFetch(url, init);
    },
    async restore() {
      for (const restore of restores.reverse()) {
        try {
          restore();
        } catch {
          // best effort
        }
      }
    },
  };
}
