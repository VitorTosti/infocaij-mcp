import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoDb, handlerFor, call, validateSchema } from './helpers.ts';
import { TOOLS } from '../src/tools.ts';

const dbPath = demoDb();
const handle = handlerFor(dbPath);

const CASES: Array<[string, Record<string, unknown>]> = [
  ['resumo_fila', {}],
  ['itens_parados', {}],
  ['itens_parados', { horas: 'uteis', horas_minimas: 8 }],
  ['tempo_por_etapa', {}],
  ['tempo_por_etapa', { horas: 'uteis' }],
  ['tempo_por_etapa', { dias: 30, por_semana: true }],
  ['tempo_entre_etapas', { ate: 'Pronta' }],
  ['tempo_entre_etapas', { ate: 'Pronta', agrupar_por: 'tecnico', horas: 'uteis' }],
  ['produtividade', {}],
  ['vendas', {}],
  ['vendas', { agrupar_por: 'dia' }],
  ['vendas', { agrupar_por: 'vendedor' }],
  ['estoque', {}],
  ['estoque', { loja: 'CAIJ' }],
  ['consultar_maquina', { busca: 'CAIJ-0001' }],
  ['consultar_maquina', { busca: 'NAO-EXISTE' }],
];

test('toda ferramenta anuncia um outputSchema e os casos cobrem as 8', () => {
  for (const tool of TOOLS) {
    assert.equal(tool.outputSchema.type, 'object', tool.name);
    assert.ok(CASES.some(([name]) => name === tool.name), `${tool.name} sem caso de teste`);
  }
});

test('o structuredContent de cada chamada cumpre o outputSchema e repete o texto', async () => {
  for (const [name, args] of CASES) {
    const tool = TOOLS.find((t) => t.name === name)!;
    const result = await call(handle, name, args);
    assert.equal(result.isError, false, `${name} ${JSON.stringify(args)}: ${result.text}`);
    assert.deepEqual(result.structured, result.json(), `${name}: structuredContent e texto precisam coincidir`);
    const problems = validateSchema(tool.outputSchema, result.structured);
    assert.deepEqual(problems, [], `${name} ${JSON.stringify(args)}`);
  }
});

test('o outputSchema é restritivo: pega um campo faltando e um campo inesperado', async () => {
  const tool = TOOLS.find((t) => t.name === 'resumo_fila')!;
  const good = (await call(handle, 'resumo_fila')).structured as Record<string, unknown>;
  const { gerado_em: _omitted, ...missing } = good;
  assert.ok(validateSchema(tool.outputSchema, missing).some((p) => p.includes('gerado_em')));
  assert.ok(validateSchema(tool.outputSchema, { ...good, intruso: 1 }).some((p) => p.includes('intruso')));
});

test('tools/list só envia outputSchema a clientes do protocolo 2025-06-18 em diante', async () => {
  const modern = handlerFor(dbPath);
  await modern({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const modernList = await modern({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(modernList && 'result' in modernList);
  for (const tool of (modernList.result as { tools: any[] }).tools) assert.ok(tool.outputSchema, tool.name);

  const old = handlerFor(dbPath);
  await old({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  const oldList = await old({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(oldList && 'result' in oldList);
  for (const tool of (oldList.result as { tools: any[] }).tools) assert.equal('outputSchema' in tool, false, tool.name);

  const oldCall = await old({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'resumo_fila', arguments: {} } });
  assert.ok(oldCall && 'result' in oldCall);
  const result = oldCall.result as Record<string, unknown>;
  assert.equal('structuredContent' in result, false, 'cliente antigo não recebe structuredContent');
  assert.ok(result.content, 'mas continua recebendo o texto');
});

test('erro de ferramenta não leva structuredContent', async () => {
  const result = await call(handle, 'itens_parados', { etapa: 'Voando' });
  assert.equal(result.isError, true);
  assert.equal(result.structured, undefined);
});
