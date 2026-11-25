
import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdir, mkdtemp, rm, rmdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { prepareProjectIndex, projectPath, sessionProject } from './projects.mjs';
import { recordedQuotaPoints, readQuotaRecordings, recordingScope } from './quota-recordings.mjs';
import { windowsFrom } from './app-server.mjs';
import { analyticsSummary, changesBetween, interactionSummary, reconcile, requestSummary } from './report.mjs';
import { recentHistory, summarizeRollout } from './rollouts.mjs';
import { interactionQuota, liveQuotaPoints, quotaObservations } from './interaction-quota.mjs';

const at = seconds => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
const row = (usedPercent, resetsAt = at(60)) => ({ pool: 'codex', minutes: 300, usedPercent, resetsAt });
const sample = (seconds, window, accountId = 'test-account') => ({
  accountId, sample: { plan: 'plus', observedAt: at(seconds), windows: [window] },
});
const emptyHistory = { turns: new Map(), requests: new Map(), snapshots: [] };

test('cuenta tokens de caché una sola vez y conserva la cobertura de los totales', () => {
  const usage = [
    { input_tokens: 100, cached_input_tokens: 70, output_tokens: 20 },
    { input_tokens: 100, cached_input_tokens: 70, output_tokens: 20, total_tokens: 122 },
    { input_tokens: 100 },
  ];
  const history = { ...emptyHistory, requests: new Map(usage.map((value, i) => [i, {
    time: Date.parse(at(i + 1)), scope: 'same', usage: value,
  }])) };
  for (const [provider, expected] of [['codex', 242], ['antigravity', 312]]) {
    const { sameAccount } = requestSummary(history, Date.parse(at(0)), Date.parse(at(10)), provider);
    assert.equal(sameAccount.tokensObserved, expected);
    assert.equal(sameAccount.tokenSamples, 2);
  }
});

test('estima un rango con prompts aislados del plan actual y excluye envíos combinados', () => {
  const history = { turns: new Map(), requests: new Map(), snapshots: [] };
  for (let i = 1, used = 0; i <= 10; i++) {
    const start = i * 250;
    const plan = i === 1 ? 'old-plan' : 'plus';
    const time = offset => Date.parse(at(start + offset));
    const key = String(i);
    const messages = new Map([['first', { time: time(0) }]]);
    if (i === 2) messages.set('second', { time: time(1) });
    history.turns.set(key, { key, scope: 'same', composer: true, messages,
      started: time(0), ended: time(10), first: time(2), last: time(8) });
    history.requests.set(key, { turn: key, scope: 'same', time: time(8), usage: { input_tokens: 100 } });
    for (const [offset, usedPercent] of [[-1, used], [11, used + i]]) {
      history.snapshots.push({ ...row(usedPercent, at(3000)), time: time(offset),
        source: 'app-server', scope: 'same', plan });
    }
    used += i;
  }
  const analytics = analyticsSummary(history, Date.parse(at(2800)));
  assert.deepEqual(analytics.promptQuota, [{ pool: 'codex', minutes: 300, count: 8, typical: 6.5, low: 4.75, high: 8.25 }]);
});

test('cuotas por pool deduplican la copia principal y mantienen las ventanas devueltas', () => {
  const primary = { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1767225660 };
  const limit = { limitId: 'codex', primary };
  assert.deepEqual(windowsFrom({rateLimits: limit, rateLimitsByLimitId: { codex: limit }}), [{
    pool: 'codex', slot: 'primary', minutes: 10080, usedPercent: 0, resetsAt: at(60),
  }]);
});

test('reconciliación exige cuenta, pool, duración y reinicio en común', () => {
  const snapshots = [
    { ...row(2), scope: 'same', time: Date.parse(at(5)) },
    { ...row(99), scope: 'unverified', time: Date.parse(at(9)) },
    { ...row(99, at(57)), scope: 'same', time: Date.parse(at(9)) },
  ];
  const result = reconcile(sample(10, row(4)).sample, { snapshots });
  assert.equal(result[0].historical.differencePp, 2);
  assert.equal(reconcile(sample(4, row(4)).sample, { snapshots })[0].historical, null);
});

test('aumento simultáneo queda sin asignar incluso si hay un candidato identificable', () => {
  const turns = new Map([
    ['a', { key: 'a', scope: 'same', started: Date.parse(at(3)), ended: null }],
    ['b', { key: 'b', scope: 'unverified', first: Date.parse(at(13)), started: null, ended: null }],
  ]);
  const changes = changesBetween(sample(10, row(1)), sample(20, row(7)), { turns });
  assert.equal(changes[0].deltaPp, 6);
  assert.equal(changes[0].attribution, 'unassigned');
  assert.equal(changes[0].candidateTurns.length, 2);
});

test('reinicio, retroceso y cambios de cuenta no generan consumo', () => {
  const previous = sample(10, row(7));
  for (const current of [sample(20, row(8, at(70))), sample(20, row(5))]) {
    assert.equal(changesBetween(previous, current, emptyHistory)[0].status, 'discontinuity');
  }
  assert.deepEqual(changesBetween(previous, sample(20, row(8), 'another-account'), emptyHistory), []);
});

test('solicitudes deduplicadas; ausencias quedan fuera de la suma y de la cobertura', () => {
  const meta = JSON.stringify({type: 'session_meta', payload: {id:'thread-a', creator_account_id: 'account-a'}});
  const record = (seconds, id, usage) => JSON.stringify({type:'token_usage_record', timestamp:at(seconds),
    payload:{turn_id:'turn-a', response_id:id, usage, thread_token_usage:{input_tokens:999}}});
  const history = summarizeRollout([meta], [
    record(2, 'req-a', { input_tokens: 8, cached_input_tokens: 0 }),
    record(2, 'req-a', { input_tokens: 8 }),
    record(3, 'req-b', { input_tokens: 5 }),
    record(4, null, { input_tokens: 10 }),
    '{',
  ], 'account-a', Buffer.alloc(32));
  const summary = requestSummary(history, Date.parse(at(0)), Date.parse(at(4)));
  assert.deepEqual(summary.sameAccount.observedCounts, { input_tokens: 13, cached_input_tokens: 0 });
  assert.deepEqual(summary.sameAccount.fieldCoverage, { input_tokens: 2, cached_input_tokens: 1 });
  assert.equal(history.malformed, 1);
  assert.equal(history.omittedRequests, 1);
  assert.equal(summary.sameAccount.observedRequests, 2);
});


test('una variación de un segundo en el reinicio futuro conserva la ventana', () => {
  const previous = sample(10, row(1, at(60)));
  const current = sample(20, row(2, at(61)));
  assert.equal(changesBetween(previous, current, emptyHistory)[0].deltaPp, 1);
});

test('el detalle de interacción presenta solicitudes de la cuenta verificada, sin texto de conversación', () => {
  const line = (type, seconds, payload) => JSON.stringify({ type, timestamp: at(seconds), payload });
  const meta = line('session_meta', 0, { id: 'thread-a', creator_account_id: 'account-a' });
  const context = line('turn_context', 2, { turn_id: 'turn-a', model: 'gpt-6.2-sol', effort: 'low', summary: 'private text' });
  const request = line('token_usage_record', 4, { turn_id: 'turn-a', response_id: 'req-a', usage: { input_tokens: 12 } });
  const end = line('event_msg', 5, { type: 'task_complete', turn_id: 'turn-a', duration_ms: 3000, last_agent_message: 'private text' });
  const late = line('token_usage_record', 10, { turn_id: 'turn-a', response_id: 'req-late', usage: { input_tokens: 1 } });
  const result = summarizeRollout([meta], [context, request, request, end, late], 'account-a', Buffer.alloc(32));
  const detail = interactionSummary(result, Date.parse(at(0)), Date.parse(at(7)));
  assert.equal(detail.observedTurns, 1);
  const [turn] = detail.turns;
  assert.deepEqual(turn.configuredModels, ['gpt-6.2-sol']);
  assert.deepEqual(turn.reasoningEfforts, ['low']);
  assert.equal(turn.durationMs, 3000);
  assert.equal(turn.status, 'completed');
  assert.equal(turn.observedRequests, 1);
  assert.deepEqual(turn.requests, [{ at: at(4), usage: { input_tokens: 12 }, costUsd: 0.000024, tier: 'standard', contextTokens: 12 }]);
  assert.doesNotMatch(JSON.stringify(detail), /private text|thread-a|account-a|req-a/);
  assert.equal(interactionSummary(result, Date.parse(at(0)), Date.parse(at(4))).turns[0].status, 'end-unobserved');
  const unverified = summarizeRollout([meta], [context, request, end], null, Buffer.alloc(32));
  assert.equal(interactionSummary(unverified, Date.parse(at(0)), Date.parse(at(7))).observedTurns, 0);
});

function impactFixture(options = {}) {
  const observed = (seconds, usage, extra) => ({
    ...row(usage, at(600)), time: Date.parse(at(seconds)), scope: 'same', source: 'rollout', ...extra,
  });
  const turn = {
    reference: 'a', startedAt: at(10), endedAt: at(20), firstRequest: Date.parse(at(13)), lastRequest: Date.parse(at(19)),
    ...options.turn,
  };
  const history = {
    snapshots: options.snapshots?.(observed) ?? [
      observed(8, 9), observed(13, 10), observed(21, 11),
      observed(8, 20, { minutes: 10080 }), observed(22, 20, { minutes: 10080 }),
    ],
    turns: new Map((options.others ?? []).map(other => [other.key, other])),
  };
  const series = quotaObservations(history, options.live ?? [], Date.parse(at(30)));
  return interactionQuota(series, turn, history);
}

test('mide puntos porcentuales por ventana y conserva las lecturas exactas', () => {
  const [short, week] = impactFixture();
  assert.equal(short.status, 'observed');
  assert.equal(short.deltaPp, 2);
  assert.equal(short.before.at, at(8));
  assert.equal(short.after.at, at(21));
  assert.equal(week.deltaPp, 0);
});

test('un intervalo con otro turno queda sin repartir', () => {
  const [short] = impactFixture({ others: [{key:'b', started:Date.parse(at(15)), ended:Date.parse(at(22))}] });
  assert.equal(short.status, 'shared');
  assert.equal(short.deltaPp, 2);
  assert.equal(short.otherTurns, 1);
});

test('el turno abierto muestra un intervalo parcial, aun si la cuenta se consultó después', () => {
  const [short] = impactFixture({ turn: { endedAt: null } });
  assert.equal(short.status, 'partial');
  assert.equal(short.hasEnd, false);
  assert.equal(short.deltaPp, 2);
});

test('rechaza reinicios, descensos y lecturas no verificadas', () => {
  for (const snapshots of [
    add => [add(8, 9), add(21, 10, { resetsAt: at(590) })],
    add => [add(8, 9), add(21, 8)],
  ]) assert.equal(impactFixture({ snapshots })[0].status, 'discontinuity');
  const [short] = impactFixture({ snapshots: add => [add(8, 9, { scope: 'unverified' }), add(21, 11)] });
  assert.equal(short.status, 'unavailable');
  assert.equal(short.deltaPp, null);
});

test('prioriza la lectura oficial posterior más reciente y separa cuentas', () => {
  const captures = [
    sample(22, row(11, at(600))),
    sample(25, row(12, at(601))),
    sample(26, row(99, at(600)), 'another-account'),
  ];
  const live = liveQuotaPoints(captures, 'test-account');
  const [short] = impactFixture({ live });
  assert.equal(short.after.at, at(25));
  assert.equal(short.after.source, 'app-server');
  assert.equal(short.deltaPp, 3);
});


test('usa la lectura posterior anterior a la siguiente pregunta cuando está disponible', () => {
  const live = liveQuotaPoints([
    sample(25, row(13, at(600))),
  ], 'test-account');
  const [short] = impactFixture({
    live, others: [{key:'b', started:Date.parse(at(24)), ended:Date.parse(at(27))}],
  });
  assert.equal(short.after.at, at(21));
  assert.equal(short.status, 'observed');
  assert.equal(short.deltaPp, 2);
});

test('actualiza la baja cuando aparece una lectura posterior a la consulta oficial', () => {
  const live = liveQuotaPoints([sample(22, row(11, at(600)))], 'test-account');
  const [impact] = impactFixture({
    live, snapshots: add => [add(8, 9), add(24, 12)],
  });
  assert.equal(impact.after.at, at(24));
  assert.equal(impact.deltaPp, 3);
});

test('Antigravity conserva la baja neta aunque fluctúen lecturas oficiales de la misma ventana', () => {
  const agy = { source: 'agy-cli' };
  const [impact] = impactFixture({ snapshots: add => [
    add(8, 36.4808, agy), add(13, 35.6112, agy), add(21, 41.3108, agy),
  ] });
  assert.equal(impact.status, 'observed');
  assert.equal(impact.deltaPp, 4.83);
  assert.equal(impact.fluctuated, true);

  const [reset] = impactFixture({ snapshots: add => [
    add(8, 36.4808, agy), add(13, 35.6112, agy), add(21, 41.3108, { ...agy, resetsAt: at(900) }),
  ] });
  assert.equal(reset.status, 'discontinuity');
  assert.equal(reset.deltaPp, null);
});

test('si ya empezó otra pregunta, usa la lectura posterior más cercana al cierre', () => {
  const live = liveQuotaPoints([
    sample(23, row(12, at(600))), sample(26, row(16, at(600))),
  ], 'test-account');
  const [impact] = impactFixture({
    live, snapshots: add => [add(8, 9)],
    others: [{ key: 'b', started: Date.parse(at(21)), ended: Date.parse(at(27)) }],
  });
  assert.equal(impact.after.at, at(23));
  assert.equal(impact.status, 'shared');
  assert.equal(impact.deltaPp, 3);
});

test('resume bloques de 5 horas y semanas reales por chat, sin duplicar bajas compartidas ni reinicios', () => {
  const turn = (key, started, ended, session = 'chat-a', composer = true) => ({
    key, session, composer, scope: 'same', started: Date.parse(at(started)), ended: Date.parse(at(ended)),
    first: Date.parse(at(started + 1)), last: Date.parse(at(ended - 1)),
  });
  const turns = [
    turn('first', 100, 120),
    turn('shared', 700, 730),
    turn('other-chat', 715, 750, 'chat-b'),
    turn('crosses-reset', 17990, 18015),
    turn('automatic', 18200, 18220, 'chat-a', false),
    turn('next-week', 32000, 32020),
    turn('idle-short-window', 36100, 36120),
  ];
  const snapshots = [
    [95,     0, 18000, 10], [125,   70, 18001, 20],
    [695,   70, 18000, 20], [735,   98, 18001, 40],
    [17985, 98, 18000, 55], [17995, 99, 18001, 56],
    [18002,  1, 36000, 57], [18020,  3, 36000, 58],
    [18195,  3, 36000, 58], [18225, 24, 36000, 62],
    [31995, 25, 36000,  1], [32025, 30, 36000,  4],
    [36095,  0, 54095,  4], [36125,  0, 54125,  6],
  ].flatMap(([time, short, reset, weekly]) => [
    row(short, at(reset)),
    { ...row(weekly, at(time < 30000 ? 30500 : 634800)), minutes: 10080 },
  ].map(window => ({ ...window, time: Date.parse(at(time)), scope: 'same', source: 'rollout' })));
  const history = {
    selectedSession: 'chat-a', sessionCatalog: [{ reference: 'chat-a' }], snapshots,
    turns: new Map(turns.map(t => [t.key, t])),
    requests: new Map(turns.map(t => [t.key, { turn: t.key, time: t.last, scope: 'same', usage: { input_tokens: 1 } }])),
  };
  const { sessionQuotaHistory: summary } = interactionSummary(history, Date.parse(at(300)), Date.parse(at(37000)), [], true);
  assert.deepEqual(summary.blocks.map(block => [
    block.startsAt, block.resetsAt, block.short.deltaPp, block.short.measured, block.short.partial,
    block.weekly.map(part => part.deltaPp),
  ]), [
    [at(18000), at(36000), 28, 3, 1, [5, 3]],
    [at(0), at(18000), 71, 2, 1, [11]],
  ]);
  assert.deepEqual(summary.weeks.map(week => [week.active, week.deltaPp]), [[true, 5], [false, 17]]);
  assert.equal(summary.weeks[1].endsAt, summary.weeks[0].startsAt);

  const buckets = [{ pool: 'gemini', minutes: 300 }, { pool: 'gemini', minutes: 10080 }, { pool: 'claude_gpt', minutes: 300 }];
  const agHistory = { ...history, snapshots: snapshots.map(point => ({ ...point, pool: 'gemini' })) };
  const ag = interactionSummary(agHistory, 0, Date.parse(at(37000)), [], true, { buckets });
  assert.deepEqual(ag.sessionQuotaHistory.blocks.map(block => [block.pool, block.short.deltaPp]), [['gemini', 28], ['gemini', 71]]);
});


test('una pregunta agrupa llamadas propias y delegadas sin convertirlas en otros envíos', () => {
  const line = (type, seconds, payload) => JSON.stringify({ type, timestamp: at(seconds), payload });
  const head = id => [line('session_meta', 0, { id, creator_account_id: 'account-a' })];
  const begin = (seconds, turn, root, trigger, parent) => line('event_msg', seconds, {
    type: 'task_started', turn_id: turn, root_turn_id: root,
    turn_attribution: { turn_trigger: trigger, parent_turn_id: parent },
  });
  const user = (seconds, kind, provenance, value) => line('response_item', seconds, {
    type: 'message', role: 'user', id: 'id-' + seconds,
    content: [{ type: 'input_text', text: value }],
    internal_chat_message_metadata_passthrough: {
      turn_id: 'main', content_item_kinds: [kind], content_item_metadata: [{ provenance: { type: provenance } }],
    },
  });
  const request = (seconds, turn, root) => line('token_usage_record', seconds, {
    turn_id: turn, root_turn_id: root, response_id: 'req-' + seconds, usage: { input_tokens: 100 },
  });
  const end = (seconds, turn) => line('event_msg', seconds, { type: 'task_complete', turn_id: turn });
  const salt = Buffer.alloc(32);
  const main = summarizeRollout(head('thread-a'), [
    begin(10, 'main', 'main', 'composer'),
    user(11, 'environments.environment_context', 'harness', 'contexto interno'),
    user(12, 'user.text', 'user', 'Una pregunta real'),
    request(13, 'main', 'main'), request(16, 'main', 'main'),
    user(17, 'user.text', 'user', 'Aclaración'), end(19, 'main'),
  ], 'account-a', salt, true);
  const child = summarizeRollout(head('thread-b'), [
    begin(14, 'child', 'main', 'agent', 'main'), request(18, 'child', 'main'), end(20, 'child'),
  ], 'account-a', salt);
  const unknown = summarizeRollout(head('thread-c'), [
    request(23, 'separate', 'separate'), end(25, 'separate'),
  ], 'account-a', salt);
  const history = {
    turns: new Map([...main.turns, ...child.turns, ...unknown.turns]),
    requests: new Map([...main.requests, ...child.requests, ...unknown.requests]),
    snapshots: [8, 21].map((seconds, index) => ({
      ...row(10 + index * 2, at(600)), time: Date.parse(at(seconds)), scope: 'same', source: 'rollout',
    })),
  };
  const result = interactionSummary(history, Date.parse(at(0)), Date.parse(at(30)));
  assert.equal(result.observedQuestions, 1);
  assert.equal(result.observedOtherTurns, 1);
  const [question, other] = result.turns;
  assert.equal(question.promptPreview, 'Una pregunta real');
  assert.equal(question.messageCount, 2);
  assert.equal(question.sentAt, at(12));
  assert.equal(question.endedAt, at(20));
  assert.equal(question.observedRequests, 3);
  assert.equal(question.additionalRequests, 2);
  assert.equal(question.childRequests, 1);
  assert.deepEqual(question.requests.map(r => r.kind), ['first', 'followup', 'related']);
  assert.equal(question.quota[0].status, 'observed');
  assert.equal(question.quota[0].otherTurns, 0);
  assert.equal(question.quota[0].deltaPp, 2);
  assert.equal(other.kind, 'other');
  assert.doesNotMatch(JSON.stringify(result), /contexto interno|Aclaración|thread-a/);
});

test('la sesión elegida recupera mensajes fuera de la cola, procesa anexos y separa otros chats', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ai-usage-session-test-'));
  try {
    const sessions = join(home, 'sessions');
    const archives = join(home, 'archived_sessions');
    await mkdir(sessions);
    await mkdir(archives);
    const file = join(sessions, 'rollout-first.jsonl');
    const archive = join(archives, 'rollout-second.jsonl.zst');
    const line = (type, seconds, payload) => JSON.stringify({ type, timestamp: at(seconds), payload });
    const header = id => line('session_meta', -200000, { id, creator_account_id: 'account' });
    const question = (start, id) => [
      line('event_msg', start, { type:'task_started', turn_id:id, root_turn_id:id, turn_attribution:{ turn_trigger:'composer' } }),
      line('token_usage_record', start+1, { turn_id:id, root_turn_id:id, response_id:'res-'+id, usage:{ input_tokens:3 } }),
      line('event_msg', start+2, { type:'task_complete', turn_id:id }),
    ];
    await writeFile(archive, zstdCompressSync(Buffer.from([header('archive'), ...question(-100, 'archive-turn')].join('\n')+'\n')));
    await utimes(archive, new Date(0), new Date(0));
    const last = question(12, 'last');
    await writeFile(file, [header('active'), ...question(-100000, 'old'),
      line('ignored', -90000, { padding:'a'.repeat(2.1 * 1024 * 1024) }),
      ...last.slice(0, 2)].join('\n')+'\n'+last[2].slice(0,15));
    const opts = { selected: null, cache: new Map() };
    const collect = async () => {
      const history = await recentHistory(home, 'account', Buffer.alloc(32), false, opts);
      return interactionSummary(history, Date.parse(at(0)), Date.parse(at(90)), [], true);
    };

    const first = await collect();
    assert.equal(first.sessions.length, 2);
    assert.equal(first.observedQuestions, 2);
    assert.equal(first.turns[0].status, 'end-unobserved');
    assert.equal(first.turns[1].sentAt, at(-100000));
    await appendFile(file, last[2].slice(15)+'\n');
    const updated = await collect();
    assert.equal(updated.observedQuestions, 2);
    assert.equal(updated.turns[0].status, 'completed');

    opts.selected = updated.sessions.find(session => session.reference !== updated.selectedSession).reference;
    const switched = await collect();
    assert.equal(switched.selectedSession, opts.selected);
    assert.equal(switched.observedQuestions, 1);
    assert.equal(switched.turns[0].sentAt, at(-100));

    opts.selected = null;
    opts.projectIndex = prepareProjectIndex({ projects: [], threads: [
      { id: 'active', updatedAt: Date.parse(at(15)) / 1000 },
      { id: 'archive', updatedAt: Date.parse(at(20)) / 1000 },
    ] }, Buffer.alloc(32));
    const ordered = await collect();
    assert.equal(ordered.sessions[0].reference, switched.selectedSession);
    assert.equal(ordered.selectedSession, switched.selectedSession);
  } finally {
    await rm(join(home, 'sessions', 'rollout-first.jsonl'), { force: true });
    await rm(join(home, 'archived_sessions', 'rollout-second.jsonl.zst'), { force: true });
    for (const folder of [join(home, 'sessions'), join(home, 'archived_sessions'), home])
      await rmdir(folder).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('agrupa por el proyecto de Codex y solo usa una carpeta raíz inequívoca como respaldo', () => {
  const data = {
    projects: [
      { id: 'p1', name: 'Principal', roots: [{path:'C:/Trabajo'}] },
      { id: 'p2', name: 'Subproyecto', roots: [{path:'C:/Trabajo/Sub'}] },
      { id: 'p3', name: 'Duplicado A', roots: [{path:'C:/Compartido'}] },
      { id: 'p4', name: 'Duplicado B', roots: [{path:'C:/Compartido/'}] },
    ],
    threads: [
      { id:'native', name:'Nombre en Codex', projectId:'p1', cwd:'C:/Trabajo/Sub', path:'C:/datos/rollout.jsonl' },
      { id:'legacy', projectId:null, cwd:'\\\\?\\C:\\TRABAJO\\Sub\\Codigo' },
      { id:'removed', projectId:'unknown', cwd:'C:/Trabajo/Sub' },
    ],
  };
  const index = prepareProjectIndex(data, Buffer.alloc(32));
  assert.equal(projectPath('\\\\?\\UNC\\Servidor\\Share\\Folder'), '\\\\servidor\\share\\folder');
  assert.equal(index.files.has(projectPath('\\\\?\\C:\\DATOS\\rollout.jsonl')), true);
  assert.deepEqual(sessionProject(index, 'native'), {
    nativeTitle:'Nombre en Codex', projectReference:index.projects.get('p1').reference, projectSource:'codex',
  });
  assert.equal(sessionProject(index, 'legacy').projectReference, index.projects.get('p2').reference);
  assert.equal(sessionProject(index, 'legacy').projectSource, 'folder');
  assert.equal(sessionProject(index, 'removed').projectReference, undefined);
  assert.equal(sessionProject(index, 'missing', 'C:/TrabajoAux').projectReference, undefined);
  assert.equal(sessionProject(index, 'missing', 'C:/Compartido/Otro').projectReference, undefined);
});


test('vincula carpetas movidas y agrupa carpetas históricas sin cambiar asignaciones nativas', () => {
  const data = {
    projects: [
      { id:'tools', name:'Herramientas', roots:[{path:'C:/Actual'}] },
      { id:'other', name:'Otro', roots:[{path:'C:/Otro'}] },
    ],
    threads: [
      {id:'moved', cwd:'C:/Antigua'},
      {id:'legacy', cwd:'C:/SKILLS/Subcarpeta'},
      {id:'native', cwd:'C:/Antigua', projectId:'other'},
    ],
  };
  const index = prepareProjectIndex(data, Buffer.alloc(32), {
    aliases:[{from:'C:/Antigua', to:'C:/Actual'}],
    groups:[{name:'SKILLS',root:'C:/SKILLS'}],
  });
  assert.equal(sessionProject(index, 'moved').projectReference, index.projects.get('tools').reference);
  assert.equal(sessionProject(index, 'moved').projectSource, 'folder-alias');
  assert.equal(sessionProject(index, 'legacy').projectReference, index.projectList.find(item => item.local).reference);
  assert.equal(sessionProject(index, 'legacy').projectSource, 'local-folder');
  assert.equal(sessionProject(index, 'native').projectReference, index.projects.get('other').reference);
});

test('recupera una lectura anterior de la misma cuenta aunque se reinicie el monitor', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ai-usage-recording-test-'));
  const file = join(folder, 'codex-0123.jsonl');
  try {
    const scope = await recordingScope(folder, 'account-a');
    const other = await recordingScope(folder, 'account-b');
    assert.equal(await recordingScope(folder, 'account-a'), scope);
    assert.notEqual(scope, other);
    const window = row(22, at(600));
    const capture = (observedAt, accountScope) => ({
      type:'sample', accountScope, quota:{source:'codex-app-server', observedAt, windows:[window], plan:'plus'},
    });
    await writeFile(file, [capture(at(8), scope), capture(at(9), other), '{'].map(item =>
      typeof item === 'string' ? item : JSON.stringify(item)).join('\n'));
    const loaded = await readQuotaRecordings(folder);
    const points = recordedQuotaPoints(loaded, scope, {snapshots:[]});
    assert.equal(points.length, 1);
    assert.equal(points[0].time, Date.parse(at(8)));
    assert.equal(points[0].recorded, true);
    const [result] = impactFixture({ live:points, snapshots:add => [add(21, 25)] });
    assert.equal(result.status, 'observed');
    assert.equal(result.deltaPp, 3);
    assert.equal(result.before.recorded, true);
  } finally {
    await rm(file, { force:true });
    await rm(join(folder, 'quota-scope.key'), { force:true });
    await rmdir(folder);
  }
});

test('una grabación anterior sin identificador solo se reutiliza si coincide en ambas ventanas verificadas', () => {
  const reset = at(600);
  const recordedTime = Date.parse(at(9));
  const observed = [300, 10080].map(minutes => ({
    ...row(20, reset), minutes, time:Date.parse(at(5)), scope:'same',
  }));
  const legacy = {
    time:recordedTime, accountComparable:true,
    quota:{windows:observed.map(row => ({...row,usedPercent:21}))},
    reconciliation:observed.map(row => ({
      pool:row.pool, minutes:row.minutes,
      historical:{source:'codex-rollout', observedAt:at(5), resetsAt:reset, usedPercent:row.usedPercent},
    })),
  };
  assert.equal(recordedQuotaPoints([legacy], 'account-scope', {snapshots:observed}).length, 2);
  assert.equal(recordedQuotaPoints([legacy], 'account-scope', {snapshots:observed.slice(0,1)}).length, 0);
  assert.equal(recordedQuotaPoints([{...legacy,accountScope:'another-account'}], 'account-scope', {snapshots:observed}).length, 0);
});

test('un registro local que llega con retraso no invalida dos lecturas comparables del servidor', () => {
  const live = liveQuotaPoints([sample(8, row(10, at(600))), sample(22, row(12, at(600)))], 'test-account');
  const [impact] = impactFixture({ live, snapshots:add => [add(12, 9), add(19, 10)] });
  assert.equal(impact.status, 'observed');
  assert.equal(impact.deltaPp, 2);
});

test('detecta mensajes de usuario sin content_item_metadata, envíos en medio de un turno activo y plan semanal único', async () => {
  const line = (type, seconds, payload) => JSON.stringify({ type, timestamp: at(seconds), payload });
  const head = [line('session_meta', 0, { id: 'thread-steer', creator_account_id: 'account-a' })];
  const parsed = summarizeRollout(head, [
    line('event_msg', 10, { type: 'task_started', turn_id: 't1', root_turn_id: 't1', turn_attribution: { turn_trigger: 'composer' } }),
    line('response_item', 11, {
      type: 'message', role: 'user', id: 'm1',
      content: [{ type: 'input_text', text: 'Primer mensaje sin metadata' }],
      internal_chat_message_metadata_passthrough: { turn_id: 't1', content_item_kinds: ['user.text'] },
    }),
    line('token_usage_record', 12, { turn_id: 't1', response_id: 'r1', usage: { input_tokens: 50, output_tokens: 10 } }),
    line('event_msg', 14, { type: 'user_message', id: 'm2', message: 'Mensaje en medio del turno activo' }),
    line('token_usage_record', 16, { turn_id: 't1', response_id: 'r2', usage: { input_tokens: 80, output_tokens: 20 } }),
    line('event_msg', 18, { type: 'task_complete', turn_id: 't1' }),
  ], 'account-a', Buffer.alloc(32), true);
  const det = interactionSummary(parsed, Date.parse(at(0)), Date.parse(at(30)), [], false);
  assert.equal(det.observedQuestions, 1);
  assert.equal(det.turns[0].promptPreview, 'Primer mensaje sin metadata');
  assert.equal(det.turns[0].messageCount, 2);
  assert.equal(det.turns[0].observedRequests, 2);

  // Weekly-only legacy recording should verify against the weekly window when 5h is absent
  const reset = at(600);
  const weekObs = [{ ...row(20, reset), minutes: 10080, time: Date.parse(at(5)), scope: 'same' }];
  const legacyWeeklyOnly = {
    time: Date.parse(at(9)), accountComparable: true,
    quota: { windows: [{ ...row(21, reset), minutes: 10080 }] },
    reconciliation: [{
      pool: 'codex', minutes: 10080,
      historical: { source: 'codex-rollout', observedAt: at(5), resetsAt: reset, usedPercent: 20 },
    }],
  };
  assert.equal(recordedQuotaPoints([legacyWeeklyOnly], 'account-scope', { snapshots: weekObs }).length, 1);

  // Incremental cache detects appended bytes even when mtime stays identical (Windows NTFS behavior)
  const home = await mkdtemp(join(tmpdir(), 'ai-usage-mtime-test-'));
  try {
    const sessions = join(home, 'sessions');
    await mkdir(sessions);
    const file = join(sessions, 'rollout-live.jsonl');
    const stamp = new Date(Date.UTC(2026, 5, 1, 12, 0, 0));
    await writeFile(file, [
      head[0],
      line('event_msg', 10, { type: 'task_started', turn_id: 't1', turn_attribution: { turn_trigger: 'composer' } }),
      line('token_usage_record', 12, { turn_id: 't1', response_id: 'r1', usage: { input_tokens: 10 } }),
    ].join('\n') + '\n');
    await utimes(file, stamp, stamp);
    const ws = { selected: null, cache: new Map(), recentCache: new Map(), headerCache: new Map() };
    const h1 = await recentHistory(home, 'account-a', Buffer.alloc(32), true, ws);
    assert.equal(h1.requests.size, 1);

    await appendFile(file, [
      line('event_msg', 14, { type: 'user_message', id: 'm2', message: 'Aclaración en vivo' }),
      line('token_usage_record', 15, { turn_id: 't1', response_id: 'r2', usage: { input_tokens: 20 } }),
    ].join('\n') + '\n');
    await utimes(file, stamp, stamp); // Force identical mtime with larger size
    const h2 = await recentHistory(home, 'account-a', Buffer.alloc(32), true, ws);
    assert.equal(h2.requests.size, 2);
    const [turn] = [...h2.turns.values()];
    assert.equal(turn.messages.size, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
