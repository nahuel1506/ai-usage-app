import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  decodeFields,
  modelLabelFromEnum,
  parseStepMetadata,
  parseTrajectoryMeta,
  parseUserPreview,
} from './antigravity-proto.mjs';
import { readConversationDb, recentAntigravityHistory } from './antigravity-db.mjs';
import { parseAgyUsageJson } from './antigravity-cli.mjs';
import { analyticsSummary, interactionSummary } from './report.mjs';

function encodeVarint(num) {
  let n = BigInt(num);
  const out = [];
  while (n >= 0x80n) {
    out.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(out);
}

function fVarint(field, val) {
  return Buffer.concat([encodeVarint((field << 3) | 0), encodeVarint(val)]);
}

function fBytes(field, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(buf.length), buf]);
}

function fTimestamp(field, sec, nanos = 0) {
  return fBytes(field, Buffer.concat([fVarint(1, sec), fVarint(2, nanos)]));
}

test('decodifica campos Protobuf de Antigravity (metadatos, uso de tokens y preview)', () => {
  const ws = Buffer.concat([
    fBytes(1, 'file:///c:/Users/test/Desktop/MiProyecto'),
    fBytes(3, fBytes(1, 'org/MiProyecto')),
    fBytes(4, 'main'),
  ]);
  const trajBlob = Buffer.concat([
    fBytes(1, ws),
    fTimestamp(2, 1795000000, 500_000_000),
    fBytes(6, 'conv-123'),
  ]);
  const meta = parseTrajectoryMeta(trajBlob);
  assert.equal(meta.cascadeId, 'conv-123');
  assert.equal(meta.workspaceName, 'MiProyecto');
  assert.equal(meta.startedAtMs, 1795000000500);

  const usageBlob = Buffer.concat([
    fVarint(1, 1533),
    fVarint(2, 2400),
    fVarint(3, 650),
    fVarint(5, 120000),
    fBytes(7, 'bot-msg-1'),
    fVarint(9, 400),
    fVarint(10, 250),
  ]);
  const stepMeta = Buffer.concat([
    fTimestamp(1, 1795000010, 0),
    fTimestamp(8, 1795000015, 0),
    fBytes(9, usageBlob),
    fVarint(11, 1533),
    fBytes(12, 'turn-abc'),
  ]);
  const parsed = parseStepMetadata(stepMeta);
  assert.equal(parsed.model, 'Gemini 4 Neon (Medium)');
  assert.equal(parsed.turnId, 'turn-abc');
  assert.equal(parsed.createdAtMs, 1795000010000);
  assert.equal(parsed.completedAtMs, 1795000015000);
  assert.deepEqual(parsed.usage.counts, {
    input_tokens: 2400,
    cached_input_tokens: 120000,
    output_tokens: 650,
    reasoning_output_tokens: 400,
    visible_output_tokens: 250,
  });

  const payload = fBytes(19, fBytes(2, 'Hola   mundo\ncon   espacios'));
  assert.equal(parseUserPreview(payload), 'Hola mundo con espacios');
  assert.equal(modelLabelFromEnum(1532), 'Gemini 4 Neon (High)');
  assert.equal(modelLabelFromEnum(1999), 'MODEL_M999');
  assert.ok(decodeFields(trajBlob).length >= 3);
});

test('lee SQLite de Antigravity, agrupa turnos por turn_id, deduplica llamadas y usa caché', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ag-test-'));
  const convDir = join(root, 'conversations');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(convDir, { recursive: true });
  const dbPath = join(convDir, 'sample-conv.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
    CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
  `);
  db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, 1, 1)').run('traj-1', 'cascade-1');
  const trajBlob = Buffer.concat([
    fBytes(1, fBytes(1, 'file:///c:/dev/demo-repo')),
    fTimestamp(2, 1795000000),
    fBytes(6, 'cascade-1'),
  ]);
  db.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', trajBlob);

  // USER_INPUT step 0
  const userMeta = Buffer.concat([fTimestamp(1, 1795000010), fBytes(12, 'turn-1')]);
  const userPayload = fBytes(19, fBytes(2, 'Explicame la arquitectura'));
  db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(0, 14, 3, userMeta, userPayload);

  // PLANNER_RESPONSE step 1
  const usage1 = Buffer.concat([fVarint(1, 1533), fVarint(2, 1000), fVarint(3, 300), fVarint(5, 5000), fBytes(7, 'bot-1'), fVarint(9, 100), fVarint(10, 200)]);
  const planMeta1 = Buffer.concat([fTimestamp(1, 1795000011), fTimestamp(8, 1795000014), fBytes(9, usage1), fVarint(11, 1533), fBytes(12, 'turn-1')]);
  db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(1, 15, 3, planMeta1, null);

  // Duplicate messageId step 2 (should be deduplicated)
  db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(2, 15, 3, planMeta1, null);

  // Second call in same turn
  const usage2 = Buffer.concat([fVarint(1, 1533), fVarint(2, 500), fVarint(3, 150), fVarint(5, 6000), fBytes(7, 'bot-2'), fVarint(9, 50), fVarint(10, 100)]);
  const planMeta2 = Buffer.concat([fTimestamp(1, 1795000015), fTimestamp(8, 1795000018), fBytes(9, usage2), fVarint(11, 1533), fBytes(12, 'turn-1')]);
  db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(3, 15, 3, planMeta2, null);
  db.close();

  try {
    const salt = randomBytes(32);
    const direct = readConversationDb(dbPath, salt, true);
    assert.equal(direct.requests.size, 2);
    assert.equal(direct.turns.size, 1);
    assert.equal(direct.project.name, 'demo-repo');

    const workspace = { selected: null, dbCache: new Map() };
    const hist1 = await recentAntigravityHistory(root, salt, true, workspace);
    assert.equal(hist1.coverage.scannedFiles, 1);
    assert.equal(hist1.projects.length, 1);
    assert.equal(hist1.sessionCatalog.length, 1);
    assert.equal(workspace.dbCache.size, 1);

    // Second read should hit cache cleanly
    const hist2 = await recentAntigravityHistory(root, salt, true, workspace);
    assert.equal(hist2.requests.size, 2);
    assert.equal(hist2.sessionCatalog[0].reference, hist1.sessionCatalog[0].reference);

    const summaries = new DatabaseSync(join(root, 'conversation_summaries.db'));
    try {
      summaries.exec(`CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY,
        project_id TEXT, workspace_uris TEXT, last_modified_time TEXT, last_user_input_time TEXT, title TEXT)`);
      const insert = summaries.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, NULL, ?)');
      insert.run('cascade-1', 'native-project', '["file:///c:/dev/demo-repo"]', '2026-11-23 10:00:00+00:00', 'Primer chat');
      insert.run('cascade-2', 'native-project', '["file:///c:/dev/another-folder"]', '2026-11-24 10:00:00+00:00', 'Chat reciente');
      const hist3 = await recentAntigravityHistory(root, salt, true, workspace);
      assert.equal(hist3.projects.length, 1);
      assert.deepEqual(hist3.sessionCatalog.map(s => s.nativeTitle), ['Chat reciente', 'Primer chat']);
      assert.equal(hist3.selectedSession, hist3.sessionCatalog[0].reference);
      assert.equal(hist3.sessionCatalog[0].partial, true);
      assert.equal(hist3.sessionCatalog[0].projectReference, hist3.sessionCatalog[1].projectReference);

      summaries.exec("UPDATE conversation_summaries SET project_id = 'moved-project' WHERE conversation_id = 'cascade-1'");
      const hist4 = await recentAntigravityHistory(root, salt, true, workspace);
      assert.equal(hist4.projects.length, 2);
      assert.notEqual(hist4.sessionCatalog[0].projectReference, hist4.sessionCatalog[1].projectReference);
    } finally {
      summaries.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('parsea salida JSON oficial de agy /usage con 4 ventanas (Gemini y Claude/GPT)', () => {
  const raw = {
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.945, reset_time: '2026-11-30T21:11:37Z' },
              { id: 'gemini-5h', window: '5h', remaining_fraction: 0.892, reset_time: '2026-11-24T09:08:08Z' },
            ],
          },
          {
            name: 'Claude and GPT models',
            buckets: [
              { id: '3p-weekly', window: 'weekly', remaining_fraction: 0.41, reset_time: '2026-11-29T17:08:24Z' },
              { id: '3p-5h', window: '5h', remaining_fraction: 1, reset_time: '2026-11-24T09:43:24Z' },
            ],
          },
        ],
      },
    },
  };
  const parsed = parseAgyUsageJson(raw, '2026-11-24T04:43:24.000Z', 420);
  assert.equal(parsed.source, 'agy-cli');
  assert.equal(parsed.readMs, 420);
  assert.equal(parsed.windows.length, 4);
  const g5 = parsed.windows.find(w => w.pool === 'gemini' && w.minutes === 300);
  const gw = parsed.windows.find(w => w.pool === 'gemini' && w.minutes === 10080);
  const c5 = parsed.windows.find(w => w.pool === 'claude_gpt' && w.minutes === 300);
  const cw = parsed.windows.find(w => w.pool === 'claude_gpt' && w.minutes === 10080);
  assert.equal(g5.usedPercent, 10.8);
  assert.equal(gw.usedPercent, 5.5);
  assert.equal(c5.usedPercent, 0);
  assert.equal(cw.usedPercent, 59);
});

test('integra subagentes de Antigravity en el chat y turno padre sin duplicar chats ni marcar cuota compartida', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ag-subagent-test-'));
  const convDir = join(root, 'conversations');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(convDir, { recursive: true });

  const parentId = '11111111-2222-3333-4444-555555555555';
  const childId = '66666666-7777-8888-9999-aaaaaaaaaaaa';
  const parentTurnId = 'aaaa1111-2222-3333-4444-555555555555';
  const childTurnId = 'bbbb1111-2222-3333-4444-555555555555';

  const makeSchema = db => db.exec(`
    CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
    CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
  `);

  // Parent DB
  const pdb = new DatabaseSync(join(convDir, `${parentId}.db`));
  makeSchema(pdb);
  pdb.prepare('INSERT INTO trajectory_meta VALUES (?, ?, 1, 1)').run('traj-p', parentId);
  pdb.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', Buffer.concat([
    fBytes(1, fBytes(1, 'file:///c:/dev/demo-workspace')),
    fTimestamp(2, 1795000000),
    fBytes(6, parentId),
  ]));
  pdb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(
    0, 14, 3,
    Buffer.concat([fTimestamp(1, 1795000010), fBytes(12, parentTurnId)]),
    fBytes(19, fBytes(2, 'Revisar arquitectura')),
  );
  const pUsage = Buffer.concat([fVarint(1, 1533), fVarint(2, 2000), fVarint(3, 500), fVarint(5, 10000), fBytes(7, 'p-bot-1')]);
  pdb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(
    1, 15, 3,
    Buffer.concat([fTimestamp(1, 1795000011), fTimestamp(8, 1795000013), fBytes(9, pUsage), fVarint(11, 1533), fBytes(12, parentTurnId)]),
    null,
  );
  // step_type 132 linking childId to parentTurnId
  pdb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(
    2, 132, 3,
    Buffer.concat([fTimestamp(1, 1795000013), fBytes(12, parentTurnId)]),
    Buffer.from(`invoke_subagent:${childId}`, 'utf8'),
  );
  const pUsage2 = Buffer.concat([fVarint(1, 1533), fVarint(2, 1000), fVarint(3, 300), fVarint(5, 12000), fBytes(7, 'p-bot-2')]);
  pdb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(
    3, 15, 3,
    Buffer.concat([fTimestamp(1, 1795000022), fTimestamp(8, 1795000025), fBytes(9, pUsage2), fVarint(11, 1533), fBytes(12, parentTurnId)]),
    null,
  );
  pdb.close();

  // Child (subagent) DB
  const cdb = new DatabaseSync(join(convDir, `${childId}.db`));
  makeSchema(cdb);
  cdb.prepare('INSERT INTO trajectory_meta VALUES (?, ?, 4, 1)').run('traj-c', childId);
  cdb.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', Buffer.concat([
    fBytes(1, fBytes(1, 'file:///c:/dev/demo-workspace')),
    fTimestamp(2, 1795000014),
    fBytes(5, parentId),
    fBytes(6, parentId),
    fVarint(17, 1),
  ]));
  const cUsage = Buffer.concat([fVarint(1, 1533), fVarint(2, 1500), fVarint(3, 400), fVarint(5, 8000), fBytes(7, 'c-bot-1')]);
  cdb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(
    1, 15, 3,
    Buffer.concat([fTimestamp(1, 1795000015), fTimestamp(8, 1795000020), fBytes(9, cUsage), fVarint(11, 1533), fBytes(12, childTurnId)]),
    null,
  );
  cdb.close();

  // Catalog DB with parent_conversation_id & nesting_depth
  const sumDb = new DatabaseSync(join(root, 'conversation_summaries.db'));
  sumDb.exec(`CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY,
    project_id TEXT, workspace_uris TEXT, last_modified_time TEXT, last_user_input_time TEXT,
    title TEXT, parent_conversation_id TEXT, nesting_depth INTEGER)`);
  sumDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, NULL, ?, ?, ?)').run(
    parentId, 'proj-1', '["file:///c:/dev/demo-workspace"]', '2026-11-24 10:00:00+00:00', 'Chat principal', null, 0,
  );
  sumDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, NULL, ?, ?, ?)').run(
    childId, 'proj-1', '["file:///c:/dev/demo-workspace"]', '2026-11-24 10:00:05+00:00', '', parentId, 1,
  );
  sumDb.close();

  try {
    const salt = randomBytes(32);
    const workspace = { selected: null, dbCache: new Map() };
    const hist = await recentAntigravityHistory(root, salt, true, workspace);

    // Only the 1 parent chat appears in sessionCatalog
    assert.equal(hist.sessionCatalog.length, 1);
    assert.equal(hist.sessionCatalog[0].nativeTitle, 'Chat principal');

    // Quota snapshots bracketing [1795000005, 1795000030] should stay 'observed' (0 competing turns)
    const buckets = [{ pool: 'gemini', minutes: 300 }, { pool: 'gemini', minutes: 10080 }];
    const live = [
      { pool: 'gemini', minutes: 300, usedPercent: 10, resetsAt: new Date(1795018000000).toISOString(), time: 1795000005000, scope: 'same', source: 'agy-cli' },
      { pool: 'gemini', minutes: 300, usedPercent: 15, resetsAt: new Date(1795018000000).toISOString(), time: 1795000030000, scope: 'same', source: 'agy-cli' },
    ];
    const details = interactionSummary(hist, 0, 1795000060000, live, true, { buckets });
    assert.equal(details.observedQuestions, 1);
    assert.equal(details.observedOtherTurns, 0);
    const [prompt] = details.turns;
    assert.equal(prompt.observedRequests, 3);
    assert.equal(prompt.childRequests, 1);
    assert.deepEqual(prompt.requests.map(r => r.kind), ['first', 'related', 'followup']);
    const q5 = prompt.quota.find(q => q.pool === 'gemini' && q.minutes === 300);
    assert.equal(q5.status, 'observed');
    assert.equal(q5.otherTurns, 0);
    assert.equal(q5.deltaPp, 5);

    // Analytics also rolls up subagent steps into the 1 prompt and measures observed drop
    const an = analyticsSummary(hist, 1795000060000, 'antigravity', live, { buckets });
    assert.equal(an.periods['24h'].observedTurns, 1);
    assert.equal(an.periods['24h'].observedRequests, 3);
    assert.equal(an.periods['24h'].quotaAverages.measured5hTurns, 1);
    assert.equal(an.periods['24h'].quotaAverages.avg5hPerTurnPp, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

