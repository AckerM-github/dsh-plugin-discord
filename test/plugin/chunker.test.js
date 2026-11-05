import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitMessage } from '../../lib/chunker.js';

const fenceLines = (chunk) => chunk.split('\n').filter((line) => line.trimStart().startsWith('\u0060\u0060\u0060')).length;

test('short text stays in one chunk', () => {
  assert.deepEqual(splitMessage('hello world', 1900), ['hello world']);
  assert.deepEqual(splitMessage('   ', 1900), []);
});

test('long unbroken text is hard-split within the limit', () => {
  const chunks = splitMessage('a'.repeat(4500), 1000);
  assert.ok(chunks.length >= 5);
  for (const chunk of chunks) assert.ok(chunk.length <= 1000);
  assert.equal(chunks.join('').length, 4500);
});

test('prefers line boundaries', () => {
  const paragraph = 'word '.repeat(120).trim();
  const text = [paragraph, paragraph, paragraph].join('\n\n');
  const chunks = splitMessage(text, 1000);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 1000);
    assert.ok(!chunk.startsWith('\n'));
    assert.ok(!chunk.endsWith('\n'));
  }
});

test('code fences stay balanced in every chunk', () => {
  const body = Array.from({ length: 200 }, (_, index) => 'const value' + index + ' = ' + index + ';').join('\n');
  const text = 'intro\n\n' + '\u0060\u0060\u0060ts\n' + body + '\n\u0060\u0060\u0060\n\noutro';
  const chunks = splitMessage(text, 500);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 500);
    assert.equal(fenceLines(chunk) % 2, 0, 'unbalanced fence: ' + chunk.slice(0, 60));
  }
  const joined = chunks.join('\n');
  assert.ok(joined.includes('const value199 = 199;'));
  assert.ok(joined.includes('intro'));
  assert.ok(joined.includes('outro'));
});

test('rejects invalid limits', () => {
  assert.throws(() => splitMessage('x', 0));
});
