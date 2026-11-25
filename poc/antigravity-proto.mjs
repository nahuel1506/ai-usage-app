// Zero-dependency Protobuf wire decoder for Antigravity local SQLite conversation blobs.
// Pure, read-only parser independent of UI and attribution rules.

function readVarint(buf, pos) {
  let value = 0n;
  let shift = 0n;
  while (pos < buf.length) {
    const byte = buf[pos++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, pos];
    shift += 7n;
    if (shift > 70n) return null;
  }
  return null;
}

export function decodeFields(buf) {
  if (!buf || !buf.length) return [];
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const fields = [];
  let pos = 0;
  while (pos < bytes.length) {
    const tagRes = readVarint(bytes, pos);
    if (!tagRes) return null;
    const [tag, afterTag] = tagRes;
    pos = afterTag;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (field <= 0 || field > 100_000) return null;

    if (wire === 0) {
      const valRes = readVarint(bytes, pos);
      if (!valRes) return null;
      const [raw, next] = valRes;
      pos = next;
      fields.push({ field, wire, value: raw <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(raw) : Number(raw & 0x1fffffffffffffn) });
    } else if (wire === 1) {
      if (pos + 8 > bytes.length) return null;
      fields.push({ field, wire, value: bytes.readDoubleLE(pos) });
      pos += 8;
    } else if (wire === 2) {
      const lenRes = readVarint(bytes, pos);
      if (!lenRes) return null;
      const [lenBig, afterLen] = lenRes;
      const len = Number(lenBig);
      pos = afterLen;
      if (len < 0 || pos + len > bytes.length) return null;
      fields.push({ field, wire, buf: bytes.subarray(pos, pos + len) });
      pos += len;
    } else if (wire === 5) {
      if (pos + 4 > bytes.length) return null;
      fields.push({ field, wire, value: bytes.readFloatLE(pos) });
      pos += 4;
    } else {
      return null;
    }
  }
  return fields;
}

export function decodeTimestampMs(buf) {
  const fields = decodeFields(buf);
  if (!fields) return null;
  const seconds = fields.find(item => item.field === 1 && item.wire === 0)?.value;
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 4_102_444_800) return null;
  const nanos = fields.find(item => item.field === 2 && item.wire === 0)?.value ?? 0;
  return seconds * 1000 + Math.floor(nanos / 1_000_000);
}

export function decodeUtf8(buf, maxBytes = 512) {
  if (!buf || !buf.length) return null;
  const slice = buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
  return slice.toString('utf8');
}

// Locally verified Antigravity model_enum -> display label table (correlated via transcript settings).
const KNOWN_MODELS = new Map([
  [1401, 'Claude Opus 5.5 (Medium)'],
  [1417, 'Gemini 4 Argon (High)'],
  [1418, 'Gemini 4 Argon (Medium)'],
  [1526, 'Gemini 4 Hydrogen (Medium)'],
  [1532, 'Gemini 4 Neon (High)'],
  [1533, 'Gemini 4 Neon (Medium)'],
  [1534, 'Gemini 4 Neon (Low)'],
  [1535, 'Gemini 4 Neon (XHigh)'],
]);

export function splitModelAndEffort(displayLabel) {
  if (typeof displayLabel !== 'string' || !displayLabel.trim()) return { model: null, effort: null };
  const trimmed = displayLabel.trim();
  const match = /^(.+?)\s*\((None|Minimal|Low|Medium|High|XHigh|Max|Ultra)\)$/i.exec(trimmed);
  if (!match) return { model: trimmed, effort: null };
  return { model: match[1].trim(), effort: match[2].toLowerCase() };
}

export function modelLabelFromEnum(enumNumber, dynamicMap = null) {
  if (!Number.isSafeInteger(enumNumber) || enumNumber <= 0) return null;
  const known = dynamicMap?.get(enumNumber) ?? KNOWN_MODELS.get(enumNumber);
  if (known) return known;
  if (enumNumber >= 1000 && enumNumber < 2000) return `MODEL_M${enumNumber - 1000}`;
  return `MODEL_${enumNumber}`;
}

export function isKnownModelEnum(enumNumber) {
  return KNOWN_MODELS.has(enumNumber);
}

export function workspaceDisplayName(uri, repoName) {
  if (typeof repoName === 'string' && repoName.trim()) {
    const clean = repoName.trim().split('/').pop();
    if (clean) return clean.slice(0, 120);
  }
  if (typeof uri !== 'string' || !uri.trim()) return null;
  let cleaned = uri.trim();
  try { cleaned = decodeURIComponent(cleaned); } catch { /* keep raw */ }
  cleaned = cleaned.replace(/^file:\/\/\/+/i, '').replace(/\/+$/, '');
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1].slice(0, 120) : null;
}

export function parseTrajectoryMeta(blob) {
  const top = decodeFields(blob);
  if (!top) return {};
  let workspaceUri = null;
  let repoName = null;
  let branch = null;

  const f1 = top.find(item => item.field === 1 && item.wire === 2);
  if (f1) {
    const ws = decodeFields(f1.buf);
    if (ws) {
      const uriBuf = ws.find(item => item.field === 1 && item.wire === 2)?.buf
        ?? ws.find(item => item.field === 2 && item.wire === 2)?.buf;
      if (uriBuf) workspaceUri = decodeUtf8(uriBuf, 512);
      const gitBuf = ws.find(item => item.field === 3 && item.wire === 2)?.buf;
      if (gitBuf) {
        const git = decodeFields(gitBuf);
        const nameBuf = git?.find(item => item.field === 1 && item.wire === 2)?.buf;
        if (nameBuf) repoName = decodeUtf8(nameBuf, 200);
      }
      const branchBuf = ws.find(item => item.field === 4 && item.wire === 2)?.buf;
      if (branchBuf) branch = decodeUtf8(branchBuf, 120);
    }
  }
  if (!workspaceUri) {
    const f7 = top.find(item => item.field === 7 && item.wire === 2);
    if (f7) workspaceUri = decodeUtf8(f7.buf, 512);
  }

  const startedAt = top.find(item => item.field === 2 && item.wire === 2)?.buf;
  const parentBuf = top.find(item => item.field === 5 && item.wire === 2)?.buf;
  const cascadeBuf = top.find(item => item.field === 6 && item.wire === 2)?.buf;
  const nestingDepth = top.find(item => item.field === 17 && item.wire === 0)?.value ?? 0;

  return {
    workspaceUri: workspaceUri?.trim() || null,
    workspaceName: workspaceDisplayName(workspaceUri, repoName),
    repoName: repoName?.trim() || null,
    branch: branch?.trim() || null,
    startedAtMs: startedAt ? decodeTimestampMs(startedAt) : null,
    parentConversationId: parentBuf ? decodeUtf8(parentBuf, 128)?.trim() || null : null,
    cascadeId: cascadeBuf ? decodeUtf8(cascadeBuf, 128)?.trim() || null : null,
    nestingDepth: Number.isSafeInteger(nestingDepth) && nestingDepth > 0 ? nestingDepth : 0,
  };
}

export function parseStepMetadata(blob) {
  const fields = decodeFields(blob);
  if (!fields) return null;

  const createdAtBuf = fields.find(item => item.field === 1 && item.wire === 2)?.buf;
  const completedAtBuf = fields.find(item => item.field === 8 && item.wire === 2)?.buf
    ?? fields.find(item => item.field === 32 && item.wire === 2)?.buf;
  const createdAtMs = createdAtBuf ? decodeTimestampMs(createdAtBuf) : null;
  const completedAtMs = completedAtBuf ? decodeTimestampMs(completedAtBuf) : null;
  const modelEnum = fields.find(item => item.field === 11 && item.wire === 0)?.value ?? null;
  const turnIdBuf = fields.find(item => item.field === 12 && item.wire === 2)?.buf;
  const turnId = turnIdBuf ? decodeUtf8(turnIdBuf, 128)?.trim() || null : null;

  let usage = null;
  const usageBuf = fields.find(item => item.field === 9 && item.wire === 2)?.buf;
  if (usageBuf) {
    const uf = decodeFields(usageBuf);
    if (uf) {
      const usageModelEnum = uf.find(item => item.field === 1 && item.wire === 0)?.value ?? modelEnum;
      const input = uf.find(item => item.field === 2 && item.wire === 0)?.value;
      const output = uf.find(item => item.field === 3 && item.wire === 0)?.value;
      const cacheRead = uf.find(item => item.field === 5 && item.wire === 0)?.value;
      const messageIdBuf = uf.find(item => item.field === 7 && item.wire === 2)?.buf;
      const reasoning = uf.find(item => item.field === 9 && item.wire === 0)?.value;
      const visibleOutput = uf.find(item => item.field === 10 && item.wire === 0)?.value;

      const counts = {};
      if (Number.isSafeInteger(input) && input >= 0) counts.input_tokens = input;
      if (Number.isSafeInteger(cacheRead) && cacheRead >= 0) counts.cached_input_tokens = cacheRead;
      if (Number.isSafeInteger(output) && output >= 0) counts.output_tokens = output;
      if (Number.isSafeInteger(reasoning) && reasoning >= 0) counts.reasoning_output_tokens = reasoning;
      if (Number.isSafeInteger(visibleOutput) && visibleOutput >= 0) counts.visible_output_tokens = visibleOutput;

      if (Object.keys(counts).length > 0) {
        usage = {
          modelEnum: usageModelEnum,
          model: modelLabelFromEnum(usageModelEnum),
          messageId: messageIdBuf ? decodeUtf8(messageIdBuf, 128)?.trim() || null : null,
          counts,
        };
      }
    }
  }

  return {
    createdAtMs,
    completedAtMs,
    modelEnum,
    model: modelLabelFromEnum(modelEnum),
    turnId,
    usage,
  };
}

export function parseUserPreview(stepPayloadBlob) {
  const top = decodeFields(stepPayloadBlob);
  if (!top) return undefined;
  const f19 = top.find(item => item.field === 19 && item.wire === 2);
  if (!f19) return undefined;
  const inner = decodeFields(f19.buf);
  if (!inner) return undefined;
  const textBuf = inner.find(item => item.field === 2 && item.wire === 2)?.buf;
  if (!textBuf) return undefined;
  const raw = decodeUtf8(textBuf, 360);
  if (!raw) return undefined;
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length > 96 ? normalized.slice(0, 96).trimEnd() + '…' : normalized;
}
