// Automatic, non-blocking public pricing catalog synchronizer.
// Fetches public model pricing metadata at most once every 24 hours, validates
// every numeric field strictly, and persists to %LOCALAPPDATA%\AIUsageIntelligence\pricing-cache.json.
// Built-in dated official tariffs in pricing.mjs remain the baseline fallback when offline.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 15 * 1024 * 1024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function validRate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000;
}

function toPerMillion(perToken) {
  if (typeof perToken !== 'number' || !Number.isFinite(perToken) || perToken < 0) return null;
  const perM = Number((perToken * 1_000_000).toFixed(6));
  return validRate(perM) ? perM : null;
}

/**
 * Extract validated per-1M-token rates for OpenAI, Gemini, and Anthropic models
 * from a LiteLLM-formatted pricing JSON object.
 */
export function parseExternalPricingJson(raw) {
  if (!raw || typeof raw !== 'object') return Object.create(null);
  const result = Object.create(null);
  for (const [key, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object' || key.length > 160) continue;
    const provider = String(entry.litellm_provider ?? '').toLowerCase();
    const isRelevant = provider.includes('openai') || provider.includes('gemini') || provider.includes('google')
      || provider.includes('anthropic') || /^(?:gpt-|gemini-|claude-|o[134]-)/i.test(key);
    if (!isRelevant) continue;

    const input = toPerMillion(entry.input_cost_per_token);
    const output = toPerMillion(entry.output_cost_per_token);
    if (input === null || output === null) continue;

    const cacheRead = toPerMillion(entry.cache_read_input_token_cost) ?? Number((input * 0.1).toFixed(6));
    const cacheWrite = toPerMillion(entry.cache_creation_input_token_cost) ?? 0;

    let longContext = null;
    const longIn = toPerMillion(entry.input_cost_per_token_above_200k_tokens);
    const longOut = toPerMillion(entry.output_cost_per_token_above_200k_tokens);
    if (longIn !== null && longOut !== null) {
      longContext = {
        threshold: 200_000,
        input: longIn,
        cacheRead: toPerMillion(entry.cache_read_input_token_cost_above_200k_tokens) ?? Number((longIn * 0.1).toFixed(6)),
        cacheWrite: toPerMillion(entry.cache_creation_input_token_cost_above_200k_tokens) ?? 0,
        output: longOut,
      };
    }

    const normalizedKey = key.toLowerCase().replace(/^(?:openai|gemini|anthropic|vertex_ai)\//, '');
    if (!normalizedKey || FORBIDDEN_KEYS.has(normalizedKey)) continue;
    result[normalizedKey] = {
      sku: normalizedKey,
      source: 'litellm-public-catalog',
      standard: { input, cacheRead, cacheWrite, output },
      longContext,
    };
  }
  return result;
}

export async function readPricingCache(cachePath) {
  try {
    const raw = JSON.parse(await readFile(cachePath, 'utf8'));
    if (!raw || typeof raw !== 'object' || typeof raw.updatedAt !== 'string' || !raw.models) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function syncPricingCache(cachePath, options = {}) {
  const maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS;
  const url = options.url ?? DEFAULT_URL;
  const existing = await readPricingCache(cachePath);
  const lastMs = existing?.updatedAt ? Date.parse(existing.updatedAt) : 0;

  if (existing && Number.isFinite(lastMs) && Date.now() - lastMs < maxAgeMs && !options.force) {
    return existing;
  }

  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { return existing; }
  if (parsedUrl.protocol !== 'https:') return existing;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(parsedUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'AIUsageIntelligence/1.0' },
    });
    if (!response.ok) return existing;
    const declaredLen = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLen) && declaredLen > MAX_RESPONSE_BYTES) return existing;
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > MAX_RESPONSE_BYTES) return existing;
    const json = JSON.parse(buf.toString('utf8'));
    const models = parseExternalPricingJson(json);
    if (Object.keys(models).length < 10) return existing;

    const payload = {
      updatedAt: new Date().toISOString(),
      source: url,
      modelCount: Object.keys(models).length,
      models,
    };
    await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
    const tmpPath = cachePath + '.tmp';
    await writeFile(tmpPath, JSON.stringify(payload), { mode: 0o600 });
    await rename(tmpPath, cachePath);
    return payload;
  } catch {
    return existing;
  } finally {
    clearTimeout(timer);
  }
}
