/**
 * Persisted Discord conversation -> DSH session id mapping.
 *
 * One JSON file per plugin state dir plus an atomic, debounced writer:
 *
 *   <stateDir>/sessions.json
 *   { "version": 1, "sessions": { "<conversationId>": { "sessionId": "...", "updatedAt": "...", "meta": {...} } } }
 *
 * Writes are debounced (`flushDelayMs`, default 250 ms) and atomic: the new
 * document is written to `sessions.json.tmp` and renamed over the target, so a
 * crash mid-write cannot truncate the mapping file. `flush()` forces a write
 * and settles after it completes; the plugin calls it from its teardown path.
 *
 * A corrupt or foreign file is tolerated: it is reported through the logger and
 * the store starts empty (the next successful write replaces it with valid
 * JSON). Only read at construction time, so `get()` stays synchronous.
 *
 * @module dsh-plugin-discord/session-store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const FILE_VERSION = 1;
const DEFAULT_FLUSH_DELAY_MS = 250;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function noopLogger() {}

function normalizeLogger(logger) {
  const safe = logger || {};
  return {
    debug: typeof safe.debug === 'function' ? safe.debug.bind(safe) : noopLogger,
    info: typeof safe.info === 'function' ? safe.info.bind(safe) : noopLogger,
    warn: typeof safe.warn === 'function' ? safe.warn.bind(safe) : noopLogger,
    error: typeof safe.error === 'function' ? safe.error.bind(safe) : noopLogger,
  };
}

function copyRecord(record) {
  const copy = { sessionId: record.sessionId, updatedAt: record.updatedAt };
  if (record.meta) copy.meta = { ...record.meta };
  return copy;
}

/**
 * Open (or create) the persisted session mapping.
 *
 * @param {object} options
 * @param {string} options.filePath absolute path of the JSON mapping file.
 * @param {object} [options.logger] logger with debug/info/warn/error.
 * @param {number} [options.flushDelayMs] debounce window for disk writes.
 * @param {() => number} [options.now] clock seam for tests.
 * @returns {{
 *   get(key: string): { sessionId: string, updatedAt: string, meta?: object } | undefined,
 *   set(key: string, sessionId: string, meta?: object): void,
 *   delete(key: string): void,
 *   flush(): Promise<void>,
 *   size: number,
 *   filePath: string
 * }}
 */
export function createSessionStore(options = {}) {
  const filePath = options.filePath;
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new TypeError('createSessionStore: options.filePath must be a non-empty string');
  }
  const logger = normalizeLogger(options.logger);
  const clock = typeof options.now === 'function' ? options.now : () => Date.now();
  const flushDelayMs = Number.isInteger(options.flushDelayMs) && options.flushDelayMs >= 0
    ? options.flushDelayMs
    : DEFAULT_FLUSH_DELAY_MS;

  /** @type {Map<string, { sessionId: string, updatedAt: string, meta?: object }>} */
  const records = new Map();
  let dirty = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let writing = Promise.resolve();

  const timestamp = (ms) => new Date(ms).toISOString();

  const load = () => {
    let text;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        logger.warn('session store unreadable; starting empty: ' + describe(error));
      }
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      logger.warn('session store is not valid JSON; starting empty: ' + describe(error));
      return;
    }
    if (!isRecord(parsed) || parsed.version !== FILE_VERSION || !isRecord(parsed.sessions)) {
      logger.warn('session store has an unknown shape; starting empty');
      return;
    }
    let loaded = 0;
    for (const [key, value] of Object.entries(parsed.sessions)) {
      if (!isRecord(value) || typeof value.sessionId !== 'string' || value.sessionId.length === 0) {
        logger.warn('session store skipped invalid record for key ' + key);
        continue;
      }
      const record = {
        sessionId: value.sessionId,
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : timestamp(clock()),
      };
      if (isRecord(value.meta)) record.meta = { ...value.meta };
      records.set(key, record);
      loaded += 1;
    }
    logger.debug('session store loaded ' + loaded + ' record(s) from ' + filePath);
  };

  const snapshot = () => {
    const sessions = {};
    for (const [key, record] of records) sessions[key] = copyRecord(record);
    return { version: FILE_VERSION, sessions };
  };

  const writeNow = async () => {
    if (!dirty) return;
    dirty = false;
    const payload = JSON.stringify(snapshot(), null, 2) + '\n';
    const tmpPath = filePath + '.tmp';
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(tmpPath, payload, 'utf8');
    await rename(tmpPath, filePath);
    logger.debug('session store wrote ' + records.size + ' record(s) to ' + filePath);
  };

  const queueWrite = () => {
    writing = writing.then(writeNow).catch((error) => {
      // Keep the change dirty so a later flush can retry; never reject the chain.
      dirty = true;
      logger.warn('session store write failed: ' + describe(error));
    });
    return writing;
  };

  const schedule = () => {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void queueWrite();
    }, flushDelayMs);
    if (typeof timer.unref === 'function') timer.unref();
  };

  load();

  return {
    get(key) {
      if (typeof key !== 'string' || key.length === 0) return undefined;
      const record = records.get(key);
      return record ? copyRecord(record) : undefined;
    },
    set(key, sessionId, meta) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new TypeError('sessionStore.set: key must be a non-empty string');
      }
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new TypeError('sessionStore.set: sessionId must be a non-empty string');
      }
      const previous = records.get(key);
      const record = { sessionId, updatedAt: timestamp(clock()) };
      const merged = { ...(isRecord(previous?.meta) ? previous.meta : {}), ...(isRecord(meta) ? meta : {}) };
      if (Object.keys(merged).length > 0) record.meta = merged;
      records.set(key, record);
      schedule();
    },
    delete(key) {
      if (typeof key !== 'string' || key.length === 0) return;
      if (records.delete(key)) schedule();
    },
    /** Every mapping, for one-time workspace reconciliation. */
    entries() {
      return [...records.entries()].map(([key, record]) => ({ key, ...copyRecord(record) }));
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (dirty) queueWrite();
      await writing;
    },
    get size() {
      return records.size;
    },
    filePath,
  };
}

function describe(error) {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}
