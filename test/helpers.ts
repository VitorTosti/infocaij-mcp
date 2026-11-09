import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCHEMA, seedDemo, DEFAULT_NOW } from '../scripts/seed-demo.ts';
import { createHandler, type HandlerOptions } from '../src/protocol.ts';
import type { Schedule } from '../src/horario.ts';
import type { Source } from '../src/db.ts';

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

export function handlerFor(dbPath: string, now = NOW, schedule?: Schedule) {
  return createHandler({ source: { kind: 'sqlite', path: dbPath }, clock: () => ({ now: new Date(now), schedule }) });
}

/** Handler sobre qualquer fonte de dados (um banco falso, por exemplo) e com opções próprias. */
export function handlerForSource(source: Source, options: HandlerOptions = {}, now = NOW) {
  return createHandler({ source, clock: () => ({ now: new Date(now) }) }, () => {}, options);
}

let nextId = 1;
export async function call(handle: ReturnType<typeof handlerFor>, name: string, args: Record<string, unknown> = {}) {
  const response = await handle({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
  if (!response || !('result' in response)) throw new Error(`Resposta inesperada: ${JSON.stringify(response)}`);
  const result = response.result as { content: Array<{ text: string }>; isError: boolean; structuredContent?: unknown };
  return {
    isError: result.isError,
    text: result.content[0].text,
    structured: result.structuredContent,
    json: () => JSON.parse(result.content[0].text),
  };
}

// ---------------------------------------------- validador mínimo de JSON Schema (sem dependências)
/** Valida o subconjunto de JSON Schema usado nos outputSchema. Devolve a lista de problemas. */
export function validateSchema(schema: any, value: unknown, at = '$'): string[] {
  const problems: string[] = [];
  const types: string[] = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value;
  const matches = (type: string) => type === kind || (type === 'number' && kind === 'integer');
  if (types.length && !types.some(matches)) return [`${at}: esperava ${types.join('|')}, veio ${kind}`];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) problems.push(`${at}: ${JSON.stringify(value)} fora de ${JSON.stringify(schema.enum)}`);
  if (kind === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in object)) problems.push(`${at}.${key}: ausente`);
    for (const [key, item] of Object.entries(object)) {
      if (schema.properties?.[key]) problems.push(...validateSchema(schema.properties[key], item, `${at}.${key}`));
      else if (schema.additionalProperties === false) problems.push(`${at}.${key}: propriedade não declarada`);
    }
  }
  if (kind === 'array' && schema.items) {
    (value as unknown[]).forEach((item, i) => problems.push(...validateSchema(schema.items, item, `${at}[${i}]`)));
  }
  return problems;
}
