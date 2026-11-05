import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  appendPromptNotes,
  classifyAttachment,
  downloadAttachment,
  formatAttachmentCountNote,
  formatAttachmentFailureNote,
  formatAttachmentSkipNote,
  formatSavedFileNote,
  normalizeImageMime,
  normalizeMimeType,
  safeConversationDirName,
  sanitizeFileName,
  saveAttachmentFile,
} from '../../lib/discord/attachments.js';

const limits = { enabled: true, maxBytes: 1000, maxCount: 3 };
const url = 'https://cdn.example/attachment';

function fakeResponse(body, headers = {}, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
    body: null,
    async arrayBuffer() {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    },
  };
}

function streamingResponse(chunks, headers = {}) {
  let index = 0;
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            const value = chunks[index];
            index += 1;
            return { done: false, value };
          },
          async cancel() {
            return undefined;
          },
        };
      },
    },
    async arrayBuffer() {
      return new ArrayBuffer(0);
    },
  };
}

test('normalizeMimeType lowercases and strips parameters', () => {
  assert.equal(normalizeMimeType('IMAGE/PNG; charset=binary'), 'image/png');
  assert.equal(normalizeMimeType('text/plain'), 'text/plain');
  assert.equal(normalizeMimeType(null), undefined);
  assert.equal(normalizeMimeType(''), undefined);
  assert.equal(normalizeMimeType('   '), undefined);
});

test('normalizeImageMime only accepts the image allowlist', () => {
  assert.equal(normalizeImageMime('image/png'), 'image/png');
  assert.equal(normalizeImageMime('IMAGE/JPEG'), 'image/jpeg');
  assert.equal(normalizeImageMime('image/jpg'), 'image/jpeg');
  assert.equal(normalizeImageMime('image/webp'), 'image/webp');
  assert.equal(normalizeImageMime('image/gif'), 'image/gif');
  assert.equal(normalizeImageMime('image/svg+xml'), undefined);
  assert.equal(normalizeImageMime('text/plain'), undefined);
  assert.equal(normalizeImageMime(null), undefined);
});

test('classifyAttachment decides image / file / skip', () => {
  assert.deepEqual(classifyAttachment({ name: 'a.png', contentType: 'image/png', size: 10, url }, limits, 0), {
    action: 'image',
    mimeType: 'image/png',
  });
  assert.deepEqual(
    classifyAttachment({ name: 'a.bin', contentType: 'application/octet-stream', size: 10, url }, limits, 1),
    { action: 'file', mimeType: 'application/octet-stream' },
  );
  assert.deepEqual(classifyAttachment({ name: 'a.bin', contentType: null, size: null, url }, limits, 1), {
    action: 'file',
  });
  assert.deepEqual(classifyAttachment({ name: 'big.bin', size: 5000, url }, limits, 0), {
    action: 'skip',
    reason: 'too-large',
  });
  assert.deepEqual(classifyAttachment({ name: 'a.png', contentType: 'image/png', url }, limits, 5), {
    action: 'skip',
    reason: 'count',
  });
  assert.deepEqual(
    classifyAttachment({ name: 'a.png', contentType: 'image/png', url }, { ...limits, enabled: false }, 0),
    { action: 'skip', reason: 'disabled' },
  );
  assert.deepEqual(classifyAttachment({ name: 'a.bin' }, limits, 0), { action: 'skip', reason: 'unavailable' });
  assert.deepEqual(classifyAttachment({ name: 'a.svg', contentType: 'image/svg+xml', size: 5, url }, limits, 0), {
    action: 'file',
    mimeType: 'image/svg+xml',
  });
});

test('classifyAttachment validates the index', () => {
  assert.throws(() => classifyAttachment({ name: 'a', url }, limits, -1), RangeError);
  assert.throws(() => classifyAttachment({ name: 'a', url }, limits, 1.5), RangeError);
});

test('sanitizeFileName removes separators and unsafe characters', () => {
  assert.equal(sanitizeFileName('report.pdf'), 'report.pdf');
  assert.equal(sanitizeFileName('../evil.sh'), '_evil.sh');
  assert.equal(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j.txt'), 'a_b_c_d_e_f_g_h_i_j.txt');
  assert.equal(sanitizeFileName('   '), 'attachment');
  assert.equal(sanitizeFileName(''), 'attachment');
  assert.ok(sanitizeFileName('x'.repeat(300)).length <= 100);
});

test('safeConversationDirName produces a single safe path segment', () => {
  assert.equal(safeConversationDirName('guild:111:222'), 'guild_111_222');
  assert.equal(safeConversationDirName('thread:111:222:user:333'), 'thread_111_222_user_333');
  assert.equal(safeConversationDirName('dm:444'), 'dm_444');
  const traversal = safeConversationDirName('../../etc/passwd');
  assert.ok(!traversal.includes('/'));
  assert.ok(!traversal.includes('\\'));
  assert.notEqual(traversal, '..');
  assert.ok(traversal.length > 0);
  assert.equal(safeConversationDirName(''), 'conversation');
});

test('prompt notes are appended without losing the original text', () => {
  assert.equal(appendPromptNotes('hello', []), 'hello');
  assert.equal(appendPromptNotes('  hello  ', []), 'hello');
  assert.equal(appendPromptNotes('', ['[note]']), '[note]');
  assert.equal(appendPromptNotes('hello', ['[a]', '', '  ']), 'hello\n[a]');
  assert.equal(formatSavedFileNote('C:\\tmp\\x.txt'), '[附件已保存: C:\\tmp\\x.txt]');
  assert.equal(formatAttachmentSkipNote('a.bin', 'too-large'), '[附件已跳过: a.bin（超过大小限制）]');
  assert.equal(formatAttachmentSkipNote('a.bin', 'unavailable'), '[附件已跳过: a.bin（无法获取下载地址）]');
  assert.equal(formatAttachmentFailureNote('a.bin'), '[附件下载失败: a.bin]');
  assert.equal(formatAttachmentCountNote(2), '[已跳过 2 个附件: 超过单条消息附件数量上限]');
});

test('downloadAttachment returns bytes from an injected fetch', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const data = await downloadAttachment(url, {
    maxBytes: 100,
    fetchImpl: async () => fakeResponse(bytes),
  });
  assert.deepEqual([...data], [1, 2, 3, 4]);
});

test('downloadAttachment streams and merges chunks', async () => {
  const data = await downloadAttachment(url, {
    maxBytes: 100,
    fetchImpl: async () => streamingResponse([new Uint8Array([1, 2]), new Uint8Array([3])]),
  });
  assert.deepEqual([...data], [1, 2, 3]);
});

test('downloadAttachment enforces declared content-length', async () => {
  await assert.rejects(
    () =>
      downloadAttachment(url, {
        maxBytes: 100,
        fetchImpl: async () => fakeResponse(new Uint8Array(1), { 'content-length': '5000' }),
      }),
    /大小限制/,
  );
});

test('downloadAttachment enforces the cap while streaming', async () => {
  await assert.rejects(
    () =>
      downloadAttachment(url, {
        maxBytes: 100,
        fetchImpl: async () => streamingResponse([new Uint8Array(80), new Uint8Array(80)]),
      }),
    /大小限制/,
  );
});

test('downloadAttachment rejects non-2xx responses and network failures', async () => {
  await assert.rejects(
    () => downloadAttachment(url, { maxBytes: 100, fetchImpl: async () => fakeResponse(new Uint8Array(0), {}, 404) }),
    /HTTP 404/,
  );
  await assert.rejects(
    () =>
      downloadAttachment(url, {
        maxBytes: 100,
        fetchImpl: async () => {
          throw new Error('offline');
        },
      }),
    /网络错误/,
  );
});

test('saveAttachmentFile writes under the conversation attachment directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-discord-att-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const data = new Uint8Array([104, 105]);
  const target = await saveAttachmentFile(root, 'guild:1:2', 'note.txt', data, {
    timestamp: 1700000000000,
    index: 0,
  });
  assert.ok(target.includes(join('attachments', 'guild_1_2')));
  assert.ok(target.includes('1700000000000-0-note.txt'));
  const stats = await stat(target);
  assert.equal(stats.size, 2);
  const content = await readFile(target, 'utf8');
  assert.equal(content, 'hi');
  assert.ok(target.startsWith(root + sep) || target.startsWith(root));
});
