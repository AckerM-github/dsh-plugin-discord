/**
 * Loopback-only self-test endpoint, enabled only when config.debugHttpPort > 0.
 *
 * This is a development/verification aid: it runs the exact same agent bridge
 * path as a Discord message but without a Discord client, so the plugin can be
 * exercised end-to-end inside a real DSH host without a bot token.
 *
 *   GET  /health   -> { ok: true }
 *   POST /selftest { text } -> { ok, reply, sessionId, durationMs }
 */
import http from 'node:http';

const MAX_BODY_BYTES = 64 * 1024;

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error('invalid JSON body: ' + error.message));
      }
    });
    request.on('error', reject);
  });
}

/**
 * Start the loopback debug server.
 * @param {{ port: number, bridge: object, logger: object }} options
 * @returns {{ ready: Promise<{ port: number, url: string }>, close: () => Promise<void> }}
 */
export function startDebugServer(options) {
  const { port, bridge, logger } = options;
  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/selftest') {
        let body;
        try {
          body = await readBody(request);
        } catch (error) {
          sendJson(response, 400, { ok: false, error: error.message });
          return;
        }
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        const conversationId = typeof body.conversationId === 'string' && body.conversationId.trim()
          ? body.conversationId.trim()
          : 'debug:selftest';
        if (!text) {
          sendJson(response, 400, { ok: false, error: 'text is required' });
          return;
        }
        try {
          const result = await bridge.run(conversationId, {
            text,
            conversationLabel: 'debug-selftest',
            userName: 'debug',
          }, {
            onActivity(line) {
              logger.debug('selftest activity: ' + line);
            },
          });
          sendJson(response, 200, {
            ok: true,
            reply: result.finalText,
            sessionId: result.sessionId,
            durationMs: result.durationMs,
          });
        } catch (error) {
          logger.error('selftest failed', error);
          sendJson(response, 500, { ok: false, error: error && error.message ? error.message : String(error) });
        }
        return;
      }
      sendJson(response, 404, { ok: false, error: 'not found' });
    })().catch((error) => {
      logger.error('debug server request failed', error);
      try {
        sendJson(response, 500, { ok: false, error: 'internal error' });
      } catch {
        // response already settled
      }
    });
  });

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actualPort = address && typeof address === 'object' ? address.port : port;
      resolve({ port: actualPort, url: 'http://127.0.0.1:' + actualPort });
    });
  });

  return {
    ready,
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
