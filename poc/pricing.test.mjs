import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCosts, applyExternalPricing, priceRequest, resolveTariff } from './pricing.mjs';
import { parseExternalPricingJson } from './pricing-sync.mjs';
import { analyticsSummary, interactionSummary } from './report.mjs';

test('calcula costo de Gemini 4 Neon con entrada exclusiva de caché y salida inclusiva de razonamiento', () => {
  const result = priceRequest({
    input_tokens: 100_000,
    cached_input_tokens: 1_000_000,
    output_tokens: 10_000,
    reasoning_output_tokens: 4_000,
  }, 'Gemini 4 Neon', { provider: 'antigravity', at: Date.UTC(2026, 10, 24) });

  assert.equal(result.available, true);
  assert.equal(result.sku, 'gemini-4-neon');
  assert.equal(result.tier, 'standard');
  assert.equal(result.contextTokens, 1_100_000);
  // 0.1M * $3.00 ($0.30) + 1.0M * $0.15 ($0.15) + 0.01M * $15.00 ($0.15) = $0.60
  assert.equal(result.breakdown.inputUsd, 0.3);
  assert.equal(result.breakdown.cacheReadUsd, 0.15);
  assert.equal(result.breakdown.outputUsd, 0.15);
  assert.equal(result.usd, 0.6);
});

test('aplica tarifa por fecha vigente en Gemini 4 Argon (intro nov 2026 vs estándar dic 2026)', () => {
  const nov = resolveTariff('Gemini 4 Argon', Date.UTC(2026, 10, 24));
  const dec = resolveTariff('Gemini 4 Argon', Date.UTC(2026, 11, 2));
  assert.equal(nov.standard.input, 2.0);
  assert.equal(nov.standard.output, 10.0);
  assert.equal(dec.standard.input, 4.0);
  assert.equal(dec.standard.output, 20.0);
});

test('aplica multiplicador de contexto largo (>272k) en OpenAI GPT-6.2 Sol con entrada inclusiva de caché', () => {
  const shortCtx = priceRequest({
    input_tokens: 200_000,
    cached_input_tokens: 150_000,
    output_tokens: 10_000,
  }, 'gpt-6.2-sol', { provider: 'codex' });

  // Fresh input = 50k * $2/M = $0.10; Cache = 150k * $0.10/M = $0.015; Output = 10k * $10/M = $0.10 => $0.215
  assert.equal(shortCtx.tier, 'standard');
  assert.equal(shortCtx.breakdown.inputUsd, 0.1);
  assert.equal(shortCtx.breakdown.cacheReadUsd, 0.015);
  assert.equal(shortCtx.breakdown.outputUsd, 0.1);
  assert.equal(shortCtx.usd, 0.215);

  const longCtx = priceRequest({
    input_tokens: 300_000,
    cached_input_tokens: 200_000,
    output_tokens: 10_000,
  }, 'gpt-6.2-sol', { provider: 'codex' });

  // >272k: Fresh = 100k * $4/M = $0.40; Cache = 200k * $0.20/M = $0.04; Output = 10k * $15/M = $0.15 => $0.59
  assert.equal(longCtx.tier, 'long-context');
  assert.equal(longCtx.tierThreshold, 272_000);
  assert.equal(longCtx.breakdown.inputUsd, 0.4);
  assert.equal(longCtx.breakdown.cacheReadUsd, 0.04);
  assert.equal(longCtx.breakdown.outputUsd, 0.15);
  assert.equal(longCtx.usd, 0.59);

  const agg = aggregateCosts([shortCtx, longCtx]);
  assert.equal(agg.pricedRequests, 2);
  assert.equal(agg.longContextRequests, 1);
  assert.equal(agg.maxContextTokens, 300_000);
  assert.equal(agg.usd, 0.805);
});

test('modelo sin tarifa publicada queda indisponible sin inventar costo', () => {
  const unknown = priceRequest({ input_tokens: 1000, output_tokens: 500 }, 'MODEL_M999', { provider: 'antigravity' });
  assert.equal(unknown.available, false);
  assert.equal(unknown.reason, 'unpriced-model');
});

test('parsea y aplica catálogo externo sincronizado (incluye tramo >200k y descarta valores inválidos)', () => {
  const parsed = parseExternalPricingJson({
    'openai/gpt-9-future': {
      litellm_provider: 'openai',
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
      cache_read_input_token_cost: 0.0000003,
      input_cost_per_token_above_200k_tokens: 0.000006,
      output_cost_per_token_above_200k_tokens: 0.0000225,
    },
    'invalid-model': {
      litellm_provider: 'openai',
      input_cost_per_token: -5,
      output_cost_per_token: 0.00001,
    },
  });
  assert.ok(parsed['gpt-9-future']);
  assert.equal(parsed['invalid-model'], undefined);
  assert.equal(parsed['gpt-9-future'].standard.input, 3);
  assert.equal(parsed['gpt-9-future'].longContext.threshold, 200_000);
  assert.equal(parsed['gpt-9-future'].longContext.input, 6);

  applyExternalPricing({ updatedAt: '2026-11-24T05:00:00Z', models: parsed });
  const r = priceRequest({ input_tokens: 250_000, output_tokens: 10_000 }, 'gpt-9-future', { provider: 'codex' });
  assert.equal(r.available, true);
  assert.equal(r.tier, 'long-context');
  assert.equal(r.usd, 1.725);
});

test('analyticsSummary agrupa 24h, 7d y 30d con ahorro de caché, modelos, proyectos y series', () => {
  const now = Date.UTC(2026, 10, 24, 15, 0, 0);
  const history = {
    projects: [{ reference: 'p1', name: 'Proyecto Alpha' }],
    sessionCatalog: [{ reference: 's1', projectReference: 'p1' }],
    turns: new Map([
      ['t1', { key: 't1', session: 's1', models: ['Gemini 4 Neon'] }],
      ['t2', { key: 't2', session: 's1', models: ['Gemini 4 Argon'] }],
      ['t3', { key: 't3', session: 's1', models: ['Gemini 4 Hydrogen'] }],
    ]),
    requests: new Map([
      ['r1', { turn: 't1', time: now - 3600_000, scope: 'same', model: 'Gemini 4 Neon', usage: { input_tokens: 100_000, cached_input_tokens: 900_000, output_tokens: 10_000, reasoning_output_tokens: 4_000 } }],
      ['r2', { turn: 't2', time: now - 3 * 86_400_000, scope: 'same', model: 'Gemini 4 Argon', usage: { input_tokens: 200_000, cached_input_tokens: 0, output_tokens: 20_000 } }],
      ['r3', { turn: 't3', time: now - 15 * 86_400_000, scope: 'same', model: 'Gemini 4 Hydrogen', usage: { input_tokens: 500_000, cached_input_tokens: 0, output_tokens: 50_000 } }],
    ]),
  };

  const result = analyticsSummary(history, now, 'antigravity');
  assert.equal(result.periods['24h'].observedRequests, 1);
  assert.equal(result.periods['7d'].observedRequests, 2);
  assert.equal(result.periods['30d'].observedRequests, 3);
  assert.equal(result.periods['24h'].series.length, 24);
  assert.equal(result.periods['7d'].series.length, 7);
  assert.equal(result.periods['30d'].series.length, 30);
  assert.equal(result.periods['24h'].apiCost.cacheHitRatePct, 90);
  assert.ok(result.periods['24h'].apiCost.cacheSavingsUsd > 2.5);
  assert.equal(result.periods['24h'].reasoningPct, 40);
  assert.equal(result.periods['30d'].byModel.length, 3);
  assert.equal(result.periods['30d'].byProject[0].project, 'Proyecto Alpha');
});

test('desglosa gasto por modelo×esfuerzo, promedios de cuota por turno/sesión y comparativa en la misma sesión', () => {
  const t0 = Date.UTC(2026, 10, 24, 14, 0, 0);
  const reset5h = new Date(t0 + 5 * 3600_000).toISOString();
  const resetW = new Date(t0 + 7 * 86_400_000).toISOString();
  const history = {
    projects: [{ reference: 'p1', name: 'Proyecto Alpha' }],
    sessionCatalog: [{ reference: 's1', projectReference: 'p1' }],
    selectedSession: 's1',
    snapshots: [],
    turns: new Map([
      ['t1', { key: 't1', session: 's1', scope: 'same', composer: true, started: t0 + 10_000, ended: t0 + 20_000, first: t0 + 10_000, last: t0 + 20_000, models: ['Gemini 4 Neon'], efforts: ['medium'] }],
      ['t2', { key: 't2', session: 's1', scope: 'same', composer: true, started: t0 + 60_000, ended: t0 + 70_000, first: t0 + 60_000, last: t0 + 70_000, models: ['Gemini 4 Neon'], efforts: ['high'] }],
    ]),
    requests: new Map([
      ['r1', { turn: 't1', time: t0 + 15_000, scope: 'same', model: 'Gemini 4 Neon', effort: 'medium', usage: { input_tokens: 100_000, cached_input_tokens: 0, output_tokens: 10_000, reasoning_output_tokens: 2_000 } }],
      ['r2', { turn: 't2', time: t0 + 65_000, scope: 'same', model: 'Gemini 4 Neon', effort: 'high', usage: { input_tokens: 100_000, cached_input_tokens: 0, output_tokens: 40_000, reasoning_output_tokens: 30_000 } }],
    ]),
  };
  const live = [
    { pool: 'gemini', minutes: 300, usedPercent: 10, resetsAt: reset5h, time: t0, scope: 'same', plan: 'Antigravity', source: 'agy-cli' },
    { pool: 'gemini', minutes: 300, usedPercent: 11, resetsAt: reset5h, time: t0 + 30_000, scope: 'same', plan: 'Antigravity', source: 'agy-cli' },
    { pool: 'gemini', minutes: 300, usedPercent: 14, resetsAt: reset5h, time: t0 + 80_000, scope: 'same', plan: 'Antigravity', source: 'agy-cli' },
    { pool: 'gemini', minutes: 10080, usedPercent: 5, resetsAt: resetW, time: t0, scope: 'same', plan: 'Antigravity', source: 'agy-cli' },
    { pool: 'gemini', minutes: 10080, usedPercent: 5.5, resetsAt: resetW, time: t0 + 30_000, scope: 'same', plan: 'Antigravity', source: 'agy-cli' },
    { pool: 'gemini', minutes: 10080, usedPercent: 7, resetsAt: resetW, time: t0 + 80_000, scope: 'same', plan: 'Antigravity', source: 'agy-cli' },
  ];
  const buckets = [{ pool: 'gemini', minutes: 300 }, { pool: 'gemini', minutes: 10080 }];
  const analytics = analyticsSummary(history, t0 + 90_000, 'antigravity', live, { buckets });
  const p24 = analytics.periods['24h'];

  assert.equal(p24.byModel.length, 1);
  assert.equal(p24.byModel[0].efforts.length, 2);
  const high = p24.byModel[0].efforts.find(e => e.effort === 'high');
  const med = p24.byModel[0].efforts.find(e => e.effort === 'medium');
  assert.equal(high.avg5hDropPp, 3);
  assert.equal(med.avg5hDropPp, 1);
  assert.equal(p24.quotaAverages.avg5hPerTurnPp, 2);
  assert.equal(p24.quotaAverages.avg5hPerSessionPp, 4);
  assert.equal(p24.quotaAverages.avgWeekPerSessionPp, 2);

  const inter = interactionSummary(history, t0, t0 + 90_000, live, true, { buckets });
  assert.equal(inter.sessionModelComparison.length, 2);
  assert.equal(inter.sessionModelComparison[0].effort, 'high');
});
