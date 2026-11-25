// Passive, read-only SQLite history collector for Google Antigravity local conversations.
// Reads ~/.gemini/antigravity/conversations/*.db with mtime+size+WAL caching.

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  isKnownModelEnum,
  modelLabelFromEnum,
  parseStepMetadata,
  parseTrajectoryMeta,
  parseUserPreview,
  splitModelAndEffort,
  workspaceDisplayName,
} from './antigravity-proto.mjs';
import { projectPath } from './projects.mjs';

const MAX_DBS = 256;
const STEP_USER_INPUT = 14;
const STEP_PLANNER_RESPONSE = 15;
const STEP_SUMMARY_CALL = 23;
const STEP_INVOKE_SUBAGENT = 132;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function reference(salt, value) {
  return createHmac('sha256', salt).update(value).digest('hex').slice(0, 16);
}

function addLabels(previous, next) {
  return [...new Set([...(previous ?? []), ...(next ?? [])].filter(Boolean))];
}

function defaultAntigravityHome() {
  return process.env.ANTIGRAVITY_HOME || join(homedir(), '.gemini', 'antigravity');
}

function catalogTime(value) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value.replace(' ', 'T'));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function workspaceKey(uri) {
  if (typeof uri !== 'string' || !uri.trim()) return null;
  try {
    const url = new URL(uri.trim());
    if (url.protocol === 'file:') {
      const path = decodeURIComponent(url.pathname);
      if (url.hostname) return projectPath(`//${url.hostname}${path}`);
      if (/^\/[a-z]:\//i.test(path)) return projectPath(path.slice(1));
      return path.replace(/\/+$/, '') || '/';
    }
  } catch { /* A workspace can also be stored as a path. */ }
  return projectPath(uri.trim()) ?? uri.trim().replace(/\/+$/, '');
}

function readConversationCatalog(home, salt, includePreviews) {
  const catalog = new Map();
  let db;
  try {
    db = new DatabaseSync(join(home, 'conversation_summaries.db'), { readOnly: true });
    const cols = new Set(db.prepare('PRAGMA table_info(conversation_summaries)').all().map(c => c.name));
    const title = includePreviews ? 'title' : 'NULL AS title';
    const parentCol = cols.has('parent_conversation_id') ? 'parent_conversation_id' : 'NULL AS parent_conversation_id';
    const depthCol = cols.has('nesting_depth') ? 'nesting_depth' : '0 AS nesting_depth';
    for (const row of db.prepare(`SELECT conversation_id, project_id, workspace_uris,
      last_modified_time, last_user_input_time, ${title}, ${parentCol}, ${depthCol} FROM conversation_summaries`).iterate()) {
      if (!row.conversation_id) continue;
      let workspaceUri;
      try {
        const uris = JSON.parse(row.workspace_uris);
        if (Array.isArray(uris)) workspaceUri = uris.find(uri => typeof uri === 'string' && uri.trim());
      } catch { /* Use the conversation's workspace when available. */ }
      const parentRawId = typeof row.parent_conversation_id === 'string' && row.parent_conversation_id.trim()
        ? row.parent_conversation_id.trim() : null;
      const nestingDepth = Number.isSafeInteger(row.nesting_depth) && row.nesting_depth > 0 ? row.nesting_depth : 0;
      catalog.set(reference(salt, 'ag-session/' + row.conversation_id), {
        rawId: row.conversation_id,
        parentRawId,
        isSubagent: Boolean(parentRawId) || nestingDepth > 0,
        projectReference: row.project_id ? reference(salt, 'ag-native-project/' + row.project_id) : null,
        workspaceUri,
        updatedAt: catalogTime(row.last_modified_time) ?? catalogTime(row.last_user_input_time),
        title: typeof row.title === 'string' ? row.title.trim().slice(0, 120) || undefined : undefined,
      });
    }
  } catch { /* Older installations can be read directly from their conversation databases. */ }
  finally { db?.close(); }
  return catalog;
}

async function dbFingerprint(dbPath) {
  const main = await stat(dbPath);
  let walMtime = 0;
  let walSize = 0;
  try {
    const wal = await stat(dbPath + '-wal');
    walMtime = wal.mtimeMs;
    walSize = wal.size;
  } catch { /* No active WAL file. */ }
  return {
    path: dbPath,
    mtime: Math.max(main.mtimeMs, walMtime),
    mainMtime: main.mtimeMs,
    size: main.size,
    ino: main.ino,
    walMtime,
    walSize,
  };
}

function resolveUnknownModelsFromTranscript(home, cascadeId, stepModels) {
  const discovered = new Map();
  if (!home || !cascadeId || stepModels.size === 0) return discovered;
  const transcriptPath = join(home, 'brain', cascadeId, '.system_generated', 'logs', 'transcript.jsonl');
  try {
    const text = readFileSync(transcriptPath, 'utf8');
    let currentName = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (typeof obj.content === 'string') {
        const match = /Model Selection` from .+? to (.+?)\.\s/.exec(obj.content);
        if (match) currentName = match[1].trim();
      }
      if (obj.type === 'PLANNER_RESPONSE' && currentName && stepModels.has(obj.step_index)) {
        discovered.set(stepModels.get(obj.step_index), currentName);
      }
    }
  } catch { /* Transcript may not exist for older conversations */ }
  return discovered;
}

export function readConversationDb(dbPath, salt, includePreviews = false, home = null) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const fallbackId = basename(dbPath, '.db');
    let meta = {};
    try {
      const row = db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').get();
      if (row?.data) meta = parseTrajectoryMeta(row.data);
    } catch { /* Table may be absent in older/partial DBs. */ }

    let cascadeId = meta.cascadeId || fallbackId;
    try {
      const tmeta = db.prepare('SELECT cascade_id, trajectory_id FROM trajectory_meta LIMIT 1').get();
      if (tmeta?.cascade_id) cascadeId = tmeta.cascade_id;
    } catch { /* Optional table. */ }

    const parentRawId = meta.parentConversationId && meta.parentConversationId !== cascadeId
      ? meta.parentConversationId
      : (meta.cascadeId && meta.cascadeId !== cascadeId && meta.nestingDepth > 0 ? meta.cascadeId : null);
    const isSubagent = Boolean(parentRawId) || (meta.nestingDepth ?? 0) > 0;

    const sessionRef = reference(salt, 'ag-session/' + cascadeId);
    const projectKey = workspaceKey(meta.workspaceUri);
    const projectRef = projectKey ? reference(salt, 'ag-project/' + projectKey) : '';
    const projectName = meta.workspaceName || 'Proyecto local';

    const turns = new Map();
    const turnRawIds = new Map();
    const requests = new Map();
    const unknownStepModels = new Map();
    const subagentLinks = new Map();
    let malformed = 0;
    let firstTs = meta.startedAtMs ?? Infinity;
    let lastTs = meta.startedAtMs ?? -Infinity;
    let lastUserTurnKey = null;
    let latestTitle = null;

    // Query only USER_INPUT (14) and LLM-bearing steps (15, 23). Avoids reading huge gen_metadata blobs.
    const sql = includePreviews
      ? `SELECT idx, step_type, status, metadata, CASE WHEN step_type = ${STEP_USER_INPUT} THEN step_payload ELSE NULL END AS payload
         FROM steps WHERE step_type IN (${STEP_USER_INPUT}, ${STEP_PLANNER_RESPONSE}, ${STEP_SUMMARY_CALL}) ORDER BY idx ASC`
      : `SELECT idx, step_type, status, metadata, NULL AS payload
         FROM steps WHERE step_type IN (${STEP_USER_INPUT}, ${STEP_PLANNER_RESPONSE}, ${STEP_SUMMARY_CALL}) ORDER BY idx ASC`;

    let rows = [];
    try {
      rows = db.prepare(sql).all();
    } catch {
      return null;
    }

    for (const row of rows) {
      if (!row.metadata) continue;
      const parsed = parseStepMetadata(row.metadata);
      if (!parsed) {
        malformed++;
        continue;
      }

      const stepTime = parsed.createdAtMs ?? parsed.completedAtMs;
      if (Number.isFinite(stepTime)) {
        if (stepTime < firstTs) firstTs = stepTime;
        if (stepTime > lastTs) lastTs = stepTime;
      }
      if (Number.isFinite(parsed.completedAtMs) && parsed.completedAtMs > lastTs) {
        lastTs = parsed.completedAtMs;
      }

      if (row.step_type === STEP_USER_INPUT) {
        const rawTurnId = parsed.turnId || `user-${row.idx}`;
        const turnKey = reference(salt, `${cascadeId}/${rawTurnId}`);
        const sentAt = stepTime ?? Date.now();
        const preview = includePreviews && row.payload ? parseUserPreview(row.payload) : undefined;
        if (preview) latestTitle = preview;

        const turn = turns.get(turnKey) ?? {
          key: turnKey,
          session: sessionRef,
          scope: 'same',
          started: sentAt,
          ended: null,
          first: Infinity,
          last: -Infinity,
          composer: true,
          messages: new Map(),
          models: [],
          efforts: [],
        };
        turn.started = Math.min(turn.started ?? Infinity, sentAt);
        turn.composer = true;
        turn.messages ??= new Map();
        const msgKey = reference(salt, `ag-msg/${cascadeId}/${row.idx}`);
        turn.messages.set(msgKey, { time: sentAt, preview });
        turns.set(turnKey, turn);
        turnRawIds.set(turnKey, rawTurnId);
        lastUserTurnKey = turnKey;
        continue;
      }

      // PLANNER_RESPONSE (15) or SUMMARY_CALL (23)
      if (!parsed.usage) continue;
      const rawTurnId = parsed.turnId;
      const turnKey = rawTurnId
        ? reference(salt, `${cascadeId}/${rawTurnId}`)
        : lastUserTurnKey ?? reference(salt, `${cascadeId}/orphan-${row.idx}`);

      const reqTime = parsed.completedAtMs ?? parsed.createdAtMs ?? lastTs;
      if (!Number.isFinite(reqTime)) continue;

      const turn = turns.get(turnKey) ?? {
        key: turnKey,
        session: sessionRef,
        scope: 'same',
        started: parsed.createdAtMs ?? reqTime,
        ended: null,
        first: Infinity,
        last: -Infinity,
        composer: false,
        messages: new Map(),
        models: [],
        efforts: [],
      };

      const startStamp = parsed.createdAtMs ?? reqTime;
      turn.first = Math.min(turn.first, startStamp);
      turn.last = Math.max(turn.last, reqTime);
      if (parsed.completedAtMs !== null && (turn.ended === null || parsed.completedAtMs >= turn.ended)) {
        turn.ended = parsed.completedAtMs;
        turn.outcome = row.status === 3 ? 'completed' : 'ended';
        if (turn.started !== null && turn.ended >= turn.started) {
          turn.durationMs = turn.ended - turn.started;
        }
      }
    const rawEnum = parsed.usage.modelEnum ?? parsed.modelEnum;
      const fullModel = modelLabelFromEnum(rawEnum);
      const { model, effort } = splitModelAndEffort(fullModel);
      if (rawEnum && !isKnownModelEnum(rawEnum)) unknownStepModels.set(row.idx, rawEnum);
      turn.models = addLabels(turn.models, [model]);
      turn.efforts = addLabels(turn.efforts, [effort]);
      if (rawEnum) {
        turn._rawEnums ??= new Set();
        turn._rawEnums.add(rawEnum);
      }
      turns.set(turnKey, turn);
      if (rawTurnId && !turnRawIds.has(turnKey)) turnRawIds.set(turnKey, rawTurnId);

      const reqId = reference(salt, `${cascadeId}/${parsed.usage.messageId || 'step-' + row.idx}`);
      if (!requests.has(reqId)) {
        requests.set(reqId, {
          turn: turnKey,
          time: reqTime,
          usage: parsed.usage.counts,
          scope: 'same',
          model,
          effort,
          _rawEnum: rawEnum,
        });
      }
    }

    if (unknownStepModels.size > 0 && home) {
      const dynamicMap = resolveUnknownModelsFromTranscript(home, cascadeId, unknownStepModels);
      if (dynamicMap.size > 0) {
        for (const turn of turns.values()) {
          if (!turn._rawEnums) continue;
          const models = [];
          const efforts = [];
          for (const enumVal of turn._rawEnums) {
            const { model, effort } = splitModelAndEffort(modelLabelFromEnum(enumVal, dynamicMap));
            if (model) models.push(model);
            if (effort) efforts.push(effort);
          }
          turn.models = addLabels([], models);
          turn.efforts = addLabels(turn.efforts, efforts);
        }
        for (const req of requests.values()) {
          if (req._rawEnum && dynamicMap.has(req._rawEnum)) {
            const split = splitModelAndEffort(modelLabelFromEnum(req._rawEnum, dynamicMap));
            if (split.model) req.model = split.model;
            if (split.effort) req.effort = split.effort;
          }
        }
      }
    }
    for (const turn of turns.values()) delete turn._rawEnums;
    for (const req of requests.values()) delete req._rawEnum;

    if (!isSubagent) {
      try {
        const invokeRows = db.prepare(
          `SELECT metadata, step_payload FROM steps WHERE step_type = ${STEP_INVOKE_SUBAGENT} AND step_payload IS NOT NULL ORDER BY idx ASC`,
        ).all();
        for (const row of invokeRows) {
          if (!row.metadata || !row.step_payload) continue;
          const payloadBuf = Buffer.isBuffer(row.step_payload) ? row.step_payload : Buffer.from(row.step_payload);
          if (payloadBuf.length < 36) continue;
          const matches = payloadBuf.toString('latin1').match(UUID_RE);
          if (!matches) continue;
          const metaParsed = parseStepMetadata(row.metadata);
          const parentTurnId = metaParsed?.turnId;
          if (!parentTurnId) continue;
          for (const uuid of matches) {
            const lower = uuid.toLowerCase();
            if (lower !== cascadeId.toLowerCase() && !subagentLinks.has(lower)) {
              subagentLinks.set(lower, parentTurnId);
            }
          }
        }
      } catch { /* Optional step type */ }
    }

    return {
      rawId: cascadeId,
      parentRawId,
      isSubagent,
      firstTs,
      lastTs,
      subagentLinks,
      turnRawIds,
      session: {
        reference: sessionRef,
        startedAt: Number.isFinite(firstTs) ? new Date(firstTs).toISOString() : null,
        updatedAt: Number.isFinite(lastTs) ? new Date(lastTs).toISOString() : null,
        partial: false,
        nativeTitle: latestTitle || undefined,
        projectReference: projectRef,
        projectSource: projectRef ? 'antigravity' : undefined,
      },
      project: projectRef ? { reference: projectRef, name: projectName } : null,
      workspaceUri: meta.workspaceUri,
      turns,
      requests,
      malformed,
    };
  } finally {
    db.close();
  }
}

export async function recentAntigravityHistory(home = defaultAntigravityHome(), salt, includePreviews = false, workspace) {
  const convDir = join(home, 'conversations');
  const files = [];
  let unavailableRoots = 0;
  let skipped = 0;

  try {
    const entries = await readdir(convDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.db')) continue;
      const fullPath = join(convDir, entry.name);
      try {
        files.push(await dbFingerprint(fullPath));
      } catch {
        skipped++;
      }
    }
  } catch {
    unavailableRoots++;
  }

  files.sort((a, b) => b.mtime - a.mtime);
  const catalog = readConversationCatalog(home, salt, includePreviews);
  const topFiles = files.slice(0, MAX_DBS);
  const wanted = workspace?.selected ?? [...catalog].sort((a, b) => (b[1].updatedAt ?? '').localeCompare(a[1].updatedAt ?? ''))[0]?.[0];
  const selectedFile = wanted && files.slice(MAX_DBS).find(file =>
    reference(salt, 'ag-session/' + basename(file.path, '.db')) === wanted);
  if (selectedFile) topFiles.push(selectedFile);

  const cache = workspace?.dbCache;
  if (cache) {
    const known = new Set(files.map(f => f.path));
    for (const key of cache.keys()) if (!known.has(key)) cache.delete(key);
  }

  const coverage = {
    discoveredFiles: files.length,
    scannedFiles: 0,
    truncatedFiles: 0,
    skippedFiles: skipped,
    unavailableRoots,
    sameAccountFiles: 0,
    unverifiedFiles: 0,
    otherAccountFiles: 0,
    malformedLines: 0,
    requestsWithoutIdentity: 0,
  };

  const turns = new Map();
  const requests = new Map();
  const sessions = new Map();
  const parsedEntries = [];
  const parsedByRawId = new Map();

  for (const file of topFiles) {
    let parsed = null;
    const cached = cache?.get(file.path);
    if (cached && cached.mainMtime === file.mainMtime && cached.size === file.size
        && cached.ino === file.ino && cached.walMtime === file.walMtime && cached.walSize === file.walSize
        && cached.includePreviews === includePreviews) {
      parsed = cached.parsed;
    } else {
      try {
        parsed = readConversationDb(file.path, salt, includePreviews, home);
        if (parsed) {
          cache?.set(file.path, { ...file, includePreviews, parsed });
        }
      } catch {
        coverage.skippedFiles++;
        continue;
      }
    }

    if (!parsed) {
      coverage.skippedFiles++;
      continue;
    }

    coverage.scannedFiles++;
    coverage.sameAccountFiles++;
    coverage.malformedLines += parsed.malformed;
    parsedEntries.push({ file, parsed });
    if (parsed.rawId) parsedByRawId.set(parsed.rawId.toLowerCase(), parsed);
  }

  // Build parent map across both DB metadata and conversation_summaries catalog
  const parentByRawId = new Map();
  const isSubagentRawId = new Set();
  for (const entry of catalog.values()) {
    if (!entry.rawId) continue;
    const idLower = entry.rawId.toLowerCase();
    if (entry.parentRawId) parentByRawId.set(idLower, entry.parentRawId.toLowerCase());
    if (entry.isSubagent) isSubagentRawId.add(idLower);
  }
  for (const { parsed } of parsedEntries) {
    if (!parsed.rawId) continue;
    const idLower = parsed.rawId.toLowerCase();
    if (parsed.parentRawId) parentByRawId.set(idLower, parsed.parentRawId.toLowerCase());
    if (parsed.isSubagent) isSubagentRawId.add(idLower);
  }

  function resolveRootRawId(rawId) {
    let cur = rawId.toLowerCase();
    const visited = new Set([cur]);
    while (parentByRawId.has(cur)) {
      const next = parentByRawId.get(cur);
      if (!next || visited.has(next)) break;
      visited.add(next);
      cur = next;
    }
    return cur;
  }

  const cloneTurn = (turn, overrides = null) => ({
    ...turn,
    messages: turn.messages ? new Map(turn.messages) : new Map(),
    models: [...(turn.models ?? [])],
    efforts: [...(turn.efforts ?? [])],
    ...(overrides ?? {}),
  });

  // Pass 1: Add all top-level (non-subagent) conversations and index their turns
  const parentUserTurns = new Map();
  for (const { file, parsed } of parsedEntries) {
    const idLower = parsed.rawId?.toLowerCase() ?? '';
    if (isSubagentRawId.has(idLower)) continue;

    sessions.set(parsed.session.reference, {
      ...parsed.session,
      startedAt: parsed.session.startedAt ?? new Date(file.mtime).toISOString(),
      updatedAt: parsed.session.updatedAt ?? new Date(file.mtime).toISOString(),
      workspaceUri: parsed.workspaceUri,
      projectName: parsed.project?.name,
    });

    const userTurns = [];
    for (const [key, turn] of parsed.turns) {
      const cloned = cloneTurn(turn);
      turns.set(key, cloned);
      if (cloned.composer) {
        const rawTurnId = parsed.turnRawIds?.get(key);
        if (rawTurnId) {
          userTurns.push({
            key,
            rawTurnId,
            start: cloned.started ?? cloned.first,
            end: cloned.ended ?? cloned.last,
          });
        }
      }
    }
    userTurns.sort((a, b) => a.start - b.start);
    if (idLower) parentUserTurns.set(idLower, userTurns);

    for (const [key, req] of parsed.requests) {
      if (!requests.has(key)) requests.set(key, req);
    }
  }

  // Pass 2: Fold every subagent DB into its root parent chat and exact parent turn
  for (const { parsed } of parsedEntries) {
    const idLower = parsed.rawId?.toLowerCase() ?? '';
    if (!isSubagentRawId.has(idLower)) continue;

    const rootLower = resolveRootRawId(idLower);
    const parentParsed = parsedByRawId.get(rootLower);
    const rootRawId = parentParsed?.rawId ?? rootLower;
    const rootSessionRef = reference(salt, 'ag-session/' + rootRawId);

    // Find exact parent turn_id via step_type=132 link (checking direct and root parent)
    let parentTurnRawId = parentParsed?.subagentLinks?.get(idLower) ?? null;
    if (!parentTurnRawId) {
      let cur = idLower;
      const seen = new Set([cur]);
      while (!parentTurnRawId && parentByRawId.has(cur)) {
        const pId = parentByRawId.get(cur);
        if (!pId || seen.has(pId)) break;
        seen.add(pId);
        parentTurnRawId = parsedByRawId.get(pId)?.subagentLinks?.get(cur) ?? null;
        cur = pId;
      }
    }

    // Time-based fallback if parent step_type=132 link wasn't found
    if (!parentTurnRawId && Number.isFinite(parsed.firstTs)) {
      const candidates = parentUserTurns.get(rootLower) ?? [];
      const enclosing = candidates.find(t => t.start - 5000 <= parsed.firstTs && t.end + 5000 >= parsed.firstTs)
        ?? candidates.filter(t => t.start <= parsed.firstTs).at(-1);
      if (enclosing) parentTurnRawId = enclosing.rawTurnId;
    }

    const familyKey = parentTurnRawId ? reference(salt, `ag-root/${rootRawId}/${parentTurnRawId}`) : null;
    if (familyKey && parentTurnRawId) {
      const parentTurnKey = reference(salt, `${rootRawId}/${parentTurnRawId}`);
      const parentTurn = turns.get(parentTurnKey);
      if (parentTurn) parentTurn.family = familyKey;
    }

    for (const [key, turn] of parsed.turns) {
      turns.set(key, cloneTurn(turn, {
        session: rootSessionRef,
        child: true,
        composer: false,
        messages: new Map(),
        ended: turn.ended ?? (Number.isFinite(turn.last) ? turn.last : null),
        ...(familyKey ? { family: familyKey } : {}),
      }));
    }
    for (const [key, req] of parsed.requests) {
      if (!requests.has(key)) requests.set(key, req);
    }

    // Keep parent session updatedAt fresh if subagent ran later
    const parentSess = sessions.get(rootSessionRef);
    if (parentSess && parsed.session.updatedAt && (!parentSess.updatedAt || parsed.session.updatedAt > parentSess.updatedAt)) {
      parentSess.updatedAt = parsed.session.updatedAt;
    }
  }

  for (const [ref, entry] of catalog) {
    if (entry.isSubagent) continue;
    if (!sessions.has(ref)) sessions.set(ref, { reference: ref, partial: true });
  }
  const projectsMap = new Map();
  const sessionCatalog = [...sessions.values()].map(({ workspaceUri, projectName, ...session }) => {
    const summary = catalog.get(session.reference);
    const folder = summary?.workspaceUri ?? workspaceUri;
    const folderKey = workspaceKey(folder);
    const projectReference = summary?.projectReference ??
      (folderKey ? reference(salt, 'ag-project/' + folderKey) : '');
    return {
      ...session,
      nativeTitle: summary?.title ?? session.nativeTitle,
      updatedAt: [summary?.updatedAt, session.updatedAt].filter(Boolean).sort().at(-1),
      projectReference,
      projectSource: projectReference ? 'antigravity' : undefined,
      projectName: workspaceDisplayName(summary?.workspaceUri) ?? projectName ?? workspaceDisplayName(folder),
    };
  }).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    .map(({ projectName, ...session }) => {
      if (session.projectReference && !projectsMap.get(session.projectReference)?.name)
        projectsMap.set(session.projectReference, { reference: session.projectReference, name: projectName });
      return session;
    });
  const selectedSession = workspace && sessionCatalog.some(s => s.reference === workspace.selected)
    ? workspace.selected
    : sessionCatalog[0]?.reference ?? null;

  const projects = [...projectsMap.values()].map(project => ({ ...project, name: project.name ?? 'Proyecto de Antigravity' }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));

  const result = {
    coverage,
    turns,
    requests,
    snapshots: [],
    sessionCatalog,
    selectedSession,
    projects,
  };
  return result;
}
