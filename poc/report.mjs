import { interactionQuota, quotaObservations } from './interaction-quota.mjs';
import { aggregateCosts, priceRequest, pricingCatalogStatus } from './pricing.mjs';

function bucket(row) {
  return row.pool && row.minutes ? row.pool + '/' + row.minutes : null;
}

function sameWindowEnd(first, second, observedAt) {
  const left = Date.parse(first);
  const right = Date.parse(second);
  return Math.min(left, right) > observedAt && Math.abs(left - right) <= 2000;
}

export function reconcile(sample, history) {
  return sample.windows.map(live => {
    const comparable = history.snapshots
      .filter(row => bucket(live) && bucket(row) === bucket(live) && row.scope === 'same'
        && sameWindowEnd(row.resetsAt, live.resetsAt, Date.parse(sample.observedAt)) && row.time <= Date.parse(sample.observedAt))
      .sort((a, b) => b.time - a.time);
    const log = comparable[0];
    return {
      pool: live.pool, minutes: live.minutes,
      historical: log ? {
        source: 'codex-rollout', observedAt: new Date(log.time).toISOString(),
        usedPercent: log.usedPercent, resetsAt: log.resetsAt,
        differencePp: live.usedPercent - log.usedPercent,
      } : null,
    };
  });
}

export function changesBetween(previous, current, history) {
  const changes = [];
  if (!current.accountId || current.accountId !== previous?.accountId
      || previous.sample.plan !== current.sample.plan) return changes;
  const from = Date.parse(previous.sample.observedAt);
  const to = Date.parse(current.sample.observedAt);
  if (to <= from) return changes;
  const candidates = [...history.turns.values()].filter(turn => {
    const observedWithin = [turn.first, turn.last, turn.started, turn.ended].some(time => time > from && time <= to);
    const activeAcross = turn.started !== null && turn.started <= to && (turn.ended ?? Infinity) > from;
    return observedWithin || activeAcross;
  });
  for (const live of current.sample.windows) {
    const key = bucket(live);
    if (!key) continue;
    const rows = previous.sample.windows.filter(row => bucket(row) === key);
    if (rows.length !== 1 || current.sample.windows.filter(row => bucket(row) === key).length !== 1) continue;
    const old = rows[0];
    const detail = { pool: live.pool, minutes: live.minutes };
    if (!old.resetsAt || !live.resetsAt) {
      changes.push({ ...detail, status: 'window-unverified' });
    } else if (!sameWindowEnd(old.resetsAt, live.resetsAt, to) || live.usedPercent < old.usedPercent) {
      changes.push({ ...detail, status: 'discontinuity' });
    } else if (old.usedPercent !== live.usedPercent) {
      changes.push({
        ...detail, status: 'observed-increase', deltaPp: live.usedPercent - old.usedPercent,
        candidateTurns: candidates.map(turn => ({ reference: turn.key, account: turn.scope, pool: 'unverified' })),
        attribution: 'unassigned',
      });
    }
  }
  return changes;
}

function summarizeRequests(requests) {
  const observedCounts = {};
  const fieldCoverage = {};
  for (const { usage } of requests) {
    for (const [field, value] of Object.entries(usage)) {
      observedCounts[field] = (observedCounts[field] ?? 0) + value;
      fieldCoverage[field] = (fieldCoverage[field] ?? 0) + 1;
    }
  }
  return { observedRequests: requests.length, observedCounts, fieldCoverage };
}

export function requestSummary(history, since, until, provider = 'codex') {
  const requests = [...history.requests.values()].filter(row => row.time > since && row.time <= until);
  const sameRequests = requests.filter(row => row.scope === 'same');
  const pricedSame = sameRequests.map(req => {
    const turn = history.turns.get(req.turn);
    const model = req.model ?? (turn?.models?.length === 1 ? turn.models[0] : null);
    return priceRequest(req.usage, model, { provider, at: req.time });
  });
  return {
    since: new Date(since).toISOString(), until: new Date(until).toISOString(),
    sameAccount: { ...summarizeRequests(sameRequests), apiCost: aggregateCosts(pricedSame) },
    unverifiedAccount: summarizeRequests(requests.filter(row => row.scope !== 'same')),
  };
}

function localDayKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function localDayLabel(ms) {
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function localHourKey(ms) {
  const d = new Date(ms);
  return `${localDayKey(ms)}T${String(d.getHours()).padStart(2, '0')}`;
}

function localHourLabel(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}h`;
}

function resolveReqEffort(req, turn) {
  return req.effort ?? (turn?.efforts?.length === 1 ? turn.efforts[0] : null) ?? 'unspecified';
}

function resolveReqModel(req, turn) {
  return req.model ?? (turn?.models?.length === 1 ? turn.models[0] : null) ?? 'Sin identificar';
}

function pickQuotaDelta(quotaList, minutes, provider, modelName, observedOnly = false) {
  if (!Array.isArray(quotaList)) return null;
  const preferredPool = provider === 'antigravity'
    ? (/claude|gpt/i.test(modelName || '') ? 'claude_gpt' : 'gemini')
    : null;
  const match = quotaList.find(q =>
    q.minutes === minutes && (preferredPool === null || q.pool === preferredPool));
  if (!match || typeof match.deltaPp !== 'number' || !Number.isFinite(match.deltaPp)) return null;
  if (observedOnly ? match.status !== 'observed' : (match.status !== 'observed' && match.status !== 'shared')) return null;
  return match.deltaPp;
}

function buildModelEffortComparison(requests, history, provider, turnQuotaMap) {
  const groups = new Map();
  const byModel = new Map();

  for (const req of requests) {
    const turn = history.turns.get(req.turn);
    const model = resolveReqModel(req, turn);
    const effort = resolveReqEffort(req, turn);
    const priced = priceRequest(req.usage, model === 'Sin identificar' ? null : model, { provider, at: req.time });
    const usd = priced.available ? priced.usd : 0;
    const saved = priced.available ? (priced.cacheSavingsUsd ?? 0) : 0;
    const freshIn = priced.available ? priced.freshInputTokens : (req.usage.input_tokens ?? 0);
    const cacheRead = req.usage.cached_input_tokens ?? 0;
    const outTok = req.usage.output_tokens ?? 0;
    const reasonTok = req.usage.reasoning_output_tokens ?? 0;
    const totalTok = (req.usage.input_tokens ?? 0)
      + (provider === 'antigravity' ? cacheRead : 0)
      + outTok;

    const key = `${model}||${effort}`;
    let row = groups.get(key);
    if (!row) {
      row = {
        model, effort, requests: 0, turns: new Set(), tokens: 0, freshIn: 0, cacheRead: 0,
        outTok: 0, reasonTok: 0, usd: 0, saved: 0, pricedRequests: 0,
        drop5hSum: 0, drop5hTurns: new Set(), dropWeekSum: 0, dropWeekTurns: new Set(),
      };
      groups.set(key, row);
    }
    row.requests++;
    row.turns.add(req.turn);
    row.tokens += totalTok;
    row.freshIn += freshIn;
    row.cacheRead += cacheRead;
    row.outTok += outTok;
    row.reasonTok += reasonTok;
    if (priced.available) {
      row.usd += usd;
      row.saved += saved;
      row.pricedRequests++;
    }
    const q = turnQuotaMap?.get(req.turn);
    if (q) {
      if (!row.drop5hTurns.has(req.turn)) {
        const d5 = pickQuotaDelta(q, 300, provider, model);
        if (d5 !== null) { row.drop5hSum += d5; row.drop5hTurns.add(req.turn); }
      }
      if (!row.dropWeekTurns.has(req.turn)) {
        const dw = pickQuotaDelta(q, 10080, provider, model);
        if (dw !== null) { row.dropWeekSum += dw; row.dropWeekTurns.add(req.turn); }
      }
    }

    let mAgg = byModel.get(model);
    if (!mAgg) {
      mAgg = {
        model, requests: 0, turns: new Set(), tokens: 0, freshIn: 0, cacheRead: 0,
        outTok: 0, reasonTok: 0, usd: 0, saved: 0, pricedRequests: 0,
        drop5hSum: 0, drop5hTurns: new Set(), dropWeekSum: 0, dropWeekTurns: new Set(),
      };
      byModel.set(model, mAgg);
    }
    mAgg.requests++;
    mAgg.turns.add(req.turn);
    mAgg.tokens += totalTok;
    mAgg.freshIn += freshIn;
    mAgg.cacheRead += cacheRead;
    mAgg.outTok += outTok;
    mAgg.reasonTok += reasonTok;
    if (priced.available) {
      mAgg.usd += usd;
      mAgg.saved += saved;
      mAgg.pricedRequests++;
    }
    if (q) {
      if (!mAgg.drop5hTurns.has(req.turn)) {
        const d5 = pickQuotaDelta(q, 300, provider, model);
        if (d5 !== null) { mAgg.drop5hSum += d5; mAgg.drop5hTurns.add(req.turn); }
      }
      if (!mAgg.dropWeekTurns.has(req.turn)) {
        const dw = pickQuotaDelta(q, 10080, provider, model);
        if (dw !== null) { mAgg.dropWeekSum += dw; mAgg.dropWeekTurns.add(req.turn); }
      }
    }
  }

  const totalUsd = [...byModel.values()].reduce((sum, m) => sum + (m.pricedRequests > 0 ? m.usd : 0), 0);

  function finalize(item, parentUsd) {
    const turnCount = item.turns.size;
    const inputPool = item.freshIn + item.cacheRead;
    const usdVal = item.pricedRequests > 0 ? Number(item.usd.toFixed(4)) : null;
    return {
      model: item.model,
      ...(item.effort !== undefined ? { effort: item.effort } : {}),
      requests: item.requests,
      turns: turnCount,
      avgStepsPerTurn: turnCount > 0 ? Number((item.requests / turnCount).toFixed(1)) : null,
      tokens: item.tokens,
      usd: usdVal,
      cacheSavingsUsd: item.pricedRequests > 0 ? Number(item.saved.toFixed(4)) : null,
      sharePct: parentUsd > 0 && usdVal !== null ? Number(((item.usd / parentUsd) * 100).toFixed(1)) : null,
      avgCostPerTurnUsd: turnCount > 0 && usdVal !== null ? Number((item.usd / turnCount).toFixed(4)) : null,
      cacheHitRatePct: inputPool > 0 ? Number(((item.cacheRead / inputPool) * 100).toFixed(1)) : null,
      reasoningPct: item.outTok > 0 ? Number(((item.reasonTok / item.outTok) * 100).toFixed(1)) : null,
      avg5hDropPp: item.drop5hTurns.size > 0 ? Number((item.drop5hSum / item.drop5hTurns.size).toFixed(3)) : null,
      measured5hTurns: item.drop5hTurns.size,
      avgWeekDropPp: item.dropWeekTurns.size > 0 ? Number((item.dropWeekSum / item.dropWeekTurns.size).toFixed(3)) : null,
      measuredWeekTurns: item.dropWeekTurns.size,
    };
  }

  const byModelEffort = [...groups.values()]
    .sort((a, b) => b.usd - a.usd || b.requests - a.requests)
    .map(g => finalize(g, totalUsd));

  const models = [...byModel.values()]
    .sort((a, b) => b.usd - a.usd || b.requests - a.requests)
    .slice(0, 10)
    .map(m => {
      const mTotalUsd = m.pricedRequests > 0 ? m.usd : 0;
      const efforts = [...groups.values()]
        .filter(g => g.model === m.model)
        .sort((a, b) => b.usd - a.usd || b.requests - a.requests)
        .map(g => finalize(g, mTotalUsd));
      return { ...finalize(m, totalUsd), efforts };
    });

  return { models, byModelEffort };
}

function contextBucketIndex(maxCtx) {
  if (maxCtx < 50_000) return 0;
  if (maxCtx < 150_000) return 1;
  if (maxCtx < 250_000) return 2;
  return 3;
}

const CONTEXT_BUCKET_DEFS = [
  { key: 'lt50k', label: '< 50 k', subtitle: 'Chat nuevo' },
  { key: '50k_150k', label: '50k – 150k', subtitle: 'Chat medio' },
  { key: '150k_250k', label: '150k – 250k', subtitle: 'Chat largo' },
  { key: 'gt250k', label: '> 250 k', subtitle: 'Muy largo' },
];

const EFFORT_SORT_ORDER = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6, ultra: 7, unspecified: 99 };

function buildPeriodAnalytics(sameRequests, history, since, until, provider, bucketMode, projectNames, sessionProjects, sessionTitles, turnQuotaMap) {
  const filtered = sameRequests.filter(req => req.time > since && req.time <= until);
  const turnIds = new Set();
  const sessionIds = new Set();
  const pricedList = [];
  const byProject = new Map();
  const seriesMap = new Map();
  const sessionDrops5h = new Map();
  const sessionDropsWeek = new Map();
  const turnDrops5h = new Map();
  const turnDropsWeek = new Map();
  const turnAggs = new Map();
  const chatAggs = new Map();

  // Pre-seed timeline buckets so daily charts have contiguous slots
  if (bucketMode === 'hour') {
    const endHour = Math.floor(until / 3_600_000) * 3_600_000;
    for (let i = 23; i >= 0; i--) {
      const ts = endHour - i * 3_600_000;
      const key = localHourKey(ts);
      seriesMap.set(key, { key, label: localHourLabel(ts), usd: 0, requests: 0, tokens: 0 });
    }
  } else {
    const days = bucketMode === '7d' ? 7 : 30;
    const today = new Date(until);
    today.setHours(12, 0, 0, 0);
    for (let i = days - 1; i >= 0; i--) {
      const ts = today.getTime() - i * 86_400_000;
      const key = localDayKey(ts);
      seriesMap.set(key, { key, label: localDayLabel(ts), usd: 0, requests: 0, tokens: 0 });
    }
  }

  for (const req of filtered) {
    turnIds.add(req.turn);
    const turn = history.turns.get(req.turn);
    const sessionRef = turn?.session || null;
    if (sessionRef) sessionIds.add(sessionRef);
    const model = resolveReqModel(req, turn);
    const effort = resolveReqEffort(req, turn);
    const priced = priceRequest(req.usage, model === 'Sin identificar' ? null : model, { provider, at: req.time });
    pricedList.push(priced);

    const usd = priced.available ? priced.usd : 0;
    const ctxTokens = priced.available
      ? priced.contextTokens
      : (req.usage.input_tokens ?? 0) + (provider === 'antigravity' ? (req.usage.cached_input_tokens ?? 0) : 0);
    const totalTok = (req.usage.input_tokens ?? 0)
      + (provider === 'antigravity' ? (req.usage.cached_input_tokens ?? 0) : 0)
      + (req.usage.output_tokens ?? 0);

    const projRef = sessionRef ? sessionProjects.get(sessionRef) : null;
    const projName = (projRef && projectNames.get(projRef)) || 'Sin proyecto';

    // Per-turn aggregation (for Top Prompts, Context Buckets, Effort Comparison)
    let tAgg = turnAggs.get(req.turn);
    if (!tAgg) {
      const firstMsg = [...(turn?.messages?.values() ?? [])].sort((a, b) => a.time - b.time)[0];
      tAgg = {
        reference: req.turn,
        session: sessionRef,
        time: firstMsg?.time ?? turn?.started ?? req.time,
        preview: firstMsg?.preview || null,
        project: projName,
        model,
        effort,
        steps: 0,
        usd: 0,
        pricedSteps: 0,
        maxContextTokens: 0,
        drop5hPp: null,
        dropWeekPp: null,
      };
      turnAggs.set(req.turn, tAgg);
    }
    tAgg.steps++;
    if (priced.available) {
      tAgg.usd += usd;
      tAgg.pricedSteps++;
    }
    if (ctxTokens > tAgg.maxContextTokens) tAgg.maxContextTokens = ctxTokens;

    // Per-chat aggregation (for Heavy Chats)
    if (sessionRef) {
      let cAgg = chatAggs.get(sessionRef);
      if (!cAgg) {
        cAgg = {
          reference: sessionRef,
          title: sessionTitles.get(sessionRef) || 'Chat local',
          project: projName,
          turns: new Set(),
          steps: 0,
          usd: 0,
          maxContextTokens: 0,
          drop5hSum: 0,
        };
        chatAggs.set(sessionRef, cAgg);
      }
      cAgg.turns.add(req.turn);
      cAgg.steps++;
      cAgg.usd += usd;
      if (ctxTokens > cAgg.maxContextTokens) cAgg.maxContextTokens = ctxTokens;
    }

    // Track observed quota drops per turn & per session
    const q = turnQuotaMap?.get(req.turn);
    if (q) {
      if (!turnDrops5h.has(req.turn)) {
        const d5 = pickQuotaDelta(q, 300, provider, model);
        if (d5 !== null) {
          turnDrops5h.set(req.turn, d5);
          tAgg.drop5hPp = d5;
          if (sessionRef) {
            sessionDrops5h.set(sessionRef, (sessionDrops5h.get(sessionRef) ?? 0) + d5);
            if (chatAggs.has(sessionRef)) chatAggs.get(sessionRef).drop5hSum += d5;
          }
        }
      }
      if (!turnDropsWeek.has(req.turn)) {
        const dw = pickQuotaDelta(q, 10080, provider, model);
        if (dw !== null) {
          turnDropsWeek.set(req.turn, dw);
          tAgg.dropWeekPp = dw;
          if (sessionRef) sessionDropsWeek.set(sessionRef, (sessionDropsWeek.get(sessionRef) ?? 0) + dw);
        }
      }
    }

    // Project breakdown
    const pRow = byProject.get(projName) ?? { project: projName, requests: 0, tokens: 0, usd: 0 };
    pRow.requests++;
    pRow.tokens += totalTok;
    pRow.usd += usd;
    byProject.set(projName, pRow);

    // Timeline bucket
    const bKey = bucketMode === 'hour' ? localHourKey(req.time) : localDayKey(req.time);
    const bucket = seriesMap.get(bKey);
    if (bucket) {
      bucket.usd += usd;
      bucket.requests++;
      bucket.tokens += totalTok;
    }
  }

  const summary = summarizeRequests(filtered);
  const apiCost = aggregateCosts(pricedList);
  const totalUsd = apiCost.usd ?? 0;
  const outTotal = summary.observedCounts.output_tokens ?? 0;
  const reasonTotal = summary.observedCounts.reasoning_output_tokens ?? 0;
  const reasoningPct = outTotal > 0 ? Number(((reasonTotal / outTotal) * 100).toFixed(1)) : null;
  const turnCount = turnIds.size;
  const sessionCount = sessionIds.size;
  const avgCostPerTurnUsd = turnCount > 0 && apiCost.usd !== null
    ? Number((apiCost.usd / turnCount).toFixed(4)) : null;

  const { models, byModelEffort } = buildModelEffortComparison(filtered, history, provider, turnQuotaMap);

  // 1. Top 5 costliest prompts in this period
  const topPrompts = [...turnAggs.values()]
    .sort((a, b) => b.usd - a.usd || b.steps - a.steps)
    .slice(0, 5)
    .map(t => ({
      reference: t.reference,
      session: t.session,
      at: new Date(t.time).toISOString(),
      preview: t.preview || 'Prompt sin vista previa',
      project: t.project,
      model: t.model,
      effort: t.effort,
      steps: t.steps,
      maxContextTokens: t.maxContextTokens,
      usd: t.pricedSteps > 0 ? Number(t.usd.toFixed(4)) : null,
      drop5hPp: t.drop5hPp,
      dropWeekPp: t.dropWeekPp,
    }));

  // 2. Context-size impact buckets (<50k, 50-150k, 150-250k, >250k)
  const rawBuckets = CONTEXT_BUCKET_DEFS.map(def => ({
    ...def, prompts: 0, pricedPrompts: 0, usdSum: 0, stepsSum: 0, drop5hSum: 0, measured5h: 0,
  }));
  for (const t of turnAggs.values()) {
    const b = rawBuckets[contextBucketIndex(t.maxContextTokens)];
    b.prompts++;
    b.stepsSum += t.steps;
    if (t.pricedSteps > 0) {
      b.pricedPrompts++;
      b.usdSum += t.usd;
    }
    if (t.drop5hPp !== null) {
      b.measured5h++;
      b.drop5hSum += t.drop5hPp;
    }
  }
  const baseBucket = rawBuckets.find(b => b.pricedPrompts > 0 && b.usdSum > 0);
  const baseAvgUsd = baseBucket ? baseBucket.usdSum / baseBucket.pricedPrompts : null;
  const contextBuckets = rawBuckets.map(b => {
    const avgUsd = b.pricedPrompts > 0 ? b.usdSum / b.pricedPrompts : null;
    return {
      key: b.key,
      label: b.label,
      subtitle: b.subtitle,
      prompts: b.prompts,
      avgCostUsd: avgUsd !== null ? Number(avgUsd.toFixed(4)) : null,
      avgSteps: b.prompts > 0 ? Number((b.stepsSum / b.prompts).toFixed(1)) : null,
      avg5hDropPp: b.measured5h > 0 ? Number((b.drop5hSum / b.measured5h).toFixed(3)) : null,
      measured5h: b.measured5h,
      multiplier: avgUsd !== null && baseAvgUsd && baseAvgUsd > 0 ? Number((avgUsd / baseAvgUsd).toFixed(1)) : null,
    };
  });

  // 3. Direct Effort Comparison (Low vs Medium vs High vs XHigh)
  const effortMap = new Map();
  for (const t of turnAggs.values()) {
    const e = t.effort || 'unspecified';
    let row = effortMap.get(e);
    if (!row) {
      row = { effort: e, prompts: 0, pricedPrompts: 0, steps: 0, usdSum: 0, drop5hSum: 0, measured5h: 0 };
      effortMap.set(e, row);
    }
    row.prompts++;
    row.steps += t.steps;
    if (t.pricedSteps > 0) { row.pricedPrompts++; row.usdSum += t.usd; }
    if (t.drop5hPp !== null) { row.measured5h++; row.drop5hSum += t.drop5hPp; }
  }
  const effortRows = [...effortMap.values()].sort((a, b) =>
    (EFFORT_SORT_ORDER[a.effort] ?? 50) - (EFFORT_SORT_ORDER[b.effort] ?? 50));
  const lowestEffortBase = effortRows.find(r => r.effort !== 'unspecified' && r.pricedPrompts > 0 && r.usdSum > 0)
    ?? effortRows.find(r => r.pricedPrompts > 0 && r.usdSum > 0);
  const effortBaseAvg = lowestEffortBase ? lowestEffortBase.usdSum / lowestEffortBase.pricedPrompts : null;
  const byEffort = effortRows.map(r => {
    const avgUsd = r.pricedPrompts > 0 ? r.usdSum / r.pricedPrompts : null;
    return {
      effort: r.effort,
      prompts: r.prompts,
      steps: r.steps,
      avgStepsPerPrompt: r.prompts > 0 ? Number((r.steps / r.prompts).toFixed(1)) : null,
      usd: r.pricedPrompts > 0 ? Number(r.usdSum.toFixed(4)) : null,
      avgCostPerPromptUsd: avgUsd !== null ? Number(avgUsd.toFixed(4)) : null,
      avg5hDropPp: r.measured5h > 0 ? Number((r.drop5hSum / r.measured5h).toFixed(3)) : null,
      measured5h: r.measured5h,
      multiplier: avgUsd !== null && effortBaseAvg && effortBaseAvg > 0 ? Number((avgUsd / effortBaseAvg).toFixed(1)) : null,
    };
  });

  // 4. Heaviest Chats ranking
  const topChats = [...chatAggs.values()]
    .sort((a, b) => b.usd - a.usd || b.steps - a.steps)
    .slice(0, 6)
    .map(c => ({
      reference: c.reference,
      title: c.title,
      project: c.project,
      prompts: c.turns.size,
      steps: c.steps,
      usd: Number(c.usd.toFixed(4)),
      sharePct: totalUsd > 0 ? Number(((c.usd / totalUsd) * 100).toFixed(1)) : null,
      maxContextTokens: c.maxContextTokens,
      drop5hPp: c.drop5hSum > 0 ? Number(c.drop5hSum.toFixed(2)) : null,
    }));

  const projects = [...byProject.values()]
    .sort((a, b) => b.usd - a.usd || b.requests - a.requests)
    .slice(0, 6)
    .map(p => ({
      ...p,
      usd: Number(p.usd.toFixed(4)),
      sharePct: totalUsd > 0 ? Number(((p.usd / totalUsd) * 100).toFixed(1)) : null,
    }));

  const series = [...seriesMap.values()].map(b => ({
    ...b,
    usd: Number(b.usd.toFixed(4)),
  }));

  const avg = map => map.size > 0 ? Number(([...map.values()].reduce((a, b) => a + b, 0) / map.size).toFixed(3)) : null;

  // Empirical calibration: USD API equivalent per 1% of quota on the user's ACTUAL plan
  // Uses strictly isolated (`observed`) turns with positive drop and complete pricing.
  let cal5hUsd = 0, cal5hDrop = 0, cal5hCount = 0;
  let calWUsd = 0, calWDrop = 0, calWCount = 0;
  const activeDayKeys = new Set();
  for (const t of turnAggs.values()) {
    activeDayKeys.add(localDayKey(t.time));
    if (t.pricedSteps !== t.steps || t.usd <= 0) continue;
    const q = turnQuotaMap?.get(t.reference);
    if (!q) continue;
    const obs5 = pickQuotaDelta(q, 300, provider, t.model, true);
    if (obs5 !== null && obs5 > 0) { cal5hUsd += t.usd; cal5hDrop += obs5; cal5hCount++; }
    const obsW = pickQuotaDelta(q, 10080, provider, t.model, true);
    if (obsW !== null && obsW > 0) { calWUsd += t.usd; calWDrop += obsW; calWCount++; }
  }

  const activeDays = activeDayKeys.size;
  const quotaAverages = {
    avg5hPerTurnPp: avg(turnDrops5h),
    measured5hTurns: turnDrops5h.size,
    avgWeekPerTurnPp: avg(turnDropsWeek),
    measuredWeekTurns: turnDropsWeek.size,
    avg5hPerSessionPp: avg(sessionDrops5h),
    measured5hSessions: sessionDrops5h.size,
    avgWeekPerSessionPp: avg(sessionDropsWeek),
    measuredWeekSessions: sessionDropsWeek.size,
    avgCostPerSessionUsd: sessionCount > 0 && apiCost.usd !== null ? Number((apiCost.usd / sessionCount).toFixed(4)) : null,
    avgStepsPerTurn: turnCount > 0 ? Number((summary.observedRequests / turnCount).toFixed(1)) : null,
    sessionCount,
    activeDays,
    avgUsdPerActiveDay: activeDays > 0 && apiCost.usd !== null ? Number((apiCost.usd / activeDays).toFixed(4)) : null,
    usdPer1Pct5h: cal5hCount > 0 && cal5hDrop >= 0.05 ? Number((cal5hUsd / cal5hDrop).toFixed(4)) : null,
    calibrated5hTurns: cal5hCount,
    usdPer1PctWeek: calWCount > 0 && calWDrop >= 0.05 ? Number((calWUsd / calWDrop).toFixed(4)) : null,
    calibratedWeekTurns: calWCount,
  };

  return {
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    observedRequests: summary.observedRequests,
    observedTurns: turnCount,
    observedSessions: sessionCount,
    observedCounts: summary.observedCounts,
    apiCost,
    avgCostPerTurnUsd,
    reasoningPct,
    quotaAverages,
    byModel: models,
    byModelEffort,
    byEffort,
    byProject: projects,
    topPrompts,
    contextBuckets,
    topChats,
    series,
  };
}

export function analyticsSummary(history, until, provider = 'codex', live = [], quotaOptions = undefined) {
  const sameRequests = [...history.requests.values()].filter(row => row.scope === 'same' && row.time <= until);
  const projectNames = new Map();
  for (const p of history.projects ?? []) {
    if (p?.reference && p?.name) projectNames.set(p.reference, p.name);
  }
  const sessionProjects = new Map();
  const sessionTitles = new Map();
  for (const s of history.sessionCatalog ?? []) {
    if (s?.reference && s?.projectReference) sessionProjects.set(s.reference, s.projectReference);
    if (s?.reference && (s.nativeTitle || s.title)) sessionTitles.set(s.reference, s.nativeTitle || s.title);
  }

  // Compute quota impact per active turn in the 30-day window so averages & model comparisons include real 5h/weekly drops
  const turnQuotaMap = new Map();
  const series = quotaObservations(history, live, until, quotaOptions);
  const hasAnyQuota = [...series.values()].some(v => (Array.isArray(v) ? v.length : v.samples.length) >= 2);
  if (hasAnyQuota) {
    const cutoff30d = until - 30 * 86_400_000;
    const seenTurns = new Set();
    for (const req of sameRequests) {
      if (req.time > cutoff30d) seenTurns.add(req.turn);
    }
    for (const turnKey of seenTurns) {
      const turn = history.turns.get(turnKey);
      if (!turn) continue;
      const start = turn.started ?? turn.first;
      const end = turn.ended ?? turn.last;
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const q = interactionQuota(series, {
        reference: turnKey,
        members: new Set([turnKey]),
        startedAt: turn.started ? new Date(turn.started).toISOString() : null,
        endedAt: turn.ended ? new Date(turn.ended).toISOString() : null,
        firstRequest: turn.first,
        lastRequest: turn.last,
      }, history);
      turnQuotaMap.set(turnKey, q);
    }
  }

  return {
    catalog: pricingCatalogStatus(),
    periods: {
      '24h': buildPeriodAnalytics(sameRequests, history, until - 24 * 3_600_000, until, provider, 'hour', projectNames, sessionProjects, sessionTitles, turnQuotaMap),
      '7d': buildPeriodAnalytics(sameRequests, history, until - 7 * 86_400_000, until, provider, '7d', projectNames, sessionProjects, sessionTitles, turnQuotaMap),
      '30d': buildPeriodAnalytics(sameRequests, history, until - 30 * 86_400_000, until, provider, '30d', projectNames, sessionProjects, sessionTitles, turnQuotaMap),
    },
  };
}


function isQuestion(turn) {
  return turn.scope === 'same' && !turn.child && !turn.familyConflict && (turn.composer || turn.messages?.size);
}

function interactionGroups(history, since, until) {
  const candidateRoots = new Map();
  for (const turn of history.turns.values()) {
    if (!isQuestion(turn) || !turn.family) continue;
    candidateRoots.set(turn.family, candidateRoots.has(turn.family) ? null : turn.key);
  }

  const groups = new Map();
  function groupFor(key) {
    const turn = history.turns.get(key);
    const root = turn?.family && !turn.familyConflict && turn.scope === 'same'
      ? candidateRoots.get(turn.family) ?? key : key;
    if (!groups.has(root)) groups.set(root, { reference: root, requests: [], members: new Set([root]) });
    const group = groups.get(root);
    group.members.add(key);
    return group;
  }

  for (const turn of history.turns.values()) {
    const firstMessage = Math.min(...[...(turn.messages?.values() ?? [])].map(message => message.time));
    const active = Math.min(turn.started ?? Infinity, turn.first, firstMessage) <= until &&
      Math.max(turn.ended ?? -Infinity, turn.last, Number.isFinite(firstMessage) ? firstMessage : -Infinity) > since;
    if (turn.scope === 'same' && active) groupFor(turn.key);
  }
  for (const request of history.requests.values()) {
    if (request.scope !== 'same' || request.time <= since || request.time > until) continue;
    groupFor(request.turn).requests.push(request);
  }
  return [...groups.values()];
}

export function interactionSummary(history, since, until, live = [], bySession = false, quotaOptions = undefined) {
  const provider = quotaOptions?.provider ?? (quotaOptions?.buckets ? 'antigravity' : 'codex');
  const series = quotaObservations(history, live, until, quotaOptions);
  const interactions = interactionGroups(history, bySession ? -Infinity : since, until).flatMap(({ reference, members, requests }) => {
    requests.sort((left, right) => left.time - right.time);
    const turn = history.turns.get(reference);
    const question = turn && isQuestion(turn);
    if (bySession && turn?.session !== history.selectedSession) return [];
    if (!question && requests.length === 0) return [];

    const messages = [...(turn?.messages?.values() ?? [])].filter(row => row.time <= until)
      .sort((left, right) => left.time - right.time);
    const started = turn?.started ?? messages[0]?.time ?? null;
    const sent = question ? messages[0]?.time ?? started : null;
    const memberEnds = [...members].map(key => history.turns.get(key)?.ended);
    const knownEnd = memberEnds.every(time => Number.isFinite(time) && time <= until)
      ? Math.max(...memberEnds) : null;
    const lastActivity = requests.at(-1)?.time ?? started ?? sent;
    const firstActivity = requests[0]?.time ?? started ?? sent;
    if (firstActivity === null) return [];
    const firstMain = requests.find(request => request.turn === reference);
    const confirmedMessages = messages.length || (question ? 1 : 0);
    const pricedAll = requests.map(request => {
      const reqTurn = history.turns.get(request.turn);
      const model = request.model
        ?? (reqTurn?.models?.length === 1 ? reqTurn.models[0] : null)
        ?? (turn?.models?.length === 1 ? turn.models[0] : null);
      return priceRequest(request.usage, model, { provider, at: request.time });
    });
    const apiCost = aggregateCosts(pricedAll);
    const recentSliceStart = Math.max(0, requests.length - 80);
    const detail = {
      reference,
      kind: question ? 'question' : 'other',
      sentAt: sent === null ? null : new Date(sent).toISOString(),
      messageCount: confirmedMessages,
      messages: bySession && question ? messages.map(message => ({
        sentAt: new Date(message.time).toISOString(), preview: message.preview,
      })) : undefined,
      promptPreview: question ? messages[0]?.preview : undefined,
      firstRequestAt: requests.length ? new Date(firstActivity).toISOString() : null,
      lastRequestAt: new Date(lastActivity).toISOString(),
      startedAt: started !== null && started <= until ? new Date(started).toISOString() : null,
      endedAt: knownEnd === null ? null : new Date(knownEnd).toISOString(),
      status: knownEnd === null ? 'end-unobserved' : turn?.outcome,
      durationMs: knownEnd === null ? null : members.size > 1 && started !== null ? knownEnd - started : turn?.durationMs ?? null,
      configuredModels: turn?.models ?? [],
      reasoningEfforts: turn?.efforts ?? [],
      ...summarizeRequests(requests),
      apiCost,
      additionalRequests: requests.length - Number(Boolean(firstMain)),
      childRequests: requests.filter(request => request.turn !== reference).length,
      requests: requests.slice(recentSliceStart).map((request, idx) => {
        const priced = pricedAll[recentSliceStart + idx];
        return {
          at: new Date(request.time).toISOString(), usage: request.usage,
          ...(priced?.available ? {
            costUsd: priced.usd,
            tier: priced.tier,
            contextTokens: priced.contextTokens,
          } : {}),
          ...(question ? { kind: request.turn !== reference ? 'related'
            : request === firstMain ? 'first' : 'followup' } : {}),
        };
      }),
    };
    return [{
      ...detail,
      quota: interactionQuota(series, {
        reference, members, startedAt: detail.startedAt, endedAt: detail.endedAt,
        firstRequest: firstActivity, lastRequest: lastActivity,
      }, history),
    }];
  });
  interactions.sort((left, right) => (right.sentAt ?? right.lastRequestAt).localeCompare(left.sentAt ?? left.lastRequestAt));
  const questions = interactions.filter(row => row.kind === 'question');
  const other = interactions.filter(row => row.kind === 'other');

  let sessionModelComparison;
  if (bySession && history.selectedSession) {
    const turnQuotaMap = new Map(interactions.map(t => [t.reference, t.quota]));
    const sessionRequests = [...history.requests.values()].filter(req => {
      if (req.scope !== 'same' || req.time > until) return false;
      const turn = history.turns.get(req.turn);
      return turn?.session === history.selectedSession;
    });
    sessionModelComparison = buildModelEffortComparison(sessionRequests, history, provider, turnQuotaMap).byModelEffort;
  }

  return {
    observedTurns: interactions.length, observedQuestions: questions.length, observedOtherTurns: other.length,
    turns: bySession ? [...questions, ...other] : [...questions.slice(0, 50), ...other.slice(0, 50)],
    sessions: bySession ? sessionOptions(history, until) : undefined,
    projects: bySession ? history.projects : undefined,
    selectedSession: bySession ? history.selectedSession : undefined,
    sessionModelComparison,
  };
}

function sessionOptions(history, until) {
  const titles = new Map();
  for (const turn of history.turns.values()) {
    if (!turn.session || !isQuestion(turn)) continue;
    for (const message of turn.messages?.values() ?? []) {
      if (message.preview && message.time <= until && message.time > (titles.get(turn.session)?.time ?? -Infinity))
        titles.set(turn.session, message);
    }
  }
  return history.sessionCatalog.map(session => ({
    ...session, title: session.nativeTitle ?? titles.get(session.reference)?.preview,
  }));
}
