// Official API pricing catalog & per-request / per-turn cost calculator.
// Pure, decoupled module following MEASUREMENT_METHODOLOGY.md:
// - Dated tariffs (effectiveFrom / effectiveUntil)
// - Provider-accurate token semantics (OpenAI inclusive input vs Antigravity exclusive input)
// - Per-request context-size tiering (e.g., >272K for GPT-5.4/GPT-6.x, >200K for Gemini Pro)
// - Full component breakdown (fresh input, cache read, cache write, output incl. reasoning)

export const CATALOG_VERSION = '2026-11-24';

const DEC_1_2026 = Date.UTC(2026, 11, 1);
const JAN_1_2027 = Date.UTC(2027, 0, 1);

/**
 * Each entry defines standard rates (USD per 1M tokens) and optional longContext tier.
 * `longContext`: { threshold, input, cacheRead, cacheWrite, output }
 */
const TARIFFS = [
  // --- OpenAI GPT-6 / GPT-5.6 / GPT-5 (Codex) ---
  {
    sku: 'gpt-6-astra',
    match: /^gpt-6(?:\.\d+)?-astra\b/i,
    source: 'openai.com/api/pricing',
    standard: { input: 10.0, cacheRead: 1.0, cacheWrite: 12.5, output: 50.0 },
    longContext: { threshold: 272_000, input: 20.0, cacheRead: 2.0, cacheWrite: 25.0, output: 75.0 },
  },
  {
    sku: 'gpt-6-sol',
    match: /^gpt-6(?:\.\d+)?-sol\b/i,
    source: 'openai.com/api/pricing',
    standard: { input: 2.0, cacheRead: 0.1, cacheWrite: 2.5, output: 10.0 },
    longContext: { threshold: 272_000, input: 4.0, cacheRead: 0.2, cacheWrite: 5.0, output: 15.0 },
  },
  {
    sku: 'gpt-6-terra',
    match: /^gpt-6(?:\.\d+)?-terra\b/i,
    source: 'openai.com/api/pricing',
    standard: { input: 1.0, cacheRead: 0.05, cacheWrite: 1.25, output: 5.0 },
    longContext: { threshold: 272_000, input: 2.0, cacheRead: 0.1, cacheWrite: 2.5, output: 7.5 },
  },
  {
    sku: 'gpt-6-luna',
    match: /^gpt-6(?:\.\d+)?-luna\b/i,
    source: 'openai.com/api/pricing',
    standard: { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
    longContext: { threshold: 272_000, input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 0.75 },
  },
  {
    sku: 'gpt-5.6-sol',
    match: /^gpt-5\.6-sol\b/i,
    source: 'openai.com/api/pricing',
    standard: { input: 4.0, cacheRead: 0.4, cacheWrite: 5.0, output: 20.0 },
    longContext: { threshold: 272_000, input: 8.0, cacheRead: 0.8, cacheWrite: 10.0, output: 30.0 },
  },
  {
    sku: 'gpt-5.6-luna',
    match: /^gpt-5\.6-luna\b/i,
    source: 'openai.com/api/pricing',
    standard: { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 },
    longContext: { threshold: 272_000, input: 0.4, cacheRead: 0.04, cacheWrite: 0.5, output: 1.8 },
  },
  {
    sku: 'gpt-5.4',
    match: /^gpt-5\.4\b/i,
    source: 'openai.com/api/pricing',
    standard: { input: 2.5, cacheRead: 0.25, cacheWrite: 3.125, output: 15.0 },
    longContext: { threshold: 272_000, input: 5.0, cacheRead: 0.5, cacheWrite: 6.25, output: 22.5 },
  },
  {
    sku: 'gpt-5.3-codex',
    match: /^gpt-5\.[23](?:-codex)?\b/i,
    source: 'openai.com/api/pricing',
    standard: { input: 1.75, cacheRead: 0.175, cacheWrite: 2.1875, output: 14.0 },
    longContext: null,
  },
  {
    sku: 'gpt-5-codex',
    match: /^gpt-5(?:\.1)?(?:-codex)?\b/i,
    source: 'openai.com/api/pricing',
    standard: { input: 1.25, cacheRead: 0.125, cacheWrite: 1.5625, output: 10.0 },
    longContext: null,
  },

  // --- Google Gemini 4 & 3.x (Antigravity) ---
  {
    sku: 'gemini-4-neon',
    match: /^(?:gemini[\s-]*4[\s-]*neon|orchestrator\s*\(neon\))/i,
    source: 'ai.google.dev/pricing',
    standard: { input: 3.0, cacheRead: 0.15, cacheWrite: 0, output: 15.0 },
    longContext: null, // Unified 1M flat pricing
  },
  {
    sku: 'gemini-4-hydrogen',
    match: /^gemini[\s-]*4[\s-]*hydrogen/i,
    source: 'ai.google.dev/pricing',
    standard: { input: 1.5, cacheRead: 0.075, cacheWrite: 0, output: 7.5 },
    longContext: null, // Unified 1M flat pricing
  },
  {
    sku: 'gemini-4-argon',
    match: /^(?:gemini[\s-]*4[\s-]*argon|orchestrator\s*\(argon\))/i,
    source: 'ai.google.dev/pricing',
    effectiveUntil: DEC_1_2026,
    standard: { input: 2.0, cacheRead: 0.1, cacheWrite: 0, output: 10.0 },
    longContext: null,
  },
  {
    sku: 'gemini-4-argon',
    match: /^(?:gemini[\s-]*4[\s-]*argon|orchestrator\s*\(argon\))/i,
    source: 'ai.google.dev/pricing',
    effectiveFrom: DEC_1_2026,
    standard: { input: 4.0, cacheRead: 0.2, cacheWrite: 0, output: 20.0 },
    longContext: null,
  },
  {
    sku: 'gemini-4-carbon',
    match: /^(?:gemini[\s-]*4[\s-]*carbon|orchestrator\s*\(carbon\))/i,
    source: 'ai.google.dev/pricing',
    effectiveUntil: DEC_1_2026,
    standard: { input: 2.0, cacheRead: 0.1, cacheWrite: 0, output: 10.0 },
    longContext: null,
  },
  {
    sku: 'gemini-4-carbon',
    match: /^(?:gemini[\s-]*4[\s-]*carbon|orchestrator\s*\(carbon\))/i,
    source: 'ai.google.dev/pricing',
    effectiveFrom: DEC_1_2026,
    standard: { input: 4.0, cacheRead: 0.2, cacheWrite: 0, output: 20.0 },
    longContext: null,
  },
  {
    sku: 'gemini-3.8-flash',
    match: /^gemini[\s-]*3\.8[\s-]*flash/i,
    source: 'ai.google.dev/pricing',
    effectiveUntil: JAN_1_2027,
    standard: { input: 0.75, cacheRead: 0.075, cacheWrite: 0, output: 3.75 },
    longContext: null,
  },
  {
    sku: 'gemini-3.8-flash',
    match: /^gemini[\s-]*3\.8[\s-]*flash/i,
    source: 'ai.google.dev/pricing',
    effectiveFrom: JAN_1_2027,
    standard: { input: 1.5, cacheRead: 0.15, cacheWrite: 0, output: 7.5 },
    longContext: null,
  },
  {
    sku: 'gemini-3.1-pro',
    match: /^gemini[\s-]*(?:3\.1|2\.5)[\s-]*pro/i,
    source: 'ai.google.dev/pricing',
    standard: { input: 2.0, cacheRead: 0.2, cacheWrite: 0, output: 12.0 },
    longContext: { threshold: 200_000, input: 4.0, cacheRead: 0.4, cacheWrite: 0, output: 18.0 },
  },

  // --- Anthropic Claude 5.5 (Antigravity) ---
  {
    sku: 'claude-opus-5-5',
    match: /^claude[\s-]*opus[\s-]*5[.-]5/i,
    source: 'platform.claude.com/pricing',
    standard: { input: 4.0, cacheRead: 0.2, cacheWrite: 5.0, output: 20.0 },
    longContext: null, // Unified 1M flat pricing on 5.5
  },
  {
    sku: 'claude-sonnet-5-5',
    match: /^claude[\s-]*sonnet[\s-]*5[.-]5/i,
    source: 'platform.claude.com/pricing',
    standard: { input: 2.0, cacheRead: 0.1, cacheWrite: 2.5, output: 10.0 },
    longContext: null, // Unified 1M flat pricing on 5.5
  },
];

let externalCatalog = new Map();
let externalUpdatedAt = null;

export function applyExternalPricing(cachePayload) {
  if (!cachePayload?.models || typeof cachePayload.models !== 'object') return 0;
  const next = new Map();
  for (const [key, entry] of Object.entries(cachePayload.models)) {
    if (entry?.standard && typeof entry.standard.input === 'number' && typeof entry.standard.output === 'number') {
      next.set(key.toLowerCase(), entry);
    }
  }
  externalCatalog = next;
  externalUpdatedAt = typeof cachePayload.updatedAt === 'string' ? cachePayload.updatedAt : null;
  return externalCatalog.size;
}

export function pricingCatalogStatus() {
  return {
    builtInVersion: CATALOG_VERSION,
    syncedAt: externalUpdatedAt,
    externalModels: externalCatalog.size,
  };
}

export function resolveTariff(modelName, timestampMs = Date.now()) {
  if (typeof modelName !== 'string' || !modelName.trim()) return null;
  const normalized = modelName.trim();
  const time = Number.isFinite(timestampMs) ? timestampMs : Date.now();
  // Prefer built-in dated official tariffs first (exact context thresholds & effective dates)
  for (const entry of TARIFFS) {
    if (!entry.match.test(normalized)) continue;
    if (entry.effectiveFrom && time < entry.effectiveFrom) continue;
    if (entry.effectiveUntil && time >= entry.effectiveUntil) continue;
    return entry;
  }
  // Fallback to auto-synced public catalog for newly released models
  const slug = normalized.toLowerCase().replace(/\s+/g, '-');
  return externalCatalog.get(slug) ?? externalCatalog.get(normalized.toLowerCase()) ?? null;
}

/**
 * Price a single LLM request.
 * @param {object} usage - { input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens }
 * @param {string} modelName
 * @param {{ provider?: 'codex' | 'antigravity', at?: number }} options
 */
export function priceRequest(usage, modelName, options = {}) {
  const tariff = resolveTariff(modelName, options.at);
  if (!tariff || !usage) {
    return {
      available: false,
      sku: modelName || null,
      reason: !modelName ? 'missing-model' : !tariff ? 'unpriced-model' : 'missing-usage',
    };
  }

  const rawInput = Number.isFinite(usage.input_tokens) ? Math.max(0, usage.input_tokens) : 0;
  const cacheRead = Number.isFinite(usage.cached_input_tokens) ? Math.max(0, usage.cached_input_tokens) : 0;
  const cacheWrite = Number.isFinite(usage.cache_write_input_tokens) ? Math.max(0, usage.cache_write_input_tokens) : 0;
  // Output tokens already include reasoning_output_tokens in both OpenAI and Antigravity records.
  const output = Number.isFinite(usage.output_tokens) ? Math.max(0, usage.output_tokens) : 0;

  // OpenAI input_tokens is inclusive of cached_input_tokens; Antigravity SQLite f2 is already exclusive of f5.
  const inclusiveInput = options.provider !== 'antigravity';
  const freshInput = inclusiveInput ? Math.max(0, rawInput - cacheRead - cacheWrite) : rawInput;
  const contextTokens = inclusiveInput ? rawInput : rawInput + cacheRead + cacheWrite;

  const isLongContext = Boolean(tariff.longContext && contextTokens > tariff.longContext.threshold);
  const rates = isLongContext ? tariff.longContext : tariff.standard;

  const inputUsd = (freshInput * rates.input) / 1_000_000;
  const cacheReadUsd = (cacheRead * rates.cacheRead) / 1_000_000;
  const cacheWriteUsd = (cacheWrite * (rates.cacheWrite ?? rates.input)) / 1_000_000;
  const outputUsd = (output * rates.output) / 1_000_000;
  const usd = inputUsd + cacheReadUsd + cacheWriteUsd + outputUsd;
  const cacheSavingsUsd = Math.max(0, (cacheRead * (rates.input - rates.cacheRead)) / 1_000_000);

  return {
    available: true,
    sku: tariff.sku,
    source: tariff.source,
    tier: isLongContext ? 'long-context' : 'standard',
    tierThreshold: tariff.longContext?.threshold ?? null,
    contextTokens,
    freshInputTokens: freshInput,
    cacheReadTokens: cacheRead,
    outputTokens: output,
    usd: Number(usd.toFixed(6)),
    cacheSavingsUsd: Number(cacheSavingsUsd.toFixed(6)),
    breakdown: {
      inputUsd: Number(inputUsd.toFixed(6)),
      cacheReadUsd: Number(cacheReadUsd.toFixed(6)),
      cacheWriteUsd: Number(cacheWriteUsd.toFixed(6)),
      outputUsd: Number(outputUsd.toFixed(6)),
    },
    ratesPerMillion: {
      input: rates.input,
      cacheRead: rates.cacheRead,
      cacheWrite: rates.cacheWrite ?? rates.input,
      output: rates.output,
    },
    catalogVersion: CATALOG_VERSION,
  };
}

/**
 * Aggregate API cost across all requests in a turn or period.
 */
export function aggregateCosts(pricedRequests) {
  let usd = 0;
  let cacheSavingsUsd = 0;
  let inputUsd = 0;
  let cacheReadUsd = 0;
  let cacheWriteUsd = 0;
  let outputUsd = 0;
  let pricedCount = 0;
  let longContextCount = 0;
  let maxContextTokens = 0;
  let totalFreshInput = 0;
  let totalCacheRead = 0;
  const sources = new Set();

  for (const item of pricedRequests) {
    if (!item?.available) continue;
    pricedCount++;
    usd += item.usd;
    cacheSavingsUsd += item.cacheSavingsUsd ?? 0;
    inputUsd += item.breakdown.inputUsd;
    cacheReadUsd += item.breakdown.cacheReadUsd;
    cacheWriteUsd += item.breakdown.cacheWriteUsd;
    outputUsd += item.breakdown.outputUsd;
    totalFreshInput += item.freshInputTokens ?? 0;
    totalCacheRead += item.cacheReadTokens ?? 0;
    if (item.tier === 'long-context') longContextCount++;
    if (item.contextTokens > maxContextTokens) maxContextTokens = item.contextTokens;
    if (item.source) sources.add(item.source);
  }

  const totalInputPool = totalFreshInput + totalCacheRead;
  const cacheHitRatePct = totalInputPool > 0
    ? Number(((totalCacheRead / totalInputPool) * 100).toFixed(1))
    : null;

  return {
    usd: pricedCount > 0 ? Number(usd.toFixed(6)) : null,
    cacheSavingsUsd: pricedCount > 0 ? Number(cacheSavingsUsd.toFixed(6)) : null,
    cacheHitRatePct,
    pricedRequests: pricedCount,
    totalRequests: pricedRequests.length,
    longContextRequests: longContextCount,
    maxContextTokens,
    breakdown: {
      inputUsd: Number(inputUsd.toFixed(6)),
      cacheReadUsd: Number(cacheReadUsd.toFixed(6)),
      cacheWriteUsd: Number(cacheWriteUsd.toFixed(6)),
      outputUsd: Number(outputUsd.toFixed(6)),
    },
    sources: [...sources],
    catalogVersion: CATALOG_VERSION,
  };
}
