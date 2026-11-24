// Official Antigravity CLI (`agy`) quota reader.
// Runs `agy -p "/usage" --output-format json` (0 model turns, 0 tokens).

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function findAgyExecutable(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.AGY_BIN,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe') : null,
    join(homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe'),
    join(homedir(), '.local', 'bin', 'agy'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch { /* try next */ }
  }
  return process.platform === 'win32' ? 'agy.exe' : 'agy';
}

function mapPool(groupName, bucketId) {
  const id = (bucketId || '').toLowerCase();
  const group = (groupName || '').toLowerCase();
  if (id.startsWith('gemini') || group.includes('gemini')) return 'gemini';
  if (id.startsWith('3p') || group.includes('claude') || group.includes('gpt')) return 'claude_gpt';
  return id || 'antigravity';
}

function mapMinutes(windowName, bucketId) {
  const w = (windowName || '').toLowerCase();
  const id = (bucketId || '').toLowerCase();
  if (w === '5h' || id.endsWith('-5h')) return 300;
  if (w === 'weekly' || id.endsWith('-weekly')) return 10080;
  return null;
}

export function parseAgyUsageJson(payload, observedAtIso = new Date().toISOString(), readMs = 0) {
  if (!payload || payload.status !== 'SUCCESS') return null;
  const groups = payload.command?.data?.groups;
  if (!Array.isArray(groups)) return null;

  const windows = [];
  for (const group of groups) {
    for (const bucket of group?.buckets ?? []) {
      const rem = bucket?.remaining_fraction;
      if (typeof rem !== 'number' || !Number.isFinite(rem) || rem < 0 || rem > 1) continue;
      const minutes = mapMinutes(bucket.window, bucket.id);
      if (!minutes) continue;
      const pool = mapPool(group.name, bucket.id);
      const usedPercent = Number(((1 - rem) * 100).toFixed(4));
      const resetsAt = typeof bucket.reset_time === 'string' && Number.isFinite(Date.parse(bucket.reset_time))
        ? new Date(Date.parse(bucket.reset_time)).toISOString()
        : null;
      windows.push({
        pool,
        slot: minutes === 10080 ? 'secondary' : 'primary',
        minutes,
        usedPercent,
        resetsAt,
      });
    }
  }

  return {
    source: 'agy-cli',
    observedAt: observedAtIso,
    readMs,
    plan: 'Antigravity',
    windows,
  };
}

export async function readAgyUsage(executable, timeoutMs = 15000) {
  const started = Date.now();
  const { stdout } = await execFileAsync(
    executable,
    ['-p', '/usage', '--output-format', 'json', '--print-timeout', '12s'],
    { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  const readMs = Date.now() - started;
  const line = stdout.trim().split(/\r?\n/).findLast(l => l.trim().startsWith('{'));
  if (!line) throw new Error('agy /usage no devolvió JSON válido.');
  const payload = JSON.parse(line);
  const sample = parseAgyUsageJson(payload, new Date().toISOString(), readMs);
  if (!sample) throw new Error('agy /usage no reportó estado SUCCESS.');
  return sample;
}
