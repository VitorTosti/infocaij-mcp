import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type Db = DatabaseSync;

/**
 * Abre o banco do InfoCAIJ em modo somente leitura.
 *
 * Duas travas independentes: o arquivo é aberto com `readOnly` pelo driver e a
 * conexão recebe `PRAGMA query_only`. Qualquer INSERT, UPDATE ou DELETE falha.
 *
 * O InfoCAIJ grava o banco de forma atômica (escreve um arquivo novo e renomeia),
 * então abrir a cada consulta garante dados atuais sem segurar um arquivo antigo.
 */
export function openReadOnly(filePath: string): Db {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Banco não encontrado em ${resolved}. Defina INFOCAIJ_DB_PATH.`);
  }
  const db = new DatabaseSync(resolved, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  return db;
}

export function withDb<T>(filePath: string, fn: (db: Db) => T): T {
  const db = openReadOnly(filePath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export type Row = Record<string, unknown>;

export function all(db: Db, sql: string, params: Record<string, unknown> = {}): Row[] {
  return db.prepare(sql).all(params as never) as Row[];
}

export function get(db: Db, sql: string, params: Record<string, unknown> = {}): Row | undefined {
  return db.prepare(sql).get(params as never) as Row | undefined;
}
