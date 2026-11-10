import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { demoDb, handlerFor, handlerForSource, call, NOW } from './helpers.ts';
import { toPositional, normalizeRow, openPostgres, type PgLoader } from '../src/postgres.ts';
import { assertReadOnlySql, closeShared, openDb, type Source } from '../src/db.ts';
import { TOOLS } from '../src/tools.ts';

test('toPositional troca $nome por $1, $2 e reaproveita o número do mesmo nome', () => {
  const { text, values } = toPositional('SELECT 1 WHERE a = $t OR b = upper($t) AND c > $since AND d = $t', { $t: 'x', $since: '2026' });
  assert.equal(text, 'SELECT 1 WHERE a = $1 OR b = upper($1) AND c > $2 AND d = $1');
  assert.deepEqual(values, ['x', '2026']);
  assert.deepEqual(toPositional('SELECT 1', {}), { text: 'SELECT 1', values: [] });
  assert.throws(() => toPositional('SELECT $falta', {}), /sem valor/);
});

test('normalizeRow converte datas do pg em ISO e deixa o resto como veio', () => {
  const row = normalizeRow({ quando: new Date('2026-10-10T12:00:00Z'), n: '12', ok: true, nada: null });
  assert.deepEqual(row, { quando: '2026-10-10T12:00:00.000Z', n: '12', ok: true, nada: null });
});

test('só SELECT e WITH, e um comando por vez', () => {
  assertReadOnlySql('SELECT 1');
  assertReadOnlySql('  with x as (select 1) select * from x;  ');
  for (const bad of ['DELETE FROM sales', 'UPDATE sales SET a = 1', 'DROP TABLE x', 'SELECT 1; DROP TABLE x', 'INSERT INTO x VALUES (1)', 'PRAGMA query_only = OFF']) {
    assert.throws(() => assertReadOnlySql(bad), /SELECT/, bad);
  }
});

// ---------------------------------------------------------------- driver falso
/**
 * Um cliente "pg" falso apoiado em SQLite: recebe o SQL já traduzido para $1, $2 (como o PostgreSQL
 * receberia), e o executa no banco de demonstração. Assim as 8 ferramentas passam de verdade pela
 * tradução de parâmetros e pelo adaptador, e os resultados podem ser comparados com os do SQLite.
 */
function fakePg(
  dbPath: string,
  log: Array<{ text: string; values?: unknown[] }> = [],
  config: Array<Record<string, unknown>> = [],
  clients: Array<{ emit: (event: 'error' | 'end') => void; ended: boolean }> = [],
) {
  class FakeClient {
    private db: DatabaseSync;
    private listeners: Record<string, Array<(error?: Error) => void>> = {};
    ended = false;
    constructor(cfg: Record<string, unknown>) {
      config.push(cfg);
      this.db = new DatabaseSync(dbPath, { readOnly: true });
      clients.push(this);
    }
    on(event: string, listener: (error?: Error) => void) {
      (this.listeners[event] ??= []).push(listener);
    }
    /** Simula o pg avisando que a conexão caiu. */
    emit(event: 'error' | 'end') {
      for (const listener of this.listeners[event] ?? []) listener(new Error('conexão perdida'));
    }
    async connect() {}
    async query(text: string, values: unknown[] = []) {
      log.push({ text, values });
      if (/^SET /i.test(text)) return { rows: [] };
      const params = Object.fromEntries(values.map((value, i) => [`$${i + 1}`, value]));
      return { rows: this.db.prepare(text).all(params as never) as Record<string, unknown>[] };
    }
    async end() {
      this.ended = true;
      this.db.close();
    }
  }
  const loader: PgLoader = async () => ({ Client: FakeClient as never });
  return loader;
}

test('o adaptador abre a sessão em somente leitura, com timeout e nome da aplicação', async () => {
  const log: Array<{ text: string }> = [];
  const config: Array<Record<string, unknown>> = [];
  const db = await openPostgres('postgres://leitura@banco/infocaij', fakePg(demoDb(), log, config));
  assert.equal(config[0].connectionString, 'postgres://leitura@banco/infocaij');
  assert.equal(config[0].application_name, 'infocaij-mcp');
  assert.match(String(config[0].options), /default_transaction_read_only=on/);
  assert.match(String(config[0].options), /statement_timeout=\d+/);
  assert.match(log[0].text, /^SET default_transaction_read_only = on/);
  await assert.rejects(() => db.all('DELETE FROM sales'), /SELECT/);
  await db.close();
});

test('sem o driver pg instalado, a mensagem diz o que fazer', async () => {
  const missing: PgLoader = async () => {
    throw new Error('Para usar PostgreSQL instale o driver: npm install pg');
  };
  await assert.rejects(() => openPostgres('postgres://x', missing), /npm install pg/);
});

const SAMPLE: Record<string, Record<string, unknown>> = {
  consultar_maquina: { busca: 'CAIJ-0001' },
  tempo_entre_etapas: { ate: 'Pronta', agrupar_por: 'tecnico' },
  estoque: { loja: 'CAIJ' },
};

test('as 8 ferramentas dão o mesmo resultado pelo caminho PostgreSQL e pelo SQLite', async () => {
  const dbPath = demoDb();
  const viaSqlite = handlerFor(dbPath);
  const viaPg = handlerForSource({ kind: 'custom', open: () => openPostgres('postgres://x', fakePg(dbPath)) });
  for (const tool of TOOLS) {
    const args = SAMPLE[tool.name] ?? {};
    const a = await call(viaSqlite, tool.name, args);
    const b = await call(viaPg, tool.name, args);
    assert.equal(b.isError, false, `${tool.name}: ${b.text}`);
    assert.deepEqual(b.json(), a.json(), tool.name);
  }
});

test('PostgreSQL: a conexão é reaproveitada entre chamadas, e não reaberta a cada pergunta', async () => {
  const config: Array<Record<string, unknown>> = [];
  const clients: Array<{ emit: (event: 'error' | 'end') => void; ended: boolean }> = [];
  const source: Source = { kind: 'postgres', url: 'postgres://x', load: fakePg(demoDb(), [], config, clients) };
  const handle = handlerForSource(source);
  for (const tool of ['resumo_fila', 'tempo_por_etapa', 'vendas']) {
    assert.equal((await call(handle, tool)).isError, false, tool);
  }
  assert.equal(config.length, 1, 'três chamadas, uma conexão');
  await closeShared(source);
  assert.equal(clients[0].ended, true);
});

test('PostgreSQL: se a conexão cai, a próxima chamada abre outra', async () => {
  const config: Array<Record<string, unknown>> = [];
  const clients: Array<{ emit: (event: 'error' | 'end') => void; ended: boolean }> = [];
  const source: Source = { kind: 'postgres', url: 'postgres://x', load: fakePg(demoDb(), [], config, clients) };
  const handle = handlerForSource(source);
  assert.equal((await call(handle, 'resumo_fila')).isError, false);
  clients[0].emit('error'); // banco reiniciou, por exemplo; sem ouvinte isso derrubaria o processo
  assert.equal((await call(handle, 'resumo_fila')).isError, false);
  assert.equal(config.length, 2);
  await closeShared(source);
});

test('PostgreSQL: falha ao conectar não fica guardada; a próxima tentativa conecta de novo', async () => {
  let attempts = 0;
  const working = fakePg(demoDb());
  const flaky: PgLoader = async () => {
    attempts++;
    if (attempts === 1) throw new Error('banco fora do ar');
    return working();
  };
  const source: Source = { kind: 'postgres', url: 'postgres://x', load: flaky };
  const handle = handlerForSource(source);
  const first = await call(handle, 'resumo_fila');
  assert.equal(first.isError, true);
  assert.match(first.text, /banco fora do ar/);
  assert.equal((await call(handle, 'resumo_fila')).isError, false);
  await closeShared(source);
});

test('a fonte postgres sem o driver instalado falha com mensagem útil', async () => {
  // Neste repositório o pg não é dependência: sem ele, abrir a fonte real deve explicar o que falta.
  let installed = true;
  try {
    await import('pg' as string);
  } catch {
    installed = false;
  }
  if (installed) return;
  await assert.rejects(() => openDb({ kind: 'postgres', url: 'postgres://x' }), /npm install pg/);
});

test('NOW fixo do banco de demonstração é o usado pelos testes de paridade', () => {
  assert.match(NOW, /^2026-/);
});
