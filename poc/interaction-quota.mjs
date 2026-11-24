
const WINDOWS = [300, 10080];
const BEFORE_MS = 180_000;
const AFTER_MS = 90_000;

function point(sample) {
  return {
    at: new Date(sample.time).toISOString(),
    usedPercent: sample.usedPercent,
    source: sample.source,
    ...(sample.recorded ? { recorded: true } : {}),
  };
}

export function liveQuotaPoints(captures, accountId) {
  if (!accountId) return [];
  return captures
    .filter(capture => capture.accountId === accountId)
    .flatMap(({ sample }) => sample.windows.map(window => ({
      ...window, time: Date.parse(sample.observedAt), scope: 'same',
      plan: sample.plan, source: 'app-server',
    })));
}

export function quotaObservations(history, live, until, options = {}) {
  const snapshots = history.snapshots ?? [];
  if (Array.isArray(options.buckets)) {
    const series = new Map(options.buckets.map(b => [`${b.pool}/${b.minutes}`, { pool: b.pool, minutes: b.minutes, samples: [] }]));
    for (const sample of [...snapshots, ...live]) {
      if (sample.scope !== 'same' || !Number.isFinite(sample.time) || sample.time > until) continue;
      const entry = series.get(`${sample.pool}/${sample.minutes}`);
      if (entry) entry.samples.push(sample);
    }
    for (const entry of series.values()) {
      entry.samples.sort((left, right) => left.time - right.time ||
        Number(right.source === 'app-server' || right.source === 'agy-cli') - Number(left.source === 'app-server' || left.source === 'agy-cli'));
      const seen = new Set();
      entry.samples = entry.samples.filter(sample => {
        const key = JSON.stringify([sample.time, sample.resetsAt, sample.usedPercent, sample.plan]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    return series;
  }

  const targetPool = options.pool === undefined ? 'codex' : options.pool;
  const targetWindows = options.windows ?? WINDOWS;
  const series = new Map(targetWindows.map(minutes => [minutes, []]));
  for (const sample of [...snapshots, ...live]) {
    if (sample.scope !== 'same' || (targetPool !== null && sample.pool !== targetPool) || !series.has(sample.minutes)
        || !Number.isFinite(sample.time) || sample.time > until) continue;
    series.get(sample.minutes).push(sample);
  }
  for (const [minutes, samples] of series) {
    samples.sort((left, right) => left.time - right.time ||
      Number(right.source === 'app-server') - Number(left.source === 'app-server'));
    // Equal timestamps and equal readings are duplicates; differing readings remain visible to the checks.
    const seen = new Set();
    series.set(minutes, samples.filter(sample => {
      const key = JSON.stringify([sample.time, sample.resetsAt, sample.usedPercent, sample.plan]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }));
  }
  return series;
}

function buildTurnIndex(turns) {
  const list = [];
  for (const turn of turns.values()) {
    list.push({
      key: turn.key,
      start: turn.started ?? turn.first,
      end: turn.ended ?? turn.last,
    });
  }
  list.sort((a, b) => a.start - b.start);
  return list;
}

const turnIndexCache = new WeakMap();

function getTurnIndex(turns) {
  let index = turnIndexCache.get(turns);
  if (!index) {
    index = buildTurnIndex(turns);
    turnIndexCache.set(turns, index);
  }
  return index;
}

function overlappingTurns(index, members, from, to) {
  let count = 0;
  for (let i = 0; i < index.length; i++) {
    const item = index[i];
    if (item.start > to) break;
    if (item.end > from && !members.has(item.key)) count++;
  }
  return count;
}

function findNextStart(index, members, end) {
  let low = 0;
  let high = index.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (index[mid].start < end) low = mid + 1;
    else high = mid;
  }
  for (let i = low; i < index.length; i++) {
    if (!members.has(index[i].key)) return index[i].start;
  }
  return Infinity;
}

function lowerBound(samples, time) {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (samples[middle].time < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function measureWindow(minutes, samples, turn, turnIndex, pool = null) {
  const members = turn.members ?? new Set([turn.reference]);
  const start = turn.startedAt ? Date.parse(turn.startedAt) : turn.firstRequest;
  const end = turn.endedAt ? Date.parse(turn.endedAt) : turn.lastRequest;
  const relevant = samples.slice(lowerBound(samples, start - BEFORE_MS), lowerBound(samples, end + AFTER_MS + 1));
  const before = relevant.findLast(row => row.time <= start);
  const afterEnd = relevant.filter(row => row.time >= end);
  const nextStart = findNextStart(turnIndex, members, end);
  const beforeNext = afterEnd.filter(row => row.time < nextStart);
  const eligible = beforeNext.length ? beforeNext : afterEnd;
  const after = eligible.findLast(row => row.source === 'app-server' || row.source === 'agy-cli') ?? eligible[0];
  const inside = relevant.filter(row => row.time >= start && row.time <= end);
  const left = before ?? inside[0];
  const right = after ?? inside.at(-1);
  const result = {
    ...(pool ? { pool } : {}),
    minutes, status: 'unavailable', deltaPp: null, before: left ? point(left) : null,
    after: right && right.time !== left?.time ? point(right) : null,
    hasStart: Boolean(turn.startedAt && before), hasEnd: Boolean(turn.endedAt && after),
    otherTurns: 0,
  };
  if (!left || !right || left.time >= right.time) return result;

  const reset = Date.parse(left.resetsAt);
  const usedBySource = new Map();
  const interval = relevant.filter(row => row.time >= left.time && row.time <= right.time);
  if (right.usedPercent < left.usedPercent || interval.some(row => {
    const nextReset = Date.parse(row.resetsAt);
    const differs = !Number.isFinite(reset) || !Number.isFinite(nextReset) ||
      Math.abs(nextReset - reset) > 2000 || nextReset <= right.time ||
      (left.plan && row.plan && left.plan !== row.plan) || row.usedPercent < (usedBySource.get(row.source) ?? -Infinity);
    usedBySource.set(row.source, row.usedPercent);
    return differs;
  })) return { ...result, status: 'discontinuity' };

  const deltaPp = Number((right.usedPercent - left.usedPercent).toFixed(6));
  const otherTurns = overlappingTurns(turnIndex, members, left.time, right.time);
  const status = !result.hasStart || !result.hasEnd ? 'partial' : otherTurns ? 'shared' : 'observed';
  return { ...result, status, deltaPp, otherTurns };
}

export function interactionQuota(series, turn, history) {
  const turnIndex = getTurnIndex(history.turns);
  return [...series].map(([key, value]) =>
    Array.isArray(value)
      ? measureWindow(key, value, turn, turnIndex)
      : measureWindow(value.minutes, value.samples, turn, turnIndex, value.pool));
}
