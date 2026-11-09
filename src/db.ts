import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { openPostgres } from './postgres.ts';

export type Row = Record<string, unknown>;

/** Acesso ao banco, o mesmo para SQLite e PostgreSQL. Só leitura. */
export interface Db {
  all(sql: string, params?: Record<string, unknown>): Promise<Row[]>;
  get(sql: string, params?: Record<string, unknown>): Promise<Row | undefined>;
  close(): Promise<void>;
}

/** De onde vêm os dados. `custom` existe para testes. */
export type Source =
  | { kind: 'sqlite'; path: string }
  | { kind: 'postgres'; url: string }
  | { kind: 'custom'; open: () => Promise<Db> };

/**
 * Defesa em profundidade: além das travas do driver, só passa SQL que começa com SELECT ou WITH
 * e não tem um segundo comando. Todas as consultas do servidor são escritas aqui no código.
 */
export function assertReadOnlySql(sql: string): void {
  const text = sql.trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(text) || text.includes(';')) {
    throw new Error('Só consultas SELECT são permitidas.');
  }
}

/**
 * Abre o arquivo SQLite do InfoCAIJ em modo somente leitura.
 *
 * Duas travas independentes: o arquivo é aberto com `readOnly` pelo driver e a
 * conexão recebe `PRAGMA query_only`. Qualquer INSERT, UPDATE ou DELETE falha.
 *
 * O InfoCAIJ grava o banco de forma atômica (escreve um arquivo novo e renomeia),
 * então abrir a cada consulta garante dados atuais sem segurar um arquivo antigo.
 */
export function openReadOnly(filePath: string): DatabaseSync {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Banco não encontrado em ${resolved}. Defina INFOCAIJ_DB_PATH.`);
  }
  const db = new DatabaseSync(resolved, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  return db;
}

function openSqlite(filePath: string): Db {
  const db = openReadOnly(filePath);
  return {
    async all(sql, params = {}) {
      assertReadOnlySql(sql);
      return db.prepare(sql).all(params as never) as Row[];
    },
    async get(sql, params = {}) {
      assertReadOnlySql(sql);
      return db.prepare(sql).get(params as never) as Row | undefined;
    },
    async close() {
      db.close();
    },
  };
}

export async function openDb(source: Source): Promise<Db> {
  if (source.kind === 'sqlite') return openSqlite(source.path);
  if (source.kind === 'postgres') return openPostgres(source.url);
  return source.open();
}

export async function withDb<T>(source: Source, fn: (db: Db) => Promise<T>): Promise<T> {
  const db = await openDb(source);
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

export function all(db: Db, sql: string, params: Record<string, unknown> = {}): Promise<Row[]> {
  return db.all(sql, params);
}

export function get(db: Db, sql: string, params: Record<string, unknown> = {}): Promise<Row | undefined> {
  return db.get(sql, params);
}
