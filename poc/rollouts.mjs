import { createReadStream } from 'node:fs';

import { createHmac } from 'node:crypto';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib';
import { windowsFromLog } from './app-server.mjs';
import { projectPath, sessionProject } from './projects.mjs';

const MAX_FILES = 32;
const TAIL_BYTES = 2 * 1024 * 1024;
const HEADER_BYTES = 64 * 1024;
const MAX_COMPRESSED = 8 * 1024 * 1024;
const MAX_EXPANDED = 32 * 1024 * 1024;
const MAX_SESSION_LINE = 64 * 1024 * 1024;
const usageKeys = [
  'input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
  'output_tokens', 'reasoning_output_tokens', 'total_tokens',
];

function parseLine(line) {
  try { return JSON.parse(line.replace(/^\uFEFF/, '')); } catch { return null; }
}

function plainRange(buffer, start, completeEnd) {
  const text = buffer.toString('utf8');
  const lines = text.split('\n');
  if (start) lines.shift();
  if (!completeEnd || lines.at(-1) === '') lines.pop();
  return lines;
}

async function readPart(file, bytes, start) {
  const target = Buffer.alloc(bytes);
  let offset = 0;
  while (offset < bytes) {
    const { bytesRead } = await file.read(target, offset, bytes - offset, start + offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return target.subarray(0, offset);
}

async function readRollout(path, limit) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    if (path.endsWith('.zst')) {
      if (size > MAX_COMPRESSED) return null;
      const archive = await readPart(file, size, 0);
      const expanded = zstdDecompressSync(archive, { maxOutputLength: MAX_EXPANDED });
      return {
        head: plainRange(expanded.subarray(0, HEADER_BYTES), 0, expanded.length <= HEADER_BYTES),
        lines: plainRange(expanded, 0, true),
        truncated: false,
      };
    }
    const start = Math.max(0, size - limit);
    const tail = await readPart(file, size - start, start);
    const lines = plainRange(tail, start, false);
    const head = start ? plainRange(await readPart(file, Math.min(HEADER_BYTES, size), 0), 0, false) : lines;
    return { head, lines, truncated: Boolean(start) };
  } finally {
    await file.close();
  }
}

function sessionMetadata(head) {
  return head.map(parseLine).find(event => event?.type === 'session_meta')?.payload;
}

function sessionReference(salt, thread) {
  return typeof thread === 'string'
    ? createHmac('sha256', salt).update('session/' + thread).digest('hex').slice(0, 16) : null;
}

function createRolloutReader(head, accountId, salt, includePreviews) {
  const meta = sessionMetadata(head);
  const owner = meta?.creator_account_id;
  const scope = !owner || !accountId ? 'unverified' : owner === accountId ? 'same' : 'different';
  const thread = meta?.id ?? meta?.session_id;
  const turns = new Map();
  const requests = new Map();
  const snapshots = [];
  const reference = id => createHmac('sha256', salt).update(id).digest('hex').slice(0, 16);
  let malformed = 0;
  let omittedRequests = 0;

  function add(line) {
    if (!line.trim()) return;
    const event = parseLine(line);
    if (!event) {
      malformed++;
      return;
    }
    const payload = event.payload;
    const time = Date.parse(event.timestamp);
    if (!payload || !Number.isFinite(time)) return;

    if (event.type === 'event_msg' && payload.type === 'token_count' && payload.rate_limits) {
      for (const quota of windowsFromLog(payload.rate_limits)) {
        if (!quota.pool) continue;
        snapshots.push({ ...quota, time, source: 'rollout', plan: payload.rate_limits.plan_type ?? null });
      }
    }

    const isRequest = event.type === 'token_usage_record';
    const isStart = event.type === 'event_msg' && payload.type === 'task_started';
    const isEnd = event.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(payload.type);
    const isContext = event.type === 'turn_context';
    const chat = payload.internal_chat_message_metadata_passthrough;
    const userItems = event.type === 'response_item' && payload.type === 'message' && payload.role === 'user'
      && Array.isArray(chat?.content_item_kinds)
      ? chat.content_item_kinds.flatMap((kind, index) =>
        typeof kind === 'string' && kind.startsWith('user.')
        && chat.content_item_metadata?.[index]?.provenance?.type === 'user' ? [index] : [])
      : [];
    const isUser = userItems.length > 0;
    if (!isRequest && !isStart && !isEnd && !isContext && !isUser) return;

    const turnId = isUser ? chat.turn_id : payload.turn_id;
    const threadId = payload.thread_id ?? thread;
    if (typeof turnId !== 'string' || typeof threadId !== 'string') {
      if (isRequest) omittedRequests++;
      return;
    }
    const key = reference(threadId + '/' + turnId);
    const turn = turns.get(key) ?? { key, session: sessionReference(salt, threadId), scope, started: null, ended: null, first: Infinity, last: -Infinity };
    if (!isContext && !isUser) {
      turn.first = Math.min(turn.first, time);
      turn.last = Math.max(turn.last, time);
    }
    const attribution = payload.turn_attribution;
    const rawRoot = payload.root_turn_id ?? attribution?.root_turn_id;
    if (typeof rawRoot === 'string' && rawRoot.length > 0) {
      const root = reference('root/' + rawRoot);
      if (turn.family && turn.family !== root) turn.familyConflict = true;
      turn.family = root;
      if (rawRoot !== turnId) turn.child = true;
    }
    if (attribution?.parent_turn_id) turn.child = true;
    if (isStart) {
      turn.started = time;
      turn.composer = attribution?.turn_trigger === 'composer';
    }
    if (isUser) {
      const key = reference('message/' + (payload.id ?? turnId + '/' + time));
      turn.messages ??= new Map();
      let preview;
      if (includePreviews && scope === 'same') {
        const text = userItems.flatMap(index => {
          const item = payload.content?.[index];
          return item?.type === 'input_text' && typeof item.text === 'string' ? [item.text.slice(0, 180)] : [];
        }).join(' ').replace(/\s+/g, ' ').trim();
        preview = text.length > 96 ? text.slice(0, 96).trimEnd() + '…' : text || undefined;
      }
      turn.messages.set(key, { time, preview });
    }
    if (isEnd && (turn.ended === null || time >= turn.ended)) {
      turn.ended = time;
      turn.outcome = payload.type === 'turn_aborted' ? 'aborted' : payload.error ? 'error' : 'completed';
      if (Number.isSafeInteger(payload.duration_ms) && payload.duration_ms >= 0) turn.durationMs = payload.duration_ms;
    }
    if (isContext) {
      // Only retain machine identifiers, not free-text settings from the context record.
      const model = typeof payload.model === 'string' && /^[a-z0-9][a-z0-9._:-]{0,79}$/i.test(payload.model)
        ? payload.model : null;
      const effort = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'none'].includes(payload.effort)
        ? payload.effort : null;
      turn.models = addLabels(turn.models, [model]);
      turn.efforts = addLabels(turn.efforts, [effort]);
    }
    turns.set(key, turn);

    if (!isRequest) return;
    if (typeof payload.response_id !== 'string' || !payload.response_id || !payload.usage) {
      omittedRequests++;
      return;
    }
    const usage = Object.fromEntries(usageKeys.flatMap(field => {
      const value = payload.usage[field];
      return Number.isSafeInteger(value) && value >= 0 ? [[field, value]] : [];
    }));
    const requestId = reference(threadId + '/' + payload.response_id);
    const record = {
      turn: key,
      time,
      usage,
      scope,
      ...(turn.models?.length ? { model: turn.models.at(-1) } : {}),
      ...(turn.efforts?.length ? { effort: turn.efforts.at(-1) } : {}),
    };
    if (!requests.has(requestId) || time < requests.get(requestId).time) requests.set(requestId, record);
  }
  return {
    add,
    result: () => ({ session: sessionReference(salt, thread), sessionStartedAt: meta?.timestamp, scope, turns, requests, snapshots, malformed, omittedRequests }),
  };
}


export function summarizeRollout(head, lines, accountId, salt, includePreviews = false) {
  const reader = createRolloutReader(head, accountId, salt, includePreviews);
  for (const line of lines) reader.add(line);
  return reader.result();
}

async function appendSession(state, path, size) {
  const compressed = path.endsWith('.zst');
  if (size === state.cursor && !compressed) return;
  const source = createReadStream(path, compressed ? {} : { start: state.cursor, end: size - 1 });
  const decoder = compressed ? createZstdDecompress() : null;
  if (decoder) source.once('error', error => decoder.destroy(error));
  const stream = decoder ? source.pipe(decoder) : source;
  let parts = [];
  let length = 0;
  let cursor = state.cursor;
  try {
    for await (const chunk of stream) {
      let start = 0;
      for (let end = chunk.indexOf(10, start); end !== -1; end = chunk.indexOf(10, start)) {
        const piece = chunk.subarray(start, end);
        if (length + piece.length <= MAX_SESSION_LINE) {
          state.reader.add(parts.length ? Buffer.concat([...parts, piece]).toString('utf8') : piece.toString('utf8'));
        } else {
          state.skippedLines++;
        }
        cursor += length + piece.length + 1;
        state.cursor = cursor;
        parts = [];
        length = 0;
        start = end + 1;
      }
      if (start < chunk.length) {
        const rest = chunk.subarray(start);
        length += rest.length;
        if (length <= MAX_SESSION_LINE) parts.push(rest);
        else parts = [];
      }
    }
    if (compressed && length) {
      if (length <= MAX_SESSION_LINE) state.reader.add(Buffer.concat(parts).toString('utf8'));
      else state.skippedLines++;
    }

  } finally {
    source.destroy();
    if (compressed) stream.destroy();
  }
}

async function readSelectedRollout(entry, accountId, salt, includePreviews, cache) {
  const info = await stat(entry.path);
  const compressed = entry.path.endsWith('.zst');
  let state = cache.get(entry.path);
  if (!state || state.accountId !== accountId || state.ino !== info.ino || info.size < state.cursor && !compressed ||
      compressed && state.mtime !== info.mtimeMs) {
    state = {
      cursor: 0, skippedLines: 0, accountId, ino: info.ino,
      reader: createRolloutReader(entry.head, accountId, salt, includePreviews),
    };
    cache.set(entry.path, state);
  }
  if (state.mtime !== info.mtimeMs) {

    await appendSession(state, entry.path, info.size);
    state.mtime = info.mtimeMs;
  }
  return { ...state.reader.result(), skippedLines: state.skippedLines };
}

function addLabels(previous, next) {
  return [...new Set([...(previous ?? []), ...(next ?? [])].filter(Boolean))];
}

function mtimeIso(mtime) {
  return new Date(mtime).toISOString();
}

async function readSessionHeader(path) {
  if (!path.endsWith('.zst')) {
    const file = await open(path, 'r');
    try {
      const { size } = await file.stat();
      return plainRange(await readPart(file, Math.min(HEADER_BYTES, size), 0), 0, size < HEADER_BYTES);
    } finally {
      await file.close();
    }
  }
  const source = createReadStream(path);
  const decoder = createZstdDecompress();
  source.once('error', error => decoder.destroy(error));
  const parts = [];
  let bytes = 0;
  try {
    for await (const part of source.pipe(decoder)) {
      parts.push(part.subarray(0, HEADER_BYTES - bytes));
      bytes += parts.at(-1).length;
      if (bytes >= HEADER_BYTES) break;
    }
    return plainRange(Buffer.concat(parts), 0, bytes < HEADER_BYTES);
  } finally {
    source.destroy();
    decoder.destroy();
  }
}

export async function recentHistory(home, accountId, salt, includePreviews = false, workspace) {
  const files = [];
  let unavailableRoots = 0;
  let skipped = 0;
  for (const root of ['sessions', 'archived_sessions']) {
    const path = join(home, root);
    try {
      for (const entry of await readdir(path, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !/^rollout-.*\.jsonl(?:\.zst)?$/.test(entry.name)) continue;
        const absolute = join(entry.parentPath, entry.name);
        try {
          const info = await stat(absolute);
          files.push({ absolute, mtime: info.mtimeMs, size: info.size, ino: info.ino });
        }
        catch { skipped++; }
      }
    } catch { unavailableRoots++; }
  }

  files.sort((a, b) => b.mtime - a.mtime);
  const turns = new Map();
  const requests = new Map();
  const snapshots = [];
  const coverage = {
    discoveredFiles: files.length, scannedFiles: 0, truncatedFiles: 0, skippedFiles: skipped,
    unavailableRoots, sameAccountFiles: 0, unverifiedFiles: 0, otherAccountFiles: 0,
    malformedLines: 0, requestsWithoutIdentity: 0,
  };
  const collected = [];
  const sessionFiles = new Map();
  function register(absolute, mtime, head, partial) {
    const meta = sessionMetadata(head);
    const thread = meta?.id ?? meta?.session_id;
    const reference = sessionReference(salt, thread);
    if (reference && accountId && meta?.creator_account_id === accountId) {
      sessionFiles.set(absolute, { path: absolute, head, thread, cwd: meta.cwd, reference, mtime,
        startedAt: meta.timestamp, partial });
    }
  }
  const recentCache = workspace?.recentCache;
  const headerCache = workspace?.headerCache;
  if (recentCache || headerCache) {
    const known = new Set(files.map(file => file.absolute));
    if (recentCache) for (const path of recentCache.keys()) if (!known.has(path)) recentCache.delete(path);
    if (headerCache) for (const path of headerCache.keys()) if (!known.has(path)) headerCache.delete(path);
  }

  async function cachedHeader(file) {
    const cached = headerCache?.get(file.absolute);
    if (cached && cached.mtime === file.mtime && cached.size === file.size && cached.ino === file.ino) {
      return cached.head;
    }
    const head = await readSessionHeader(file.absolute);
    headerCache?.set(file.absolute, { mtime: file.mtime, size: file.size, ino: file.ino, head });
    return head;
  }

  for (const file of files.slice(0, MAX_FILES)) {
    const { absolute, mtime, size, ino } = file;
    try {
      const cached = recentCache?.get(absolute);
      if (cached && cached.mtime === mtime && cached.size === size && cached.ino === ino
          && cached.accountId === accountId && cached.includePreviews === includePreviews) {
        if (cached.skipped) {
          coverage.skippedFiles++;
          if (workspace && cached.head) register(absolute, mtime, cached.head, true);
          continue;
        }
        collected.push({ path: absolute, result: cached.result, truncated: cached.truncated });
        if (workspace && cached.result.scope === 'same') register(absolute, mtime, cached.head, cached.truncated);
        continue;
      }
      const part = await readRollout(absolute, TAIL_BYTES);
      if (!part) {
        coverage.skippedFiles++;
        const head = workspace && absolute.endsWith('.zst') ? await cachedHeader(file) : null;
        if (head) register(absolute, mtime, head, true);
        recentCache?.set(absolute, { mtime, size, ino, accountId, includePreviews, skipped: true, head });
        continue;
      }
      const result = summarizeRollout(part.head, part.lines, accountId, salt, includePreviews);
      recentCache?.set(absolute, { mtime, size, ino, accountId, includePreviews, skipped: false, head: part.head, result, truncated: part.truncated });
      collected.push({ path: absolute, result, truncated: part.truncated });
      if (workspace && result.scope === 'same') register(absolute, mtime, part.head, part.truncated);
    } catch { coverage.skippedFiles++; }
  }

  if (workspace?.projectIndex && accountId) {
    const beyondSample = files.slice(MAX_FILES).filter(file => workspace.projectIndex.files.has(projectPath(file.absolute)));
    // Index these session headers only. Opening a session streams its body on demand.
    for (const file of beyondSample) {
      try { register(file.absolute, file.mtime, await cachedHeader(file), true); }
      catch { /* The indexed file may have moved while Codex was writing. */ }
    }
  }

  const catalog = new Map();
  let selectedSession = null;
  if (workspace) {
    for (const file of sessionFiles.values()) {
      const entry = catalog.get(file.reference) ?? {
        reference: file.reference, startedAt: file.startedAt || mtimeIso(file.mtime), updatedAt: mtimeIso(file.mtime), partial: false,
        ...sessionProject(workspace.projectIndex, file.thread, file.cwd),
      };
      entry.partial ||= file.partial;
      catalog.set(file.reference, entry);
    }
    selectedSession = catalog.has(workspace.selected) ? workspace.selected : catalog.keys().next().value ?? null;
    const selectedPaths = [...sessionFiles.values()].filter(file => file.reference === selectedSession);
    const paths = new Set(selectedPaths.map(file => file.path));
    for (const path of workspace.cache.keys()) if (!paths.has(path)) workspace.cache.delete(path);
    if (selectedSession) {
      let partial = false;
      for (const entry of selectedPaths) {
        try {
          const full = await readSelectedRollout(entry, accountId, salt, includePreviews, workspace.cache);
          partial ||= Boolean(full.skippedLines || full.malformed);
          const index = collected.findIndex(item => item.path === entry.path);
          const item = { path: entry.path, result: full, truncated: Boolean(full.skippedLines) };
          if (index === -1) {
            collected.push(item);
            if (files.slice(0, MAX_FILES).some(file => file.absolute === entry.path)) coverage.skippedFiles--;
          } else collected[index] = item;
        } catch {
          partial = true;
        }
      }
      catalog.get(selectedSession).partial = partial;
    }
  }

  for (const { result, truncated } of collected) {
    coverage.scannedFiles++;
    if (truncated) coverage.truncatedFiles++;
    if (result.scope === 'same') coverage.sameAccountFiles++;
    if (result.scope === 'unverified') coverage.unverifiedFiles++;
    if (result.scope === 'different') {
      coverage.otherAccountFiles++;
      continue;
    }
    coverage.malformedLines += result.malformed;
    coverage.requestsWithoutIdentity += result.omittedRequests;
    for (const [key, turn] of result.turns) {
      const prior = turns.get(key);
      if (!prior) {
        turns.set(key, { ...turn, messages: turn.messages && new Map(turn.messages) });
        continue;
      }
      prior.first = Math.min(prior.first, turn.first);
      prior.last = Math.max(prior.last, turn.last);
      prior.started = Math.min(prior.started ?? Infinity, turn.started ?? Infinity);
      if (prior.started === Infinity) prior.started = null;
      if (turn.ended !== null && (prior.ended === null || turn.ended >= prior.ended)) {
        prior.ended = turn.ended;
        prior.outcome = turn.outcome;
        prior.durationMs = turn.durationMs ?? prior.durationMs;
      }
      if (prior.family && turn.family && prior.family !== turn.family) prior.familyConflict = true;
      prior.family ??= turn.family;
      prior.familyConflict ||= turn.familyConflict;
      prior.child ||= turn.child;
      prior.composer ||= turn.composer;
      if (turn.messages) {
        prior.messages ??= new Map();
        for (const [key, message] of turn.messages)
          if (!prior.messages.has(key) || message.preview) prior.messages.set(key, message);
      }
      prior.models = addLabels(prior.models, turn.models);
      prior.efforts = addLabels(prior.efforts, turn.efforts);
      if (turn.scope === 'same') prior.scope = 'same';
    }
    for (const [key, record] of result.requests) {
      const prior = requests.get(key);
      if (!prior || (prior.scope !== 'same' && record.scope === 'same')
          || (prior.scope === record.scope && record.time < prior.time)) requests.set(key, record);
    }
    snapshots.push(...result.snapshots.map(row => ({ ...row, scope: result.scope })));
  }
  return { coverage, turns, requests, snapshots, sessionCatalog: [...catalog.values()], selectedSession,
    projects: workspace?.projectIndex ? workspace.projectIndex.projectList : null };
}
