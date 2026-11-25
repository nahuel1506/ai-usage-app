
import { createHmac, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as wait } from 'node:timers/promises';

const MAX_FILES = 256;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_CAPTURE_COUNT = 50_000;
const LEGACY_MAX_ANCHOR_AGE_MS = 300_000;
const MAIN_WINDOWS = [300, 10080];

async function localSecret(folder) {
  const path = join(folder, 'quota-scope.key');
  try { return await readFile(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  await mkdir(folder, { recursive: true, mode: 0o700 });
  try {
    const file = await open(path, 'wx', 0o600);
    const secret = randomBytes(32);
    try { await file.writeFile(secret); }
    finally { await file.close(); }
    return secret;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    for (let attempt = 0; attempt < 3; attempt++) {
      const secret = await readFile(path);
      if (secret.length === 32) return secret;
      await wait(20);
    }
    return null;
  }
}

export async function recordingScope(folder, accountId) {
  if (typeof accountId !== 'string' || !accountId) return null;
  try {
    const secret = await localSecret(folder);
    if (secret?.length !== 32) return null;
    return createHmac('sha256', secret).update(accountId).digest('hex');
  } catch {
    return null;
  }
}

async function readRecording(path, size, rows) {
  if (!size) return;
  const start = Math.max(0, size - MAX_BYTES);
  const input = createReadStream(path, { start, end: size - 1, encoding: 'utf8' });
  const reader = createInterface({ input, crlfDelay: Infinity });
  let first = true;
  try {
    for await (const line of reader) {
      if (first && start > 0) {
        first = false;
        continue;
      }
      first = false;
      try {
        const record = JSON.parse(line);
        const time = Date.parse(record.quota?.observedAt);
        if (record.type === 'sample' && record.quota?.source === 'codex-app-server' &&
            Array.isArray(record.quota.windows) && Number.isFinite(time)) {
          rows.push({
            time, quota: record.quota, accountScope: record.accountScope,
            accountComparable: record.accountComparable, reconciliation: record.reconciliation,
          });
        }
      } catch { /* A recorder may still be writing the last line. */ }
    }
  } finally {
    reader.close();
    input.destroy();
  }
}

export async function readQuotaRecordings(folder) {
  let entries;
  try { entries = await readdir(folder, { withFileTypes: true }); }
  catch { return []; }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^codex-[a-f0-9-]+\.jsonl$/i.test(entry.name)) continue;
    const path = join(folder, entry.name);
    try { files.push({ path, ...(await stat(path)) }); }
    catch { /* The user may have removed a recording. */ }
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const rows = [];
  for (const file of files.slice(0, MAX_FILES)) {
    try { await readRecording(file.path, file.size, rows); }
    catch { /* The other recordings remain usable. */ }
  }
  return rows.sort((left, right) => left.time - right.time).slice(-MAX_CAPTURE_COUNT);
}

function evidenceKey(pool, minutes, time, usedPercent) {
  return JSON.stringify([pool, minutes, time, usedPercent]);
}

function legacyAgrees(record, evidence) {
  if (record.accountComparable !== true || !Array.isArray(record.reconciliation)) return false;
  const presentWindows = MAIN_WINDOWS.filter(minutes =>
    record.quota.windows.some(row => row.pool === 'codex' && row.minutes === minutes));
  if (presentWindows.length === 0) return false;
  return presentWindows.every(minutes => {
    const current = record.quota.windows.filter(row => row.pool === 'codex' && row.minutes === minutes);
    const report = record.reconciliation.find(row => row.pool === 'codex' && row.minutes === minutes)?.historical;
    const time = Date.parse(report?.observedAt);
    const reset = Date.parse(report?.resetsAt);
    if (!report || report.source !== 'codex-rollout' || current.length !== 1 ||
        !Number.isFinite(time) || !Number.isFinite(reset) ||
        time > record.time || record.time - time > LEGACY_MAX_ANCHOR_AGE_MS ||
        reset <= record.time || !(Math.abs(Date.parse(current[0].resetsAt) - reset) <= 2000))
      return false;

    const key = evidenceKey('codex', minutes, time, report.usedPercent);
    return evidence.get(key)?.some(providerReset => Math.abs(providerReset - reset) <= 2000) ?? false;
  });
}

export function recordedQuotaPoints(recordings, accountScope, history) {
  if (!accountScope || !recordings.length) return [];
  const evidence = new Map();
  if (recordings.some(record => record.accountScope === undefined)) {
    for (const sample of history.snapshots) {
      if (sample.scope !== 'same' || sample.pool !== 'codex' || !MAIN_WINDOWS.includes(sample.minutes)) continue;
      const key = evidenceKey(sample.pool, sample.minutes, sample.time, sample.usedPercent);
      if (!evidence.has(key)) evidence.set(key, []);
      evidence.get(key).push(Date.parse(sample.resetsAt));
    }
  }
  return recordings.flatMap(record => {
    if (record.accountScope === undefined ? !legacyAgrees(record, evidence) : record.accountScope !== accountScope)
      return [];
    return record.quota.windows
      .filter(row => row.pool === 'codex' && MAIN_WINDOWS.includes(row.minutes) &&
        Number.isFinite(row.usedPercent) && row.usedPercent >= 0 && Number.isFinite(Date.parse(row.resetsAt)))
      .map(row => ({ ...row, plan: record.quota.plan, time: record.time, scope: 'same', source: 'app-server', recorded: true }));
  });
}

