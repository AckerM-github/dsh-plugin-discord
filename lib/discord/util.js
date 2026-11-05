/**
 * Shared helpers: error formatting, a defensive logger wrapper and the
 * unknown-message check used by status-message edits.
 */

/** Best-effort human readable message for an unknown thrown value. */
export function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error === null || error === undefined) return String(error);
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Discord answers 10008 (Unknown Message) when editing a message that was
 * deleted (for example the live status message). The adapter must tolerate
 * that instead of crashing a turn.
 */
export function isUnknownMessageError(error) {
  if (!error || typeof error !== 'object') return false;
  const code = error.code;
  if (code === 10008 || code === '10008') return true;
  return error instanceof Error && /unknown message/i.test(error.message);
}

/**
 * Wrap a host logger (cordis logger, console, or a test fake) into the small,
 * stable surface used by the discord modules. Logging must never break the bot,
 * so every call is guarded and unknown logger shapes degrade to console.
 */
export function createSafeLogger(raw, bindings = {}) {
  const target = raw && (typeof raw === 'object' || typeof raw === 'function') ? raw : console;
  const emit = (level, message, second, third) => {
    const meta = { ...bindings };
    if (level === 'error' && second !== undefined) {
      meta.error = errorMessage(second);
    } else if (second && typeof second === 'object' && !(second instanceof Error)) {
      Object.assign(meta, second);
    } else if (second !== undefined) {
      meta.detail = String(second);
    }
    if (third && typeof third === 'object' && !(third instanceof Error)) {
      Object.assign(meta, third);
    } else if (third !== undefined) {
      meta.detail = String(third);
    }
    try {
      const fn = typeof target[level] === 'function' ? target[level] : typeof target.log === 'function' ? target.log : null;
      if (!fn) return;
      if (Object.keys(meta).length === 0) fn.call(target, message);
      else fn.call(target, message, meta);
    } catch {
      // never let logging failures escape
    }
  };
  return {
    debug(message, meta) {
      emit('debug', message, meta);
    },
    info(message, meta) {
      emit('info', message, meta);
    },
    warn(message, meta) {
      emit('warn', message, meta);
    },
    error(message, error, meta) {
      emit('error', message, error, meta);
    },
    child(extra) {
      return createSafeLogger(target, { ...bindings, ...(extra || {}) });
    },
  };
}
