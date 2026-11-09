import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { demoDb, handlerFor, call } from './helpers.ts';
import { openReadOnly } from '../src/db.ts';
import { TOOLS } from '../src/tools.ts';

const dbPath = demoDb();
const handle = handlerFor(dbPath);
const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  consultar_maquina: { busca: 'CAIJ-0001' },
  tempo_entre_etapas: { ate: 'Pronta', agrupar_por: 'tecnico' },
};
const hash = () => crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');

test('o driver recusa qualquer escrita', async () => {
  const db = openReadOnly(dbPath);
  try {
    assert.throws(() => db.exec('DELETE FROM sales'), /readonly|read-only|query_only/i);
    assert.throws(() => db.exec("UPDATE sale_items SET status = 'Pronta'"), /readonly|read-only|query_only/i);
    assert.throws(() => db.exec('CREATE TABLE x (a)'), /readonly|read-only|query_only/i);
  } finally {
    db.close();
  }
});

test('rodar todas as ferramentas não altera um byte do banco', async () => {
  const before = hash();
  for (const tool of TOOLS) {
    assert.equal((await call(handle, tool.name, SAMPLE_ARGS[tool.name] ?? {})).isError, false, tool.name);
  }
  assert.equal(hash(), before);
});

test('nenhuma ferramenta devolve dados pessoais de clientes', async () => {
  // O banco de demonstração tem nome, e-mail, telefone e documento falsos em garantias e clientes.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const serials = (db.prepare(`SELECT serial FROM warranties`).all() as Array<{ serial: string }>).map((r) => r.serial);
  db.close();
  assert.ok(serials.length > 50, 'o banco de demonstração precisa ter garantias com dados pessoais falsos');

  const outputs = [
    ...(await Promise.all(TOOLS.filter((t) => t.name !== 'consultar_maquina').map(async (t) => (await call(handle, t.name, SAMPLE_ARGS[t.name] ?? {})).text))),
    ...(await Promise.all(serials.map(async (busca) => (await call(handle, 'consultar_maquina', { busca })).text))),
  ];
  const leaks = /Cliente Ficticio|@exemplo\.invalid|\+55 11 90000|000\.000\.\d{3}-00/;
  for (const text of outputs) assert.doesNotMatch(text, leaks);

  // E a garantia aparece, só que sem os dados do cliente.
  const sample = JSON.parse((await call(handle, 'consultar_maquina', { busca: serials[0] })).text);
  assert.ok(sample.vendas[0].garantia, 'a situação da garantia deve aparecer');
  assert.deepEqual(Object.keys(sample.vendas[0].garantia).sort(), ['compra', 'expira_em', 'meses', 'situacao']);
});

test('não existe ferramenta de SQL livre', async () => {
  for (const tool of TOOLS) {
    for (const [name, spec] of Object.entries(tool.inputSchema.properties)) {
      assert.doesNotMatch(name, /sql|query|consulta_livre/i, `${tool.name}.${name}`);
      if (spec.type === 'string' && !spec.enum) assert.ok(typeof spec.maxLength === 'number', `${tool.name}.${name} precisa de limite de tamanho`);
    }
  }
});
