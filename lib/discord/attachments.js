/**
 * Attachment classification, download and on-disk storage helpers.
 *
 * Images in the allowlist are downloaded and returned as bytes (the agent
 * bridge decides how to feed them to the model). Everything else is saved under
 * <stateDir>/attachments/<safe conversationId>/ and a note with the absolute
 * path is appended to the prompt text.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Only these image types are treated as model-visible images. */
export const IMAGE_MIME_ALLOWLIST = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** Lowercase, parameter-free mime type ("IMAGE/PNG; charset=x" -> "image/png"). */
export function normalizeMimeType(contentType) {
  if (!contentType) return undefined;
  const base = String(contentType).split(';')[0];
  if (!base) return undefined;
  const value = base.trim().toLowerCase();
  return value || undefined;
}

/** Canonical allowlisted image mime type, or undefined when not an allowed image. */
export function normalizeImageMime(contentType) {
  const value = normalizeMimeType(contentType);
  if (!value) return undefined;
  const canonical = value === 'image/jpg' ? 'image/jpeg' : value;
  return IMAGE_MIME_ALLOWLIST.includes(canonical) ? canonical : undefined;
}

/**
 * Decide what to do with one inbound attachment. Pure: no network, no disk.
 * Returns { action: 'image', mimeType } | { action: 'file', mimeType? } |
 * { action: 'skip', reason }.
 */
export function classifyAttachment(descriptor, limits, index) {
  if (!Number.isInteger(index) || index < 0) throw new RangeError('attachment index must be a non-negative integer');
  if (!limits.enabled) return { action: 'skip', reason: 'disabled' };
  if (index >= limits.maxCount) return { action: 'skip', reason: 'count' };
  const size = descriptor.size;
  if (typeof size === 'number' && Number.isFinite(size) && size > limits.maxBytes) {
    return { action: 'skip', reason: 'too-large' };
  }
  if (!descriptor.url) return { action: 'skip', reason: 'unavailable' };
  const imageMime = normalizeImageMime(descriptor.contentType);
  if (imageMime) return { action: 'image', mimeType: imageMime };
  const mimeType = normalizeMimeType(descriptor.contentType);
  return mimeType ? { action: 'file', mimeType } : { action: 'file' };
}

/** Make a user-supplied file name safe for the local filesystem. */
export function sanitizeFileName(name, fallback = 'attachment') {
  const raw = typeof name === 'string' ? name : '';
  const safe = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 100);
  return safe || fallback;
}

/** Make a conversation id safe as a single directory name. */
export function safeConversationDirName(conversationId) {
  const raw = typeof conversationId === 'string' ? conversationId : '';
  const safe = raw
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120)
    .replace(/^_+|_+$/g, '');
  return safe || 'conversation';
}

/** Prompt note appended for a file saved to disk. */
export function formatSavedFileNote(absolutePath) {
  return '[附件已保存: ' + absolutePath + ']';
}

/** Prompt note appended for a skipped attachment. */
export function formatAttachmentSkipNote(name, reason) {
  if (reason === 'too-large') return '[附件已跳过: ' + name + '（超过大小限制）]';
  if (reason === 'unavailable') return '[附件已跳过: ' + name + '（无法获取下载地址）]';
  return '[附件已跳过: ' + name + ']';
}

/** Prompt note appended when an attachment could not be downloaded/saved. */
export function formatAttachmentFailureNote(name) {
  return '[附件下载失败: ' + name + ']';
}

/** Prompt note appended when a message carries more attachments than maxCount. */
export function formatAttachmentCountNote(skipped) {
  return '[已跳过 ' + skipped + ' 个附件: 超过单条消息附件数量上限]';
}

/** Append attachment notes to a prompt while keeping it readable. */
export function appendPromptNotes(text, notes) {
  const trimmed = (text || '').trim();
  const relevant = notes.filter((note) => typeof note === 'string' && note.trim() !== '');
  if (relevant.length === 0) return trimmed;
  const block = relevant.join('\n');
  return trimmed ? trimmed + '\n' + block : block;
}

/** Thrown when an attachment cannot be downloaded or exceeds the size cap. */
export class AttachmentIngestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AttachmentIngestError';
  }
}

/**
 * Download an attachment with a hard byte cap and timeout. Uses global fetch so
 * tests can inject a fake implementation.
 */
export async function downloadAttachment(url, options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new AttachmentIngestError('当前 Node 运行时没有可用的 fetch，无法下载附件');
  }
  if (!url) throw new AttachmentIngestError('附件缺少下载地址');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
  try {
    let response;
    try {
      response = await fetchImpl(url, { signal: controller.signal });
    } catch (error) {
      throw new AttachmentIngestError('下载附件网络错误: ' + (error && error.message ? error.message : String(error)));
    }
    if (!response.ok) {
      throw new AttachmentIngestError('下载附件失败: HTTP ' + response.status);
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
      throw new AttachmentIngestError('附件超过大小限制');
    }
    if (!response.body) {
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > options.maxBytes) throw new AttachmentIngestError('附件超过大小限制');
      return buffer;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const value = result.value;
      if (!value) continue;
      total += value.byteLength;
      if (total > options.maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // ignore cancel failures
        }
        throw new AttachmentIngestError('附件超过大小限制');
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  } finally {
    clearTimeout(timer);
  }
}

/** Persist bytes under <stateDir>/attachments/<safeConversationId>/ and return the absolute path. */
export async function saveAttachmentFile(stateDir, conversationId, fileName, data, options = {}) {
  const directory = join(stateDir, 'attachments', safeConversationDirName(conversationId));
  await mkdir(directory, { recursive: true });
  const stamp = options.timestamp || Date.now();
  const suffix = options.index === undefined ? '' : '-' + options.index;
  const target = join(directory, String(stamp) + suffix + '-' + sanitizeFileName(fileName));
  await writeFile(target, data);
  return resolve(target);
}
