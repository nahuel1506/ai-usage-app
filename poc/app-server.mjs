
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const allowed = new Set(['initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'project/list', 'thread/list']);

function windowAt(pool, slot, row) {
  const used = row?.usedPercent ?? row?.used_percent;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;
  const duration = row.windowDurationMins ?? row.window_minutes;
  const reset = row.resetsAt ?? row.resets_at;
  return {
    pool,
    slot,
    minutes: Number.isSafeInteger(duration) && duration > 0 ? duration : null,
    usedPercent: used,
    resetsAt: Number.isSafeInteger(reset) && reset > 0 && reset < 253402300800
      ? new Date(reset * 1000).toISOString() : null,
  };
}

export function windowsFrom(result) {
  const pools = new Map();
  if (result?.rateLimits) {
    const id = result.rateLimits.limitId;
    pools.set(id || null, result.rateLimits);
  }
  for (const [key, row] of Object.entries(result?.rateLimitsByLimitId ?? {})) {
    if (row) pools.set(row.limitId || key, row);
  }
  if (pools.size > 1 && pools.has(null)) pools.delete(null);
  return [...pools].flatMap(([pool, row]) => [
    windowAt(pool, 'primary', row.primary),
    windowAt(pool, 'secondary', row.secondary),
  ].filter(Boolean));
}

export function windowsFromLog(row) {
  const pool = row.limit_id || null;
  return [windowAt(pool, 'primary', row.primary), windowAt(pool, 'secondary', row.secondary)].filter(Boolean);
}

export async function openCodex(executable, cwd, projects = false) {
  const child = spawn(executable, [
    '--disable', 'plugins', '--disable', 'remote_control',
    '-c', 'analytics.enabled=false', 'app-server', '--listen', 'stdio://',
  ], { cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let nextId = 0;
  const pending = new Map();
  let failure;
  let closed = false;
  const exited = new Promise(resolve => child.once('close', resolve));

  function fail(error) {
    failure = error;
    for (const entry of pending.values()) entry.reject(error);
  }
  child.on('error', error => fail(new Error('No se pudo iniciar Codex (' + error.code + ').')));
  child.stdin.on('error', () => fail(new Error('Se cerró la entrada del App Server.')));
  child.on('close', code => {
    closed = true;
    fail(new Error('El App Server terminó (' + code + ').'));
  });
  reader.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const entry = pending.get(message?.id);
    if (!entry || message.method) return;
    if (message.error) {
      const code = Number.isSafeInteger(message.error.code) ? ' (' + message.error.code + ')' : '';
      entry.reject(new Error(entry.method + ' devolvió un error RPC' + code + '.'));
    } else {
      entry.resolve(message.result);
    }
  });

  function send(method, params, id) {
    if (!allowed.has(method)) throw new Error('Método fuera de la prueba.');
    child.stdin.write(JSON.stringify({ method, ...(id === undefined ? {} : { id }), ...(params ? { params } : {}) }) + '\n');
  }

  function request(method, params) {
    if (failure) return Promise.reject(failure);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.get(id)?.reject(new Error('Tiempo de espera agotado en ' + method + '.'));
      }, 15000);
      const finish = callback => value => {
        clearTimeout(timer);
        pending.delete(id);
        callback(value);
      };
      pending.set(id, { method, resolve: finish(resolve), reject: finish(reject) });
      try { send(method, params, id); } catch (error) { pending.get(id)?.reject(error); }
    });
  }

  async function list(method, params) {
    const rows = [];
    const seenCursors = new Set();
    let cursor = null;
    do {
      const page = await request(method, { ...params, limit: 100, cursor });
      if (!Array.isArray(page?.data)) throw new Error('Respuesta de catálogo de Codex inválida.');
      rows.push(...page.data);
      cursor = typeof page.nextCursor === 'string' ? page.nextCursor : null;
      if (cursor && (seenCursors.has(cursor) || seenCursors.size >= 15)) break;
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return rows;
  }

  async function close() {
    if (closed) return;
    child.stdin.end();
    const timeout = setTimeout(() => child.kill(), 1500);
    try { await exited; } finally { clearTimeout(timeout); reader.close(); }
  }

  try {
    await request('initialize', {
      clientInfo: { name: 'ai_usage_intelligence_poc', version: '0.1.0' },
      ...(projects ? { capabilities: { experimentalApi: true } } : {}),
    });
    send('initialized', {});
    const details = await request('account/read', { refreshToken: false });
    const account = details?.account;
    if (!account || !['chatgpt', 'chatgptAuthTokens'].includes(account.type)) {
      throw new Error('La sesión local de Codex no reportó una cuenta ChatGPT compatible.');
    }
    return {
      close,
      async projectIndex() {
        const threadParams = { currentAccountOnly: true, useStateDbOnly: true };
        const [projects, current, archived] = await Promise.all([
          list('project/list'),
          list('thread/list', { ...threadParams, archived: false }).catch(() => []),
          list('thread/list', { ...threadParams, archived: true }).catch(() => []),
        ]);
        return { projects, threads: [...current, ...archived] };
      },
      async snapshot() {
        const started = Date.now();
        const result = await request('account/rateLimits/read');
        return {
          accountId: result?.accountId ?? null,
          sample: {
            source: 'codex-app-server',
            observedAt: new Date().toISOString(),
            readMs: Date.now() - started,
            plan: account.planType ?? null,
            windows: windowsFrom(result),
          },
        };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
