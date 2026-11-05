/**
 * Small shared helpers for the bridge unit tests.
 */

/** Logger that records every call so tests can assert warnings. */
export function createRecordingLogger() {
  const records = [];
  const push = (level) => (message, meta) => records.push({ level, message, meta });
  const logger = {
    records,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: (message, error, meta) => records.push({ level: 'error', message, error, meta }),
  };
  return logger;
}

/** In-memory SessionStore double. */
export function createMemoryStore(initial = {}, options = {}) {
  const records = new Map(Object.entries(initial).map(([key, sessionId]) => [key, { sessionId }]));
  let flushCalls = 0;
  return {
    records,
    get flushCalls() {
      return flushCalls;
    },
    get(key) {
      const record = records.get(key);
      return record ? { ...record } : undefined;
    },
    set(key, sessionId, meta) {
      records.set(key, { sessionId, ...(meta ? { meta: { ...meta } } : {}) });
    },
    delete(key) {
      records.delete(key);
    },
    entries() {
      return [...records.entries()].map(([key, record]) => ({ key, ...record }));
    },
    async flush() {
      flushCalls += 1;
    },
    ...(options.extra || {}),
  };
}

/** A promise with externally callable resolve/reject. */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Wait a few macrotasks so fire-and-forget async disposal settles. */
export async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Build a test user-message factory (mirrors @deepseek-ai/dsh-llm createUserMessage). */
export function testMessageFactory() {
  let counter = 0;
  const factory = ({ content, source }) => ({
    id: 'msg-test-' + ++counter,
    role: 'user',
    content,
    source,
  });
  factory.count = () => counter;
  return factory;
}
