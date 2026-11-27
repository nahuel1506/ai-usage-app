
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

export function antigravityRequestPool(req, turn) {
  const model = req.model ?? (turn?.models?.length === 1 ? turn.models[0] : '');
  return /gemini/i.test(model) ? 'gemini' : /claude|gpt/i.test(model) ? 'claude_gpt' : null;
}

function buildTurnIndex(history) {
  const { turns } = history;
  const pools = new Map();
  for (const req of history.requests?.values() ?? []) {
    const pool = antigravityRequestPool(req, turns.get(req.turn));
    pools.set(req.turn, pools.has(req.turn) && pools.get(req.turn) !== pool ? null : pool);
  }
  const list = [];
  for (const turn of turns.values()) {
    list.push({
      key: turn.key,
      pool: pools.get(turn.key),
      start: turn.started ?? turn.first,
      end: turn.ended ?? turn.last,
    });
  }
  list.sort((a, b) => a.start - b.start);
  return list;
}

const turnIndexCache = new WeakMap();

function getTurnIndex(history) {
  let index = turnIndexCache.get(history);
  if (!index) {
    index = buildTurnIndex(history);
    turnIndexCache.set(history, index);
  }
  return index;
}

function overlappingTurns(index, members, from, to, pool) {
  let count = 0;
  for (let i = 0; i < index.length; i++) {
    const item = index[i];
    if (item.start > to) break;
    if (item.end > from && !members.has(item.key) && (!pool || !item.pool || item.pool === pool)) count++;
  }
  return count;
}

function findNextStart(index, members, end, pool) {
  let low = 0;
  let high = index.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (index[mid].start < end) low = mid + 1;
    else high = mid;
  }
  for (let i = low; i < index.length; i++) {
    const item = index[i];
    if (!members.has(item.key) && (!pool || !item.pool || item.pool === pool)) return item.start;
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

function latestReading(samples) {
  const latest = samples.at(-1);
  if (!latest) return undefined;
  // The series places official account readings first at a given timestamp.
  return samples[lowerBound(samples, latest.time)];
}

function turnBounds(turn) {
  const start = turn.startedAt ? Date.parse(turn.startedAt) : turn.firstRequest;
  const end = turn.endedAt ? Math.max(Date.parse(turn.endedAt), turn.lastRequest) : turn.lastRequest;
  return { start, end };
}

function measureWindow(minutes, samples, turn, turnIndex, pool = null) {
  const members = turn.members ?? new Set([turn.reference]);
  const { start, end } = turnBounds(turn);
  const relevant = samples.slice(lowerBound(samples, start - BEFORE_MS), lowerBound(samples, end + AFTER_MS + 1));
  const before = latestReading(relevant.slice(0, lowerBound(relevant, start + 1)));
  const afterEnd = relevant.filter(row => row.time >= end);
  const nextStart = findNextStart(turnIndex, members, end, pool);
  const beforeNext = afterEnd.filter(row => row.time < nextStart);
  const after = latestReading(beforeNext) ?? afterEnd[0];
  const inside = relevant.filter(row => row.time >= start && row.time <= end);
  const left = before ?? inside[0];
  const right = after ?? latestReading(inside);
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
  const agyEndpoints = left.source === 'agy-cli' && right.source === 'agy-cli';
  const interval = relevant.filter(row => row.time >= left.time && row.time <= right.time &&
    (!agyEndpoints || row.source === 'agy-cli'));
  let fluctuated = false;
  if (right.usedPercent < left.usedPercent || interval.some(row => {
    const nextReset = Date.parse(row.resetsAt);
    const decreased = row.usedPercent < (usedBySource.get(row.source) ?? -Infinity);
    fluctuated ||= decreased;
    const differs = !Number.isFinite(reset) || !Number.isFinite(nextReset) ||
      Math.abs(nextReset - reset) > 2000 || nextReset <= right.time ||
      (left.plan && row.plan && left.plan !== row.plan) || (decreased && !agyEndpoints);
    usedBySource.set(row.source, row.usedPercent);
    return differs;
  })) return { ...result, status: 'discontinuity' };

  const deltaPp = Number((right.usedPercent - left.usedPercent).toFixed(6));
  const otherTurns = overlappingTurns(turnIndex, members, left.time, right.time, pool);
  const status = !result.hasStart || !result.hasEnd ? 'partial' : otherTurns ? 'shared' : 'observed';
  return { ...result, status, deltaPp, otherTurns, plan: right.plan ?? left.plan, ...(fluctuated ? { fluctuated: true } : {}) };
}

export function interactionQuota(series, turn, history) {
  const turnIndex = getTurnIndex(history);
  return [...series].map(([key, value]) =>
    Array.isArray(value)
      ? measureWindow(key, value, turn, turnIndex)
      : turn.pool === value.pool ? measureWindow(value.minutes, value.samples, turn, turnIndex, value.pool) : null).filter(Boolean);
}

function quotaPeriods(samples, minutes) {
  const duration = minutes * 60_000;
  const readings = samples.flatMap(sample => {
    const reset = Date.parse(sample.resetsAt);
    return sample.time >= reset - duration - 2000 && sample.time < reset ? [{ sample, reset }] : [];
  });
  const resets = [...new Set(readings
    .filter(({ sample }) => minutes !== 300 || sample.usedPercent > 0)
    .map(({ reset }) => reset))].sort((a, b) => a - b);
  const periods = [];
  for (const reset of resets) {
    // The provider can report the same reset a second or two apart.
    if (reset - (periods.at(-1)?.time ?? -Infinity) > 2000)
      periods.push({ time: reset, start: reset - duration, end: reset, samples: [] });
  }
  for (const { sample, reset } of readings) {
    const period = periods[lowerBound(periods, reset - 2000)];
    if (period && period.time <= reset + 2000 && sample.time >= period.start && sample.time < period.time)
      period.samples.push(sample);
  }
  const confirmed = periods.filter(period => period.samples.some(sample => sample.usedPercent > 0) ||
    (minutes !== 300 && (period.samples.at(-1)?.time - period.samples[0]?.time) > 2000));
  for (let index = 1; index < confirmed.length; index++) {
    const previous = confirmed[index - 1];
    const next = confirmed[index];
    if (previous.end <= next.start) continue;
    // When the provider changes the schedule early, use the new nominal start
    // unless we still have readings of the older window after that time.
    const lastPrevious = previous.samples.at(-1).time;
    const firstNext = next.samples[0].time;
    next.start = Math.max(next.start, Math.min(lastPrevious + 1, firstNext));
    previous.end = Math.min(previous.end, next.start);
  }
  return confirmed;
}

function periodTotal(minutes, period, turns, turnIndex, from = period.start, to = period.end) {
  const active = turns.filter(turn => turn.end >= from && turn.start < to);
  const samples = period.samples.slice(lowerBound(period.samples, from), lowerBound(period.samples, to));
  const intervals = active.flatMap(turn => {
    const impact = measureWindow(minutes, samples, turn, turnIndex, turn.pool === "codex" ? null : turn.pool);
    if (!Number.isFinite(impact.deltaPp) || impact.otherTurns) return [];
    return [{
      start: Date.parse(impact.before.at), end: Date.parse(impact.after.at),
      delta: impact.deltaPp, partial: impact.status === 'partial',
    }];
  }).sort((a, b) => a.start - b.start);

  // A boundary reading can be shared. A span of consumption cannot.
  const overlapping = new Set();
  let furthest = null;
  for (const interval of intervals) {
    if (furthest && interval.start < furthest.end) {
      overlapping.add(furthest);
      overlapping.add(interval);
    }
    if (!furthest || interval.end > furthest.end) furthest = interval;
  }
  const measured = intervals.filter(interval => !overlapping.has(interval));
  return {
    activities: active.length, measured: measured.length,
    partial: measured.filter(interval => interval.partial).length,
    deltaPp: measured.length ? Number(measured.reduce((sum, interval) => sum + interval.delta, 0).toFixed(6)) : null,
  };
}

export function sessionQuotaHistory(series, quotaTurns, history, until) {
  const turns = quotaTurns.map(turn => ({ ...turn, ...turnBounds(turn) }));
  const turnIndex = getTurnIndex(history);
  const pools = new Map();
  for (const [key, value] of series) {
    const { pool = 'codex', minutes, samples } = Array.isArray(value) ? { minutes: key, samples: value } : value;
    if (!pools.has(pool)) pools.set(pool, new Map());
    pools.get(pool).set(minutes, quotaPeriods(samples, minutes));
  }

  const weeks = [];
  const blocks = [];
  const dates = (pool, period) => ({
    pool, startsAt: new Date(period.start).toISOString(), endsAt: new Date(period.end).toISOString(),
    resetsAt: new Date(period.time).toISOString(), active: period.start <= until && period.end > until,
  });
  for (const [pool, windows] of pools) {
    const eligibleTurns = pool === "codex" ? turns : turns.filter(turn => turn.pool === pool);
    const weekly = windows.get(10080) ?? [];
    for (const period of weekly) {
      const total = periodTotal(10080, period, eligibleTurns, turnIndex);
      const range = dates(pool, period);
      if (total.activities || range.active) weeks.push({ ...range, ...total });
    }
    for (const period of windows.get(300) ?? []) {
      const short = periodTotal(300, period, eligibleTurns, turnIndex);
      if (!short.activities) continue;
      const weeklyParts = weekly.filter(week => week.start < period.end && week.end > period.start).map(week => ({
        resetsAt: new Date(week.time).toISOString(),
        ...periodTotal(10080, week, eligibleTurns, turnIndex, Math.max(week.start, period.start), Math.min(week.end, period.end)),
      }));
      blocks.push({ ...dates(pool, period), short, weekly: weeklyParts });
    }
  }
  weeks.sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  blocks.sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  return { weeks, blocks };
}
