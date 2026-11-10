#!/usr/bin/env node
/**
 * InfoCAIJ MCP: transporte stdio.
 *
 * Mensagens JSON-RPC chegam uma por linha na entrada padrão e as respostas
 * saem uma por linha na saída padrão. Logs vão para a saída de erro, para
 * não corromper o protocolo.
 *
 * Variáveis de ambiente (use UMA das duas primeiras):
 *   INFOCAIJ_DB_PATH        caminho do arquivo SQLite do InfoCAIJ
 *   INFOCAIJ_DATABASE_URL   URL do PostgreSQL do InfoCAIJ (exige `npm install pg`)
 *   INFOCAIJ_MCP_NOW        data/hora fixa em ISO, para demonstrações e testes (opcional)
 *   INFOCAIJ_MCP_TIMEOUT_MS tempo máximo de uma consulta, em ms (padrão 30000)
 *   INFOCAIJ_HORARIO_UTIL   expediente para horas úteis, "08:00-18:00" (opcional)
 *   INFOCAIJ_DIAS_UTEIS     dias úteis, "1-5" (1 = segunda, 7 = domingo) (opcional)
 *   INFOCAIJ_FUSO           fuso do expediente, "-03:00" (opcional)
 */
import readline from 'node:readline';
import { closeShared, withDb, type Source } from './db.ts';
import { scheduleFromEnv } from './horario.ts';
import { ERROR, SERVER_INFO, createHandler } from './protocol.ts';

const MAX_LINE = 1_000_000; // um pedido legítimo tem poucas centenas de bytes

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const { INFOCAIJ_DB_PATH: dbPath, INFOCAIJ_DATABASE_URL: dbUrl } = process.env;
if (dbPath && dbUrl) fail('Defina só uma: INFOCAIJ_DB_PATH (SQLite) ou INFOCAIJ_DATABASE_URL (PostgreSQL).');
if (!dbPath && !dbUrl) fail('Defina INFOCAIJ_DB_PATH (SQLite) ou INFOCAIJ_DATABASE_URL (PostgreSQL) com o banco do InfoCAIJ.');

const source: Source = dbUrl ? { kind: 'postgres', url: dbUrl } : { kind: 'sqlite', path: dbPath as string };

let schedule;
try {
  schedule = scheduleFromEnv(process.env);
} catch (error) {
  fail((error as Error).message);
}

// Falha cedo se o caminho ou a conexão estiverem errados, em vez de na primeira pergunta.
// No PostgreSQL, a conexão aberta aqui fica de pé para as chamadas seguintes.
try {
  await withDb(source, async () => {});
} catch (error) {
  fail(`Não consegui abrir o banco: ${(error as Error).message}`);
}

const fixedNow = process.env.INFOCAIJ_MCP_NOW;
const log = (message: string) => process.stderr.write(`[infocaij-mcp] ${message}\n`);
const handle = createHandler({ source, clock: () => ({ now: fixedNow ? new Date(fixedNow) : new Date(), schedule }) }, log);

const send = (payload: unknown) => process.stdout.write(`${JSON.stringify(payload)}\n`);

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (!line.trim()) return;
  if (line.length > MAX_LINE) {
    send({ jsonrpc: '2.0', id: null, error: { code: ERROR.INVALID_REQUEST, message: 'Mensagem grande demais.' } });
    return;
  }
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: ERROR.PARSE, message: 'JSON inválido.' } });
    return;
  }
  // Pedidos rodam em paralelo: uma consulta lenta não trava o ping nem um cancelamento.
  handle(message).then(
    (response) => {
      if (response) send(response);
    },
    (error) => log(`erro inesperado: ${(error as Error).message}`),
  );
});

// Ao fechar a entrada, termina o que está em andamento antes de sair.
lines.on('close', async () => {
  await handle.idle();
  await closeShared(source).catch(() => {});
  process.exit(0);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0));

log(`${SERVER_INFO.name} ${SERVER_INFO.version} pronto (somente leitura: ${source.kind === 'sqlite' ? source.path : 'PostgreSQL'})`);
