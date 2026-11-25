import { createReadStream } from 'node:fs';
import { createHmac } from 'node:crypto';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createZstdDecompress } from 'node:zlib';
import { windowsFromLog } from './app-server.mjs';
import { projectPath, sessionProject } from './projects.mjs';

const MAX_FILES = 128;
const ALWAYS_SCAN_COUNT = 24;
const RECENT_WINDOW_MS = 35 * 86_400_000;
const HEADER_BYTES = 64 * 1024;
const MAX_COMPRESSED = 128 * 1024 * 1024;
const MAX_SESSION_LINE = 64 * 1024 * 1024;
const FAST_SKIP_THRESHOLD = 4096;
const RELEVANT_MARKERS = [
  'token_usage_record',
  'token_count',
  'task_started',
  'task_complete',
  'turn_aborted',
  'turn_context',
  'session_meta',
  'user_message',
  'user.',
].map(s => Buffer.from(s, 'utf8'));

const usageKeys = [
  'input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
  'output_tokens', 'reasoning_output_tokens', 'total_tokens',
];

function bufferHasRelevantMarker(buf) {
  for (let i = 0; i < RELEVANT_MARKERS.length; i++) {
    if (buf.includes(RELEVANT_MARKERS[i])) return true;
  }
  return false;
}

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

function sessionMetadata(head) {
  return head.map(parseLine).find(event => event?.type === 'session_meta')?.payload;
}

function sessionReference(salt, thread) {
  return typeof thread === 'string'
    ? createHmac('sha256', salt).update('session/' + thread).digest('hex').slice(0, 16) : null;
}

function parentThreadOf(meta) {
  if (!meta || typeof meta !== 'object') return null;
  if (typeof meta.parent_thread_id === 'string' && meta.parent_thread_id.trim()) return meta.parent_thread_id.trim();
  const spawnParent = typeof meta.source === 'object' ? meta.source?.subagent?.thread_spawn?.parent_thread_id : null;
  if (typeof spawnParent === 'string' && spawnParent.trim()) return spawnParent.trim();
  return null;
}

function isSubagentMeta(meta) {
  if (!meta || typeof meta !== 'object') return false;
  return Boolean((typeof meta.source === 'object' && meta.source?.subagent) || parentThreadOf(meta));
}

const AMBIENT_BLOCK_RE = /^\s*<(?:in-app-browser-context|environment_context|instructions|turn_aborted|system[_-]instruction)\b/i;

function isAmbientUserText(text) {
  return typeof text === 'string' && AMBIENT_BLOCK_RE.test(text);
}

function addLabels(previous, next) {
  return [...new Set([...(previous ?? []), ...(next ?? [])].filter(Boolean))];
}

function createRolloutReader(head, accountId, salt, includePreviews, verifiedThreads = null) {
  const meta = sessionMetadata(head);
  const owner = meta?.creator_account_id;
  const thread = meta?.id ?? meta?.session_id;
  const parentThread = parentThreadOf(meta);
  const isSubagent = isSubagentMeta(meta);
  const verifiedByCatalog = Boolean(
    accountId && verifiedThreads && ((thread && verifiedThreads.has(thread)) || (parentThread && verifiedThreads.has(parentThread))),
  );
  const scope = owner
    ? (!accountId ? 'unverified' : owner === accountId ? 'same' : 'different')
    : verifiedByCatalog ? 'same' : 'unverified';
  const turns = new Map();
  const requests = new Map();
  const snapshots = [];
  const reference = id => createHmac('sha256', salt).update(id).digest('hex').slice(0, 16);
  let malformed = 0;
  let omittedRequests = 0;
  let activeTurnId = null;

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
    const isEventUser = event.type === 'event_msg' && payload.type === 'user_message';
    const chat = payload.internal_chat_message_metadata_passthrough;
    const userItems = event.type === 'response_item' && payload.type === 'message' && payload.role === 'user'
      && Array.isArray(chat?.content_item_kinds)
      ? chat.content_item_kinds.flatMap((kind, index) => {
        if (typeof kind !== 'string' || !kind.startsWith('user.')) return [];
        const provenance = chat.content_item_metadata?.[index]?.provenance?.type;
        return provenance === undefined || provenance === 'user' ? [index] : [];
      })
      : [];
    const isUser = userItems.length > 0 || isEventUser;
    if (!isRequest && !isStart && !isEnd && !isContext && !isUser) return;

    if (isStart && typeof payload.turn_id === 'string') activeTurnId = payload.turn_id;
    else if (isContext && typeof payload.turn_id === 'string' && !activeTurnId) activeTurnId = payload.turn_id;

    const turnId = isEventUser
      ? (typeof payload.turn_id === 'string' ? payload.turn_id : activeTurnId)
      : isUser
        ? (typeof chat?.turn_id === 'string' ? chat.turn_id : activeTurnId)
        : payload.turn_id;
    const threadId = payload.thread_id ?? thread;
    if (typeof turnId !== 'string' || typeof threadId !== 'string') {
      if (isRequest) omittedRequests++;
      return;
    }
    if (isEnd && activeTurnId === turnId) activeTurnId = null;

    const key = reference(threadId + '/' + turnId);
    const effectiveSession = sessionReference(salt, parentThread ?? threadId);
    const turn = turns.get(key) ?? {
      key, session: effectiveSession, scope, started: null, ended: null, first: Infinity, last: -Infinity,
      ...(isSubagent ? { child: true } : {}),
    };
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
      const userTexts = isEventUser
        ? [typeof payload.message === 'string' ? payload.message : typeof payload.text === 'string' ? payload.text : '']
        : userItems.flatMap(index => {
          const item = payload.content?.[index];
          return item?.type === 'input_text' && typeof item.text === 'string' ? [item.text] : [];
        });
      const nonAmbient = userTexts.filter(t => t && !isAmbientUserText(t));
      const allAmbient = userTexts.length > 0 && nonAmbient.length === 0;
      if (!allAmbient) {
        const msgKey = reference('message/' + (payload.id ?? turnId + '/' + time));
        turn.messages ??= new Map();
        let preview;
        if (includePreviews && scope === 'same') {
          const text = nonAmbient.map(t => t.slice(0, 180)).join(' ').replace(/\s+/g, ' ').trim();
          preview = text.length > 96 ? text.slice(0, 96).trimEnd() + '…' : text || undefined;
        }
        if (!turn.messages.has(msgKey) || preview) turn.messages.set(msgKey, { time, preview });
      }
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
    result: () => ({
      session: sessionReference(salt, parentThread ?? thread),
      ownSession: sessionReference(salt, thread),
      isSubagent,
      parentThread,
      sessionStartedAt: meta?.timestamp,
      scope, turns, requests, snapshots, malformed, omittedRequests,
    }),
  };
}

export function summarizeRollout(head, lines, accountId, salt, includePreviews = false, verifiedThreads = null) {
  const reader = createRolloutReader(head, accountId, salt, includePreviews, verifiedThreads);
  for (const line of lines) reader.add(line);
  return reader.result();
}

async function appendSession(state, path, size) {
  const compressed = path.endsWith('.zst');
  if (!compressed && size <= state.cursor) return;
  const source = createReadStream(path, compressed ? {} : { start: state.cursor, end: size - 1 });
  const decoder = compressed ? createZstdDecompress() : null;
  if (decoder) source.once('error', error => decoder.destroy(error));
  const stream = decoder ? source.pipe(decoder) : source;
  let parts = [];
  let length = 0;
  let cursor = state.cursor;
  function feedBuffer(buf) {
    if (buf.length > FAST_SKIP_THRESHOLD && !bufferHasRelevantMarker(buf)) return;
    state.reader.add(buf.toString('utf8'));
  }
  try {
    for await (const chunk of stream) {
      let start = 0;
      for (let end = chunk.indexOf(10, start); end !== -1; end = chunk.indexOf(10, start)) {
        const piece = chunk.subarray(start, end);
        const totalLen = length + piece.length;
        if (totalLen <= MAX_SESSION_LINE) {
          feedBuffer(parts.length ? Buffer.concat([...parts, piece]) : piece);
        } else {
          state.skippedLines++;
        }
        cursor += totalLen + 1;
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
      if (length <= MAX_SESSION_LINE) feedBuffer(Buffer.concat(parts));
      else state.skippedLines++;
    }
  } finally {
    source.destroy();
    if (compressed) stream.destroy();
  }
}

async function readSelectedRollout(entry, accountId, salt, includePreviews, cache, verifiedThreads = null) {
  const info = await stat(entry.path);
  const compressed = entry.path.endsWith('.zst');
  const verified = Boolean(accountId && verifiedThreads && (
    (entry.thread && verifiedThreads.has(entry.thread)) || (entry.parentThread && verifiedThreads.has(entry.parentThread))
  ));
  let state = cache.get(entry.path);
  if (!state || state.accountId !== accountId || state.includePreviews !== includePreviews
      || state.verified !== verified
      || state.ino !== info.ino || (!compressed && info.size < state.cursor)
      || (compressed && (state.mtime !== info.mtimeMs || state.size !== info.size))) {
    state = {
      cursor: 0, skippedLines: 0, accountId, includePreviews, verified, ino: info.ino, mtime: -1, size: 0,
      reader: createRolloutReader(entry.head, accountId, salt, includePreviews, verifiedThreads),
    };
    cache.set(entry.path, state);
  }
  const needsRead = compressed
    ? (state.mtime !== info.mtimeMs || state.size !== info.size)
    : (state.mtime !== info.mtimeMs || state.cursor !== info.size);
  if (needsRead) {
    await appendSession(state, entry.path, info.size);
    state.mtime = info.mtimeMs;
    state.size = info.size;
  }
  return { ...state.reader.result(), skippedLines: state.skippedLines };
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
        } catch { skipped++; }
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
  const verifiedThreads = workspace?.projectIndex?.threads ?? null;
  function register(absolute, mtime, head, partial) {
    const meta = sessionMetadata(head);
    if (isSubagentMeta(meta)) return;
    const thread = meta?.id ?? meta?.session_id;
    const reference = sessionReference(salt, thread);
    const owner = meta?.creator_account_id;
    const owned = owner
      ? Boolean(accountId && owner === accountId)
      : Boolean(accountId && thread && verifiedThreads?.has(thread));
    if (reference && owned) {
      sessionFiles.set(absolute, {
        path: absolute, head, thread, cwd: meta.cwd, reference, mtime,
        startedAt: meta.timestamp, partial,
      });
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

  const recentCutoff = Date.now() - RECENT_WINDOW_MS;
  for (let fileIndex = 0; fileIndex < Math.min(files.length, MAX_FILES); fileIndex++) {
    const file = files[fileIndex];
    const { absolute, mtime, size, ino } = file;
    const compressed = absolute.endsWith('.zst');
    try {
      if (fileIndex >= ALWAYS_SCAN_COUNT && mtime < recentCutoff && workspace) {
        const head = await cachedHeader(file);
        if (head) register(absolute, mtime, head, true);
        continue;
      }
      if (compressed && size > MAX_COMPRESSED) {
        coverage.skippedFiles++;
        const head = workspace ? await cachedHeader(file) : null;
        if (head) register(absolute, mtime, head, true);
        continue;
      }

      const head = await cachedHeader(file);
      const headMeta = sessionMetadata(head);
      const headThread = headMeta?.id ?? headMeta?.session_id;
      const headParent = parentThreadOf(headMeta);
      const verified = Boolean(accountId && verifiedThreads && (
        (headThread && verifiedThreads.has(headThread)) || (headParent && verifiedThreads.has(headParent))
      ));

      let state = recentCache?.get(absolute);
      const needsReset = !state || state.accountId !== accountId || state.includePreviews !== includePreviews
        || state.verified !== verified
        || state.ino !== ino || (!compressed && size < state.cursor)
        || (compressed && (state.mtime !== mtime || state.size !== size));

      if (needsReset) {
        state = {
          cursor: 0, skippedLines: 0, accountId, includePreviews, verified, ino, mtime: -1, size: 0, head,
          reader: createRolloutReader(head, accountId, salt, includePreviews, verifiedThreads),
        };
        recentCache?.set(absolute, state);
      }

      const needsRead = compressed
        ? (state.mtime !== mtime || state.size !== size)
        : (state.mtime !== mtime || state.cursor !== size);

      if (needsRead) {
        await appendSession(state, absolute, size);
        state.mtime = mtime;
        state.size = size;
      }

      const result = state.reader.result();
      const truncated = Boolean(state.skippedLines);
      collected.push({ path: absolute, result, truncated, full: true });
      if (workspace && result.scope === 'same') register(absolute, mtime, state.head, truncated);
    } catch { coverage.skippedFiles++; }
  }

  if (workspace?.projectIndex && accountId) {
    const beyondSample = files.slice(MAX_FILES).filter(file =>
      workspace.projectIndex.files.has(projectPath(file.absolute)?.replace(/\.zst$/, '')));
    // Index these session headers only. Opening a session streams its body on demand.
    for (const file of beyondSample) {
      try { register(file.absolute, file.mtime, await cachedHeader(file), true); }
      catch { /* The indexed file may have moved while Codex was writing. */ }
    }
  }

  const catalog = new Map();
  let sessionCatalog = [];
  let selectedSession = null;
  if (workspace) {
    for (const file of sessionFiles.values()) {
      const entry = catalog.get(file.reference) ?? {
        reference: file.reference, startedAt: file.startedAt || mtimeIso(file.mtime),
        updatedAt: workspace.projectIndex?.threads.get(file.thread)?.updatedAt ?? mtimeIso(file.mtime), partial: false,
        ...sessionProject(workspace.projectIndex, file.thread, file.cwd),
      };
      entry.partial ||= file.partial;
      catalog.set(file.reference, entry);
    }
    sessionCatalog = [...catalog.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    selectedSession = catalog.has(workspace.selected) ? workspace.selected : sessionCatalog[0]?.reference ?? null;
    const selectedPaths = [...sessionFiles.values()].filter(file => file.reference === selectedSession);
    const paths = new Set(selectedPaths.map(file => file.path));
    for (const path of workspace.cache.keys()) if (!paths.has(path)) workspace.cache.delete(path);
    if (selectedSession) {
      let partial = false;
      for (const entry of selectedPaths) {
        const existingIndex = collected.findIndex(item => item.path === entry.path);
        if (existingIndex !== -1 && collected[existingIndex].full) {
          const existing = collected[existingIndex];
          partial ||= Boolean(existing.truncated || existing.result.malformed);
          continue;
        }
        try {
          const full = await readSelectedRollout(entry, accountId, salt, includePreviews, workspace.cache, verifiedThreads);
          partial ||= Boolean(full.skippedLines || full.malformed);
          const item = { path: entry.path, result: full, truncated: Boolean(full.skippedLines), full: true };
          if (existingIndex === -1) {
            collected.push(item);
            if (files.slice(0, MAX_FILES).some(file => file.absolute === entry.path)) coverage.skippedFiles--;
          } else collected[existingIndex] = item;
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
        for (const [msgKey, message] of turn.messages)
          if (!prior.messages.has(msgKey) || message.preview) prior.messages.set(msgKey, message);
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
  return {
    coverage, turns, requests, snapshots, sessionCatalog, selectedSession,
    projects: workspace?.projectIndex ? workspace.projectIndex.projectList : null,
  };
}
