import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoDb, handlerFor, call, NOW } from './helpers.ts';
import { SUPPORTED_VERSIONS } from '../src/protocol.ts';

const dbPath = demoDb();
const handle = handlerFor(dbPath);

test('initialize negocia a versão do protocolo e anuncia ferramentas e prompts', () => {
  const ok = handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.ok(ok && 'result' in ok);
  const result = ok.result as Record<string, any>;
  assert.equal(result.protocolVersion, '2025-03-26');
  assert.deepEqual(Object.keys(result.capabilities).sort(), ['prompts', 'tools']);
  assert.match(result.instructions, /somente leitura/);

  const unknown = handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.ok(unknown && 'result' in unknown);
  assert.equal((unknown.result as Record<string, any>).protocolVersion, SUPPORTED_VERSIONS[0]);
});

test('notificações não recebem resposta', () => {
  assert.equal(handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('tools/list traz 8 ferramentas, todas marcadas como somente leitura', () => {
  const response = handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.ok(response && 'result' in response);
  const tools = (response.result as { tools: Array<Record<string, any>> }).tools;
  assert.equal(tools.length, 8);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.ok(tool.description.length > 80, `${tool.name} precisa de uma descrição útil para o modelo`);
  }
});

test('método desconhecido e ferramenta desconhecida viram erros JSON-RPC', () => {
  const method = handle({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
  assert.ok(method && 'error' in method);
  assert.equal(method.error.code, -32601);

  const tool = handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'apagar_tudo' } });
  assert.ok(tool && 'error' in tool);
  assert.equal(tool.error.code, -32602);
});

test('argumento inválido volta como resultado com isError, para o modelo corrigir', () => {
  const wrongEnum = call(handle, 'itens_parados', { etapa: 'Voando' });
  assert.equal(wrongEnum.isError, true);
  assert.match(wrongEnum.text, /etapa deve ser um de/);

  const extra = call(handle, 'resumo_fila', { sql: 'DROP TABLE sales' });
  assert.equal(extra.isError, true);
  assert.match(extra.text, /Argumento desconhecido/);

  const tooBig = call(handle, 'tempo_por_etapa', { dias: 9999 });
  assert.equal(tooBig.isError, true);
});

test('padrões do esquema são aplicados', () => {
  const result = call(handle, 'itens_parados').json();
  assert.match(result.criterio, /48 h/);
});

test('prompts listam e renderizam com argumentos', () => {
  const list = handle({ jsonrpc: '2.0', id: 6, method: 'prompts/list' });
  assert.ok(list && 'result' in list);
  const names = (list.result as { prompts: Array<{ name: string }> }).prompts.map((p) => p.name);
  assert.deepEqual(names, ['relatorio_semanal', 'diagnostico_gargalo', 'status_pedido']);

  const missing = handle({ jsonrpc: '2.0', id: 7, method: 'prompts/get', params: { name: 'status_pedido', arguments: {} } });
  assert.ok(missing && 'error' in missing);

  const ok = handle({ jsonrpc: '2.0', id: 8, method: 'prompts/get', params: { name: 'status_pedido', arguments: { busca: 'CAIJ-0007' } } });
  assert.ok(ok && 'result' in ok);
  assert.match(JSON.stringify(ok.result), /consultar_maquina com busca = \\"CAIJ-0007\\"/);
});

test('ponta a ponta por stdio: handshake, chamada e JSON inválido', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.ts'], {
    cwd: root,
    env: { ...process.env, INFOCAIJ_DB_PATH: dbPath, INFOCAIJ_MCP_NOW: NOW },
  });
  const lines: string[] = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    lines.push(...parts.filter(Boolean));
  });

  const send = (message: unknown) => child.stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'teste', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'resumo_fila', arguments: {} } });
  send('{isto não é json');
  child.stdin.end();

  await new Promise((resolve) => child.on('close', resolve));
  const messages = lines.map((line) => JSON.parse(line));
  assert.equal(messages.length, 3, 'a notificação não gera resposta');
  assert.equal(messages[0].result.serverInfo.name, 'infocaij-mcp');
  assert.equal(JSON.parse(messages[1].result.content[0].text).gerado_em, NOW);
  assert.equal(messages[2].error.code, -32700);
});
