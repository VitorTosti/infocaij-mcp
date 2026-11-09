import type { Db, Row } from './db.ts';
import { assertReadOnlySql } from './db.ts';

/**
 * Adaptador PostgreSQL, para o InfoCAIJ em produção.
 *
 * O driver `pg` é opcional: o servidor continua sem dependências para quem usa SQLite, e só quem
 * define INFOCAIJ_DATABASE_URL precisa de `npm install pg`.
 *
 * Somente leitura em três camadas: a sessão abre com `default_transaction_read_only=on`, o adaptador
 * só aceita SELECT, e o README recomenda um papel do banco que tenha apenas SELECT.
 */

/** Converte `$nome` (estilo SQLite) em `$1, $2...` (estilo PostgreSQL), reaproveitando o mesmo número. */
export function toPositional(sql: string, params: Record<string, unknown>): { text: string; values: unknown[] } {
  const order: string[] = [];
  const text = sql.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_all, name: string) => {
    if (!(name in params) && !(`$${name}` in params)) throw new Error(`Parâmetro sem valor: $${name}`);
    let index = order.indexOf(name);
    if (index === -1) index = order.push(name) - 1;
    return `$${index + 1}`;
  });
  const values = order.map((name) => (name in params ? params[name] : params[`$${name}`]));
  return { text, values };
}

/** O `pg` devolve datas como Date e contagens como texto; o resto do servidor espera ISO e números. */
export function normalizeRow(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) out[key] = value instanceof Date ? value.toISOString() : value;
  return out;
}

interface PgClient {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  end(): Promise<void>;
}

export type PgLoader = () => Promise<{ Client?: new (config: Record<string, unknown>) => PgClient; default?: { Client: new (config: Record<string, unknown>) => PgClient } }>;

const defaultLoader: PgLoader = async () => {
  try {
    return await import('pg' as string);
  } catch {
    throw new Error('Para usar PostgreSQL instale o driver: npm install pg');
  }
};

export async function openPostgres(url: string, load: PgLoader = defaultLoader): Promise<Db> {
  const mod = await load();
  const Client = mod.Client ?? mod.default?.Client;
  if (!Client) throw new Error('Driver pg inválido: Client não encontrado.');

  const timeout = Number(process.env.INFOCAIJ_MCP_TIMEOUT_MS ?? 30_000);
  const client = new Client({
    connectionString: url,
    application_name: 'infocaij-mcp',
    options: `-c default_transaction_read_only=on -c statement_timeout=${timeout} -c idle_in_transaction_session_timeout=${timeout}`,
  });
  await client.connect();
  await client.query('SET default_transaction_read_only = on');

  async function run(sql: string, params: Record<string, unknown>) {
    assertReadOnlySql(sql);
    const { text, values } = toPositional(sql, params);
    const result = await client.query(text, values);
    return result.rows.map(normalizeRow);
  }

  return {
    all: (sql, params = {}) => run(sql, params),
    async get(sql, params = {}) {
      return (await run(sql, params))[0];
    },
    close: () => client.end(),
  };
}
