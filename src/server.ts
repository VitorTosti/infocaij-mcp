#!/usr/bin/env node
/**
 * InfoCAIJ MCP: transporte stdio.
 *
 * Mensagens JSON-RPC chegam uma por linha na entrada padrão e as respostas
 * saem uma por linha na saída padrão. Logs vão para a saída de erro, para
 * não corromper o protocolo.
 *
 * Variáveis de ambiente:
 *   INFOCAIJ_DB_PATH   caminho do arquivo SQLite do InfoCAIJ (obrigatória)
 *   INFOCAIJ_MCP_NOW   data/hora fixa em ISO, para demonstrações e testes (opcional)
 */
import readline from 'node:readline';
import { openReadOnly } from './db.ts';
import { ERROR, SERVER_INFO, createHandler } from './protocol.ts';

const dbPath = process.env.INFOCAIJ_DB_PATH;
if (!dbPath) {
  process.stderr.write('Defina INFOCAIJ_DB_PATH com o caminho do banco do InfoCAIJ.\n');
  process.exit(1);
}

// Falha cedo se o caminho estiver errado, em vez de na primeira pergunta.
openReadOnly(dbPath).close();

const fixedNow = process.env.INFOCAIJ_MCP_NOW;
const log = (message: string) => process.stderr.write(`[infocaij-mcp] ${message}\n`);
const handle = createHandler({ dbPath, clock: () => ({ now: fixedNow ? new Date(fixedNow) : new Date() }) }, log);

const send = (payload: unknown) => process.stdout.write(`${JSON.stringify(payload)}\n`);

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (!line.trim()) return;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: ERROR.PARSE, message: 'JSON inválido.' } });
    return;
  }
  const response = handle(message);
  if (response) send(response);
});
lines.on('close', () => process.exit(0));

log(`${SERVER_INFO.name} ${SERVER_INFO.version} pronto (somente leitura: ${dbPath})`);
