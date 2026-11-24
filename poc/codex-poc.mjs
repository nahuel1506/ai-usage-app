
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { liveQuotaPoints } from './interaction-quota.mjs';
import { recordedQuotaPoints, readQuotaRecordings, recordingScope } from './quota-recordings.mjs';
import { prepareProjectIndex, readProjectFolders } from './projects.mjs';
import { openCodex } from './app-server.mjs';
import { applyExternalPricing } from './pricing.mjs';
import { readPricingCache, syncPricingCache } from './pricing-sync.mjs';
import { recentHistory } from './rollouts.mjs';
import { analyticsSummary, changesBetween, interactionSummary, reconcile, requestSummary } from './report.mjs';

const HELP = `node poc/codex-poc.mjs
node poc/codex-poc.mjs --watch --interval 90 [--samples 10]
Opciones adicionales: --hours 24, --codex RUTA_ABSOLUTA, --help`;

function numberInRange(value, name, min, max) {
  if (!/^\d+$/.test(value ?? '')) throw new Error(name + ' requiere un número entero.');
  const number = Number(value);
  if (number < min || number > max) throw new Error(name + ' admite de ' + min + ' a ' + max + '.');
  return number;
}

async function main() {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean' },
    watch: { type: 'boolean' },
    json: { type: 'boolean' },
    details: { type: 'boolean' },
    'question-previews': { type: 'boolean' },
    'session-view': { type: 'boolean' },
    'stop-on-stdin-close': { type: 'boolean' },
    interval: { type: 'string', default: '90' },
    samples: { type: 'string' },
    hours: { type: 'string', default: '24' },
    codex: { type: 'string' },
  } });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.samples && !values.watch) throw new Error('--samples requiere --watch.');
  const interval = numberInRange(values.interval, '--interval', 30, 3600);
  const samples = values.samples ? numberInRange(values.samples, '--samples', 1, 10000) : Infinity;
  const hours = numberInRange(values.hours, '--hours', 1, 168);
  if (values.codex && !isAbsolute(values.codex)) throw new Error('--codex requiere una ruta absoluta.');

  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  const executable = values.codex || (process.platform === 'win32' ? 'codex.exe' : 'codex');
  const dataFolder = join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'state'), 'AIUsageIntelligence');
  const recordingsFolder = join(dataFolder, 'poc');
  const pricingCachePath = join(dataFolder, 'pricing-cache.json');
  const cachedPricing = await readPricingCache(pricingCachePath);
  if (cachedPricing) applyExternalPricing(cachedPricing);
  void syncPricingCache(pricingCachePath).then(updated => { if (updated) applyExternalPricing(updated); });
  let nextPricingSyncAt = Date.now() + 24 * 60 * 60 * 1000;
  const salt = randomBytes(32);
  const workspace = values['session-view']
    ? { selected: null, cache: new Map(), recentCache: new Map(), headerCache: new Map() }
    : undefined;
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
  input?.on('line', line => {
    if (!values.watch) return;
    const session = /^session ([a-f0-9]{16})$/.exec(line)?.[1];
    if (session && workspace) workspace.selected = session;
    else if (line !== 'sample') return;
    pendingRefresh = true;
    delay?.abort();
  });
  input?.once('close', abort);

  let client;
  let output;
  let previous;
  let currentAccount;
  let accountScope = null;
  let recordings = [];
  const live = [];

  async function record(frame, interactionDetails, analytics) {

    if (output) {
      const stored = frame.type === 'sample' && accountScope ? { ...frame, accountScope } : frame;
      await appendFile(output, JSON.stringify(stored) + '\n', { mode: 0o600 });
    }
    const rendered = {
      ...frame,
      ...(interactionDetails ? { interactionDetails } : {}),
      ...(analytics ? { analytics } : {}),
    };
    console.log(values.watch || values.json ? JSON.stringify(rendered) : JSON.stringify(rendered, null, 2));
  }

  try {
    if (values.watch) {
      const folder = recordingsFolder;
      await mkdir(folder, { recursive: true, mode: 0o700 });
      output = join(folder, 'codex-' + randomUUID() + '.jsonl');
      console.error('Grabación local: ' + output);
    }
    for (let index = 0; index < (values.watch ? samples : 1) && !shutdown.signal.aborted; index++) {
      try {
        if (Date.now() >= nextPricingSyncAt) {
          nextPricingSyncAt = Date.now() + 24 * 60 * 60 * 1000;
          void syncPricingCache(pricingCachePath).then(updated => { if (updated) applyExternalPricing(updated); });
        }
        client ??= await openCodex(executable, home, Boolean(workspace));
        pendingRefresh = false;
        const current = await client.snapshot();
        if (currentAccount !== current.accountId) {
          currentAccount = current.accountId;
          accountScope = values.watch || values.details ? await recordingScope(dataFolder, currentAccount) : null;
          recordings = accountScope && values.details ? await readQuotaRecordings(recordingsFolder) : [];
          live.length = 0;
        }
        live.push(current);
        if (live.length > 20000) live.shift();
        if (workspace && current.accountId) {
          if (workspace.accountId !== current.accountId) {
            workspace.accountId = current.accountId;
            workspace.selected = null;
            workspace.projectIndex = undefined;
            workspace.projectRefreshAt = 0;
            workspace.cache.clear();
            workspace.recentCache?.clear();
            workspace.headerCache?.clear();
          }
          if (Date.now() >= workspace.projectRefreshAt) {
            try {
              const [catalog, folders] = await Promise.all([
                client.projectIndex(),
                readProjectFolders(join(dataFolder, 'project-folders.json')),
              ]);
              workspace.projectIndex = prepareProjectIndex(catalog, salt, folders);
              workspace.projectRefreshAt = Date.now() + 120000;
            } catch {
              workspace.projectRefreshAt = Date.now() + 30000;
            }
          }
        }
        const requested = workspace?.selected ?? null;
        const history = await recentHistory(home, current.accountId, salt, values.details && values['question-previews'],
          workspace ? { ...workspace, projectIndex: current.accountId ? workspace.projectIndex : undefined, selected: requested } : undefined);
        if (workspace) workspace.selected ??= history.selectedSession;
        const until = Date.parse(current.sample.observedAt);
        const since = until - hours * 3600000;
        const quotaPoints = [
          ...recordedQuotaPoints(recordings, accountScope, history),
          ...liveQuotaPoints(live, current.accountId),
        ];
        const details = values.details
          ? interactionSummary(history, since, until, quotaPoints, Boolean(workspace))
          : undefined;
        if (details && workspace) details.requestedSession = requested;
        await record({
          type: 'sample',
          quota: current.sample,
          accountComparable: Boolean(current.accountId),
          historyCoverage: history.coverage,
          tokenRecords: requestSummary(history, since, until),
          reconciliation: reconcile(current.sample, history),
          intervalStartedAt: previous?.sample.observedAt ?? null,
          changes: changesBetween(previous, current, history),
        }, details, analyticsSummary(history, until, 'codex', quotaPoints));
        previous = current;
      } catch (error) {
        if (!values.watch) throw error;
        await record({ type: 'collection-error', observedAt: new Date().toISOString(), source: 'codex-poc' });
        console.error(error.message);
        await client?.close();
        client = undefined;
        previous = undefined;
        live.length = 0;
        process.exitCode = 1;
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
    await client?.close();
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    input?.removeListener('close', abort);
    input?.close();
  }
}

main().catch(error => {
  // Errors raised by the transport are sanitized at the boundary.
  console.error(error.message);
  process.exitCode = 1;
});
