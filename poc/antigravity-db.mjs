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
} from './antigravity-proto.mjs';

const MAX_DBS = 48;
const STEP_USER_INPUT = 14;
const STEP_PLANNER_RESPONSE = 15;
const STEP_SUMMARY_CALL = 23;

function reference(salt, value) {
  return createHmac('sha256', salt).update(value).digest('hex').slice(0, 16);
}

function addLabels(previous, next) {
  return [...new Set([...(previous ?? []), ...(next ?? [])].filter(Boolean))];
}

function defaultAntigravityHome() {
  return process.env.ANTIGRAVITY_HOME || join(homedir(), '.gemini', 'antigravity');
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

    const sessionRef = reference(salt, 'ag-session/' + cascadeId);
    const projectKey = meta.workspaceUri ? meta.workspaceUri.toLowerCase() : null;
    const projectRef = projectKey ? reference(salt, 'ag-project/' + projectKey) : '';
    const projectName = meta.workspaceName || null;

    const turns = new Map();
    const requests = new Map();
    const unknownStepModels = new Map();
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

    return {
      session: {
        reference: sessionRef,
        startedAt: Number.isFinite(firstTs) ? new Date(firstTs).toISOString() : null,
        updatedAt: Number.isFinite(lastTs) ? new Date(lastTs).toISOString() : null,
        partial: false,
        nativeTitle: latestTitle || undefined,
        projectReference: projectRef,
        projectSource: projectRef ? 'antigravity' : undefined,
      },
      project: projectRef && projectName ? { reference: projectRef, name: projectName } : null,
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
  const topFiles = files.slice(0, MAX_DBS);
  const snapshotKey = `${includePreviews ? 1 : 0}|${skipped}|${unavailableRoots}|` +
    topFiles.map(f => `${f.path}:${f.mainMtime}:${f.size}:${f.ino}:${f.walMtime}:${f.walSize}`).join(';');
  if (workspace?.snapshotCache && workspace.snapshotCache.key === snapshotKey) {
    const cachedSnap = workspace.snapshotCache.value;
    const selectedSession = cachedSnap.sessionCatalog.some(s => s.reference === workspace.selected)
      ? workspace.selected
      : cachedSnap.sessionCatalog[0]?.reference ?? null;
    return { ...cachedSnap, selectedSession };
  }

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
  const projectsMap = new Map();
  const sessionCatalog = [];

  for (const file of files.slice(0, MAX_DBS)) {
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

    const sessionEntry = {
      ...parsed.session,
      startedAt: parsed.session.startedAt ?? new Date(file.mtime).toISOString(),
      updatedAt: parsed.session.updatedAt ?? new Date(file.mtime).toISOString(),
    };
    sessionCatalog.push(sessionEntry);

    if (parsed.project && !projectsMap.has(parsed.project.reference)) {
      projectsMap.set(parsed.project.reference, parsed.project);
    }

    for (const [key, turn] of parsed.turns) {
      turns.set(key, turn);
    }
    for (const [key, req] of parsed.requests) {
      if (!requests.has(key)) requests.set(key, req);
    }
  }

  sessionCatalog.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  const selectedSession = workspace && sessionCatalog.some(s => s.reference === workspace.selected)
    ? workspace.selected
    : sessionCatalog[0]?.reference ?? null;

  const projects = [...projectsMap.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'));

  const result = {
    coverage,
    turns,
    requests,
    snapshots: [],
    sessionCatalog,
    selectedSession,
    projects,
  };
  if (workspace) {
    workspace.snapshotCache = { key: snapshotKey, value: result };
  }
  return result;
}
