import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoDb, tinyDb, handlerFor, handlerForSource, call, validateSchema, NOW } from './helpers.ts';
import { TOOLS } from '../src/tools.ts';
import type { Db } from '../src/db.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Um banco que demora `ms` para responder cada consulta: serve para testar tempo limite e cancelamento. */
function slowDb(ms: number): { open: () => Promise<Db>; closed: () => number } {
  let closed = 0;
  return {
    closed: () => closed,
    open: async () => ({
      all: async () => {
        await wait(ms);
        return [];
      },
      get: async () => {
        await wait(ms);
        return undefined;
      },
      close: async () => {
        closed++;
      },
    }),
  };
}

// ------------------------------------------------------------------- bordas dos dados
const SAMPLE: Record<string, Record<string, unknown>> = {
  consultar_maquina: { busca: 'CAIJ-0001' },
  tempo_entre_etapas: { ate: 'Pronta', agrupar_por: 'tecnico' },
};

test('banco vazio: todas as ferramentas respondem sem erro e cumprem o esquema', async () => {
  const handle = handlerFor(tinyDb(() => {}));
  for (const tool of TOOLS) {
    const result = await call(handle, tool.name, SAMPLE[tool.name] ?? {});
    assert.equal(result.isError, false, `${tool.name}: ${result.text}`);
    assert.deepEqual(validateSchema(tool.outputSchema, result.structured), [], tool.name);
  }
  const porEtapa = (await call(handle, 'tempo_por_etapa')).json();
  assert.equal(porEtapa.gargalo, null, 'sem dados não há gargalo');
  assert.equal(porEtapa.etapas_sem_uso.length, 7, 'todas as etapas abertas aparecem como sem uso');
  const fila = (await call(handle, 'resumo_fila')).json();
  assert.equal(fila.maquinas_em_aberto, 0);
  assert.equal(fila.etapas[0].mais_antiga_horas, null);
  assert.equal((await call(handle, 'consultar_maquina', { busca: 'CAIJ-0001' })).json().encontrado, false);
});

test('período sem nenhuma chegada: contagem zero e estatísticas zeradas, não NaN', async () => {
  const handle = handlerFor(demoDb(), '2030-01-01T00:00:00.000Z');
  const result = (await call(handle, 'tempo_entre_etapas', { ate: 'Pronta', dias: 1 })).json();
  assert.equal(result.maquinas, 0);
  assert.equal(result.mediana_horas, 0);
  assert.equal(result.media_horas, 0);
  const vendas = (await call(handle, 'vendas', { dias: 1 })).json();
  assert.equal(vendas.total_pedidos, 0);
  assert.deepEqual(vendas.grupos, []);
});

test('busca com caracteres de SQL é tratada como texto', async () => {
  const handle = handlerFor(demoDb());
  for (const busca of ["' OR 1=1 --", 'CAIJ-0001"; DROP TABLE sales;--', '%%%', 'a\\b\\c']) {
    const result = await call(handle, 'consultar_maquina', { busca });
    assert.equal(result.isError, false, busca);
    assert.equal(result.json().encontrado, false, busca);
  }
});

// ---------------------------------------------------------------- tempo, tamanho e cancelamento
test('consulta que passa do limite de tempo volta como erro para o modelo, e a conexão é fechada', async () => {
  const slow = slowDb(120);
  const handle = handlerForSource({ kind: 'custom', open: slow.open }, { timeoutMs: 100 });
  const result = await call(handle, 'resumo_fila');
  assert.equal(result.isError, true);
  assert.match(result.text, /passou de 0\.1 s/);
  await wait(700); // a consulta faz 3 leituras de 120 ms antes de terminar
  assert.equal(slow.closed(), 1, 'a conexão fecha quando a consulta termina');
});

test('resposta grande demais é recusada com orientação, em vez de estourar o contexto', async () => {
  const handle = handlerForSource({ kind: 'sqlite', path: demoDb() }, { maxChars: 200 });
  const result = await call(handle, 'resumo_fila');
  assert.equal(result.isError, true);
  assert.match(result.text, /grande demais/);
});

test('pedido cancelado pelo cliente não recebe resposta', async () => {
  const slow = slowDb(150);
  const handle = handlerForSource({ kind: 'custom', open: slow.open });
  const running = handle({ jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'resumo_fila', arguments: {} } });
  await wait(20);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 77, reason: 'teste' } }), null);
  assert.equal(await running, null, 'a resposta é descartada');

  // Outro pedido, não cancelado, continua respondendo normalmente.
  const normal = await handle({ jsonrpc: '2.0', id: 78, method: 'tools/call', params: { name: 'resumo_fila', arguments: {} } });
  assert.ok(normal && 'result' in normal);
});

test('uma consulta lenta não bloqueia o ping, e idle() espera o que está em andamento', async () => {
  const slow = slowDb(150);
  const handle = handlerForSource({ kind: 'custom', open: slow.open });
  const order: string[] = [];
  const lento = handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'resumo_fila', arguments: {} } }).then(() => order.push('consulta'));
  const ping = handle({ jsonrpc: '2.0', id: 2, method: 'ping' }).then(() => order.push('ping'));
  await ping;
  assert.deepEqual(order, ['ping'], 'o ping responde antes de a consulta terminar');
  await handle.idle();
  assert.deepEqual(order, ['ping', 'consulta']);
  await lento;
});

// ------------------------------------------------------------------------------- stdio de verdade
function runServer(env: Record<string, string | undefined>, input: string[]) {
  return new Promise<{ code: number | null; stdout: string[]; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.ts'], {
      cwd: root,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout: stdout.split('\n').filter(Boolean), stderr }));
    for (const line of input) child.stdin.write(`${line}\n`);
    child.stdin.end();
  });
}

test('stdio: sem banco configurado, ou com os dois, o servidor recusa e explica', async () => {
  const none = await runServer({}, []);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /INFOCAIJ_DB_PATH/);

  const both = await runServer({ INFOCAIJ_DB_PATH: demoDb(), INFOCAIJ_DATABASE_URL: 'postgres://x' }, []);
  assert.equal(both.code, 1);
  assert.match(both.stderr, /só uma/);

  const missing = await runServer({ INFOCAIJ_DB_PATH: path.join(root, 'nao-existe.sqlite') }, []);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Banco não encontrado/);
});

test('stdio: expediente inválido em variável de ambiente impede a partida', async () => {
  const result = await runServer({ INFOCAIJ_DB_PATH: demoDb(), INFOCAIJ_HORARIO_UTIL: '18:00-08:00' }, []);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /INFOCAIJ_HORARIO_UTIL/);
});

test('stdio: mensagem enorme é recusada sem derrubar o servidor', async () => {
  const huge = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { lixo: 'x'.repeat(1_100_000) } });
  const ping = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' });
  const result = await runServer({ INFOCAIJ_DB_PATH: demoDb() }, [huge, ping]);
  const messages = result.stdout.map((line) => JSON.parse(line));
  assert.equal(messages.find((m) => m.id === null).error.code, -32600);
  assert.deepEqual(messages.find((m) => m.id === 2).result, {});
  assert.equal(result.code, 0);
});

test('stdio: ao fechar a entrada, a consulta em andamento ainda é respondida', async () => {
  const call = JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'tempo_por_etapa', arguments: { horas: 'uteis' } } });
  const result = await runServer({ INFOCAIJ_DB_PATH: demoDb(), INFOCAIJ_MCP_NOW: NOW }, [call]);
  const response = JSON.parse(result.stdout[0]);
  assert.equal(response.id, 5);
  assert.equal(response.result.structuredContent.horas, 'uteis');
  assert.equal(result.code, 0);
});

test('stdio: o resultado traz texto e structuredContent iguais', async () => {
  const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const result = await runServer({ INFOCAIJ_DB_PATH: demoDb(), INFOCAIJ_MCP_NOW: NOW }, [initialize, list]);
  const messages = result.stdout.map((line) => JSON.parse(line));
  const tools = messages.find((m) => m.id === 2).result.tools;
  assert.equal(tools.length, 8);
  assert.ok(tools.every((tool: any) => tool.outputSchema));
});
