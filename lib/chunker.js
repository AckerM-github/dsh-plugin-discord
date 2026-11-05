/**
 * Split agent output into Discord-sized chunks.
 *
 * Prefers line boundaries and keeps fenced code blocks readable by closing and
 * reopening the fence across chunks. Discord's hard limit is 2000 characters;
 * the caller passes a smaller budget (default 1900).
 */

const FENCE_RE = /^\s*```/;

function isFenceLine(line) {
  return FENCE_RE.test(line);
}

function splitTextLine(line, maxChars) {
  if (line.length <= maxChars) return [line];
  const pieces = [];
  for (let index = 0; index < line.length; index += maxChars) pieces.push(line.slice(index, index + maxChars));
  return pieces;
}

function splitCodeBlock(innerLines, header, close, maxChars) {
  const budget = maxChars - (header.length + close.length + 2);
  if (budget <= 0) return splitTextLine([header, ...innerLines, close].join('\n'), Math.max(1, maxChars));
  const bodies = [];
  let current = '';
  const flushBody = () => {
    if (current.length > 0) {
      bodies.push(current);
      current = '';
    }
  };
  for (const line of innerLines) {
    if (line.length > budget) {
      flushBody();
      for (const piece of splitTextLine(line, budget)) bodies.push(piece);
      continue;
    }
    const candidate = current === '' ? line : current + '\n' + line;
    if (candidate.length <= budget) current = candidate;
    else {
      flushBody();
      current = line;
    }
  }
  flushBody();
  if (bodies.length === 0) bodies.push('');
  return bodies.map((body) => header + '\n' + body + '\n' + close);
}

export function splitMessage(raw, maxChars = 1900) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) throw new Error('maxChars must be a positive number');
  const text = String(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (text.trim().length === 0) return [];
  if (text.length <= maxChars) return [text];

  const units = [];
  const lines = text.split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] || '';
    if (isFenceLine(line)) {
      const header = line.trim();
      const blockLines = [line];
      let closed = false;
      index += 1;
      while (index < lines.length) {
        const current = lines[index] || '';
        blockLines.push(current);
        index += 1;
        if (isFenceLine(current)) {
          closed = true;
          break;
        }
      }
      const close = closed ? (blockLines[blockLines.length - 1] || '```').trim() : '```';
      const inner = blockLines.slice(1, closed ? blockLines.length - 1 : blockLines.length);
      const block = blockLines.join('\n');
      if (block.length <= maxChars) units.push(block);
      else units.push(...splitCodeBlock(inner, header, close, maxChars));
      continue;
    }
    units.push(...splitTextLine(line, maxChars));
    index += 1;
  }

  const chunks = [];
  let current = '';
  const flushChunk = () => {
    if (current.length > 0) chunks.push(current);
    current = '';
  };
  for (const unit of units) {
    if (unit.length === 0) {
      if (current.length > 0) current += '\n';
      continue;
    }
    const candidate = current.length === 0 ? unit : current + '\n' + unit;
    if (candidate.length <= maxChars) current = candidate;
    else {
      flushChunk();
      current = unit;
    }
  }
  flushChunk();
  return chunks
    .map((chunk) => chunk.replace(/^\n+/, '').replace(/\s+$/, ''))
    .filter((chunk) => chunk.trim().length > 0);
}
