// Passive local usage + official `agy /usage` live quota collector for Google Antigravity.
// Mirrors the codex-poc.mjs JSONL streaming protocol so the desktop app can
// monitor both providers with the same UI and attribution semantics.

import { randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as wait } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { findAgyExecutable, readAgyUsage } from './antigravity-cli.mjs';
import { recentAntigravityHistory } from './antigravity-db.mjs';
import { applyExternalPricing } from './pricing.mjs';
import { readPricingCache, syncPricingCache } from './pricing-sync.mjs';
import { analyticsSummary, interactionSummary, requestSummary } from './report.mjs';

const HELP = `node poc/antigravity-poc.mjs
node poc/antigravity-poc.mjs --watch --interval 30 [--samples 10]
Opciones adicionales: --hours 24, --home RUTA_ABSOLUTA, --agy RUTA_ABSOLUTA, --help`;

const AG_BUCKETS = [
  { pool: 'gemini', minutes: 300 },
  { pool: 'gemini', minutes: 10080 },
  { pool: 'claude_gpt', minutes: 300 },
  { pool: 'claude_gpt', minutes: 10080 },
];

function numberInRange(value, name, min, max) {
  if (!/^\d+$/.test(value ?? '')) throw new Error(name + ' requiere un número entero.');
  const number = Number(value);
  if (number < min || number > max) throw new Error(name + ' admite de ' + min + ' a ' + max + '.');
  return number;
}

async function readSavedRecordings(folder) {
  let entries;
  try { entries = await readdir(folder, { withFileTypes: true }); }
  catch { return []; }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^antigravity-[a-z0-9-]+\.jsonl$/i.test(entry.name)) continue;
    const path = join(folder, entry.name);
    try { files.push({ path, mtimeMs: (await stat(path)).mtimeMs }); }
    catch { /* Ignore removed file */ }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const items = [];
  for (const file of files.slice(0, 16)) {
    try {
      const text = await readFile(file.path, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          const time = Date.parse(row.quota?.observedAt ?? row.observedAt);
          if (row.type === 'sample' && Array.isArray(row.quota?.windows) && row.quota.windows.length && Number.isFinite(time)) {
            items.push({ time, quota: row.quota, recorded: true });
          }
        } catch { /* Ignore partial line */ }
      }
    } catch { /* Ignore unreadable file */ }
  }
  items.sort((a, b) => a.time - b.time);
  return items.slice(-5000);
}

function buildManualSample(observedAt, windows) {
  return {
    type: 'sample',
    provider: 'antigravity',
    observedAt,
    quota: {
      source: windows.length ? 'manual-settings' : 'none',
      observedAt,
      readMs: 0,
      plan: 'Antigravity',
      windows,
    },
  };
}

function latestWindowsFrom(records) {
  const byKey = new Map();
  for (const rec of records) {
    for (const w of rec.quota?.windows ?? []) {
      const key = `${w.pool || 'gemini'}/${w.minutes ?? 300}`;
      byKey.set(key, w);
    }
  }
  return [...byKey.values()];
}

function toQuotaPoints(records) {
  return records.flatMap(rec => {
    const time = rec.time ?? Date.parse(rec.quota?.observedAt);
    if (!Number.isFinite(time)) return [];
    const source = rec.quota?.source || 'manual-settings';
    return (rec.quota?.windows ?? [])
      .filter(w => Number.isFinite(w.usedPercent) && w.usedPercent >= 0)
      .map(w => ({
        pool: w.pool || 'gemini',
        minutes: w.minutes ?? 300,
        usedPercent: w.usedPercent,
        resetsAt: w.resetsAt ?? new Date(time + (w.minutes ?? 300) * 60_000).toISOString(),
        time,
        scope: 'same',
        plan: 'Antigravity',
        source,
        recorded: Boolean(rec.recorded),
      }));
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean' },
      watch: { type: 'boolean' },
      json: { type: 'boolean' },
      details: { type: 'boolean' },
      'question-previews': { type: 'boolean' },
      'session-view': { type: 'boolean' },
      'stop-on-stdin-close': { type: 'boolean' },
      interval: { type: 'string', default: '30' },
      samples: { type: 'string' },
      hours: { type: 'string', default: '24' },
      home: { type: 'string' },
      agy: { type: 'string' },
    },
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const interval = numberInRange(values.interval, '--interval', 5, 3600);
  const samples = values.samples ? numberInRange(values.samples, '--samples', 1, 10000) : Infinity;
  const hours = numberInRange(values.hours, '--hours', 1, 168);
  if (values.home && !isAbsolute(values.home)) throw new Error('--home requiere una ruta absoluta.');
  if (values.agy && !isAbsolute(values.agy)) throw new Error('--agy requiere una ruta absoluta.');

  const agHome = values.home || process.env.ANTIGRAVITY_HOME || join(homedir(), '.gemini', 'antigravity');
  const agyExecutable = await findAgyExecutable(values.agy);
  const dataFolder = join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'state'), 'AIUsageIntelligence');
  const recordingsFolder = join(dataFolder, 'poc');
  const manualQuotaFile = join(recordingsFolder, 'antigravity-quota.jsonl');
  const pricingCachePath = join(dataFolder, 'pricing-cache.json');
  const cachedPricing = await readPricingCache(pricingCachePath);
  if (cachedPricing) applyExternalPricing(cachedPricing);
  void syncPricingCache(pricingCachePath).then(updated => { if (updated) applyExternalPricing(updated); });
  let nextPricingSyncAt = Date.now() + 24 * 60 * 60 * 1000;
  const salt = randomBytes(32);

  const workspace = { selected: null, dbCache: new Map() };
  const recordedHistory = await readSavedRecordings(recordingsFolder);
  const liveRecords = [];

  let watchOutput = null;
  if (values.watch) {
    await mkdir(recordingsFolder, { recursive: true, mode: 0o700 });
    watchOutput = join(recordingsFolder, 'antigravity-' + randomUUID() + '.jsonl');
  }

  const shutdown = new AbortController();
  let delay;
  let pendingRefresh = false;
  const abort = () => {
    shutdown.abort();
    delay?.abort();
  };
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);

  const input = values['stop-on-stdin-close'] ? createInterface({ input: process.stdin }) : null;
  input?.on('line', async line => {
    if (!values.watch) return;
    const session = /^session ([a-f0-9]{16})$/.exec(line)?.[1];
    if (session) {
      workspace.selected = session;
      pendingRefresh = true;
      delay?.abort();
      return;
    }
    if (line.startsWith('quota ')) {
      try {
        const payload = JSON.parse(line.slice(6));
        const avail = Number(payload.availablePercent);
        if (!Number.isFinite(avail) || avail < 0 || avail > 100) return;
        const pool = typeof payload.pool === 'string' && payload.pool.trim() ? payload.pool.trim().slice(0, 40) : 'gemini';
        const minutes = Number.isSafeInteger(payload.minutes) && payload.minutes > 0 ? payload.minutes : 300;
        const observedAt = new Date().toISOString();
        const usedPercent = Number((100 - avail).toFixed(2));

        const latest = new Map(latestWindowsFrom([...recordedHistory, ...liveRecords]).map(w => [`${w.pool}/${w.minutes}`, w]));
        const prev = latest.get(`${pool}/${minutes}`);
        const prevResetMs = prev?.resetsAt ? Date.parse(prev.resetsAt) : NaN;
        const reusePrevReset = Number.isFinite(prevResetMs) && prevResetMs > Date.now() && usedPercent >= (prev?.usedPercent ?? 0);
        const resetsAt = typeof payload.resetsAt === 'string' && Number.isFinite(Date.parse(payload.resetsAt))
          ? new Date(Date.parse(payload.resetsAt)).toISOString()
          : reusePrevReset
            ? prev.resetsAt
            : new Date(Date.now() + minutes * 60_000).toISOString();

        latest.set(`${pool}/${minutes}`, { pool, slot: minutes === 10080 ? 'secondary' : 'primary', minutes, usedPercent, resetsAt });
        const entry = buildManualSample(observedAt, [...latest.values()]);
        await mkdir(recordingsFolder, { recursive: true, mode: 0o700 });
        await appendFile(manualQuotaFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
        liveRecords.push({ time: Date.parse(observedAt), quota: entry.quota, recorded: true });
        if (liveRecords.length > 5000) liveRecords.shift();
        pendingRefresh = true;
        delay?.abort();
      } catch { /* Ignore invalid manual quota payload */ }
      return;
    }
    if (line === 'sample') {
      pendingRefresh = true;
      delay?.abort();
    }
  });
  input?.once('close', abort);

  try {
    for (let index = 0; index < (values.watch ? samples : 1) && !shutdown.signal.aborted; index++) {
      try {
        if (Date.now() >= nextPricingSyncAt) {
          nextPricingSyncAt = Date.now() + 24 * 60 * 60 * 1000;
          void syncPricingCache(pricingCachePath).then(updated => { if (updated) applyExternalPricing(updated); });
        }
        pendingRefresh = false;
        const requested = workspace.selected ?? null;

        // Read official `agy /usage` quota and local SQLite conversations in parallel
        const [agyResult, history] = await Promise.all([
          readAgyUsage(agyExecutable).catch(() => null),
          recentAntigravityHistory(
            agHome,
            salt,
            Boolean(values.details && values['question-previews']),
            workspace,
          ),
        ]);
        let quotaSample;
        if (agyResult && agyResult.windows.length > 0) {
          quotaSample = agyResult;
          liveRecords.push({ time: Date.parse(agyResult.observedAt), quota: agyResult, recorded: Boolean(watchOutput) });
          if (liveRecords.length > 5000) liveRecords.shift();
        } else {
          const fallbackWindows = latestWindowsFrom([...recordedHistory, ...liveRecords]);
          quotaSample = {
            source: fallbackWindows.length ? 'manual-settings' : 'none',
            observedAt: new Date().toISOString(),
            readMs: 0,
            plan: 'Antigravity',
            windows: fallbackWindows,
          };
        }

        const until = Date.now();
        const since = until - hours * 3_600_000;
        const quotaPoints = toQuotaPoints([...recordedHistory, ...liveRecords]);

        const details = values.details
          ? interactionSummary(history, since, until, quotaPoints, Boolean(values['session-view']), {
              buckets: AG_BUCKETS,
            })
          : undefined;
        if (details && values['session-view']) details.requestedSession = requested;

        const baseFrame = {
          type: 'sample',
          provider: 'antigravity',
          quota: quotaSample,
          accountComparable: true,
          historyCoverage: history.coverage,
          tokenRecords: requestSummary(history, since, until, 'antigravity'),
          reconciliation: [],
          intervalStartedAt: null,
          changes: [],
        };

        if (watchOutput && quotaSample.source === 'agy-cli') {
          await appendFile(watchOutput, JSON.stringify(baseFrame) + '\n', { mode: 0o600 });
        }

        const rendered = {
          ...baseFrame,
          ...(details ? { interactionDetails: details } : {}),
          analytics: analyticsSummary(history, until, 'antigravity', quotaPoints, { buckets: AG_BUCKETS }),
        };
        console.log(values.watch || values.json ? JSON.stringify(rendered) : JSON.stringify(rendered, null, 2));
      } catch (error) {
        if (!values.watch) throw error;
        console.log(JSON.stringify({ type: 'collection-error', provider: 'antigravity', observedAt: new Date().toISOString(), source: 'antigravity-poc' }));
        console.error(error.message);
      }

      if (values.watch && index + 1 < samples && !shutdown.signal.aborted && !pendingRefresh) {
        delay = new AbortController();
        await wait(interval * 1000, undefined, { signal: delay.signal }).catch(error => {
          if (error.name !== 'AbortError') throw error;
        });
        delay = undefined;
      }
    }
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    input?.removeListener('close', abort);
    input?.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
