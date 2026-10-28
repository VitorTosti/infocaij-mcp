import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCHEMA, seedDemo, DEFAULT_NOW } from '../scripts/seed-demo.ts';
import { createHandler } from '../src/protocol.ts';

export const NOW = DEFAULT_NOW;

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'infocaij-mcp-'));
}

export function demoDb() {
  const file = path.join(tempDir(), 'demo.sqlite');
  seedDemo(file, NOW);
  return file;
}

/** Banco mínimo com linhas montadas à mão, para conferir cálculos com valores conhecidos. */
export function tinyDb(build: (db: DatabaseSync) => void) {
  const file = path.join(tempDir(), 'tiny.sqlite');
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  build(db);
  db.close();
  return file;
}

export function handlerFor(dbPath: string, now = NOW) {
  return createHandler({ dbPath, clock: () => ({ now: new Date(now) }) });
}

let nextId = 1;
export function call(handle: ReturnType<typeof handlerFor>, name: string, args: Record<string, unknown> = {}) {
  const response = handle({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
  if (!response || !('result' in response)) throw new Error(`Resposta inesperada: ${JSON.stringify(response)}`);
  const result = response.result as { content: Array<{ text: string }>; isError: boolean };
  return { isError: result.isError, text: result.content[0].text, json: () => JSON.parse(result.content[0].text) };
}
