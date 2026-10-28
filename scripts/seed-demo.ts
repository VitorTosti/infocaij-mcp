/**
 * Gera um banco de demonstração com o mesmo esquema do InfoCAIJ e dados 100% inventados.
 *
 *   node scripts/seed-demo.ts [saida.sqlite] [agora-ISO]
 *
 * A simulação reproduz o ritmo da operação real (cerca de 300 máquinas por mês),
 * com uma etapa mais lenta (nota fiscal) para que a análise de gargalo tenha o que mostrar.
 * Nomes, e-mails e telefones de clientes são falsos e existem só para os testes
 * provarem que o servidor nunca os devolve.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { STATUSES, CHECKLIST_LABELS, type Status } from '../src/domain.ts';

export const DEFAULT_NOW = '2026-10-28T21:00:00.000Z';

export const SCHEMA = `
CREATE TABLE sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, platform TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT 'CAIJ', is_priority INTEGER NOT NULL DEFAULT 0,
  seller_name TEXT NOT NULL DEFAULT '', order_reference TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL, internal_code TEXT NOT NULL UNIQUE,
  product_name TEXT NOT NULL, status TEXT NOT NULL, technician TEXT, serial_number TEXT, real_os TEXT,
  withdrawn_by TEXT, withdrawn_recipient TEXT, withdrawn_at TEXT, packaged_by TEXT, packaged_at TEXT,
  checklist TEXT NOT NULL, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  nf_number TEXT, bundle_id INTEGER, commercial_state TEXT NOT NULL DEFAULT 'active',
  FOREIGN KEY (sale_id) REFERENCES sales(id)
);
CREATE TABLE item_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, event_type TEXT NOT NULL,
  description TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE product_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, times_used INTEGER NOT NULL,
  last_used_at TEXT NOT NULL, stock INTEGER NOT NULL DEFAULT 0, price REAL, location TEXT,
  import_key TEXT, catalog_details TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE stock_lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, entry_date TEXT NOT NULL, store TEXT NOT NULL,
  source_file_name TEXT NOT NULL, imported_by_user_id INTEGER NOT NULL, imported_by_name TEXT NOT NULL,
  row_count INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
);
CREATE TABLE stock_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'recebida',
  serial_number TEXT, os_number TEXT, model TEXT, technician TEXT, notes TEXT, store TEXT, triage_at TEXT,
  ready_at TEXT, sold_at TEXT, sale_item_id INTEGER, created_at TEXT NOT NULL, location TEXT, lot_id INTEGER,
  asset_id TEXT, source_row_number INTEGER, import_metadata TEXT
);
CREATE TABLE machine_lifecycle_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, serial TEXT NOT NULL, stock_unit_id INTEGER,
  action TEXT NOT NULL, reason TEXT NOT NULL, actor_id INTEGER NOT NULL, actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL, previous_state TEXT NOT NULL, next_state TEXT NOT NULL
);
CREATE TABLE warranties (
  id TEXT PRIMARY KEY, serial TEXT NOT NULL UNIQUE COLLATE NOCASE, tracker TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL, created_by_user_id INTEGER NOT NULL, created_by_name TEXT NOT NULL,
  purchase_date TEXT NOT NULL, warranty_months INTEGER NOT NULL DEFAULT 12, company TEXT NOT NULL DEFAULT 'CAIJ',
  product_name TEXT, sale_item_id INTEGER, order_number TEXT, invoice_number TEXT,
  link_source TEXT NOT NULL DEFAULT 'manual', activated_at TEXT, expires_at TEXT,
  full_name TEXT, email TEXT, phone TEXT
);
CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, document TEXT, email TEXT, phone TEXT, created_at TEXT NOT NULL
);
`;

// Gerador pseudoaleatório com semente: o mesmo comando gera sempre o mesmo banco.
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedDemo(outPath: string, nowIso = DEFAULT_NOW) {
  const random = rng(20261028);
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)];
  const chance = (p: number) => random() < p;
  /** Duração log-normal em horas a partir da mediana e de um fator de dispersão. */
  const hours = (median: number, spread = 0.6) => {
    const u = Math.max(random(), 1e-9);
    const v = random();
    const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return median * Math.exp(spread * normal);
  };

  const now = new Date(nowIso);
  const HOUR = 3_600_000;
  const iso = (ms: number) => new Date(ms).toISOString();

  if (fs.existsSync(outPath)) fs.rmSync(outPath);
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  const db = new DatabaseSync(outPath);
  db.exec(SCHEMA);

  const technicians = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elias'];
  const sellers = ['Fábio', 'Gabi', 'Hugo', 'Iris'];
  const platforms = ['Mercado Livre', 'Mercado Livre', 'Shopee', 'Shopee', 'Venda Interna', 'Venda Externa', 'Cassio'] as const;
  const companies = ['CAIJ', 'CAIJ', 'CAIJ', 'AIJ', 'CRIGOR'] as const;
  const products = [
    'Notebook Dell Latitude 5490 i5 8GB 256GB SSD',
    'Notebook Dell Latitude 7480 i7 16GB 512GB SSD',
    'Notebook Lenovo ThinkPad T480 i5 8GB 256GB SSD',
    'Notebook Lenovo ThinkPad E14 i5 16GB 256GB SSD',
    'Notebook HP EliteBook 840 G5 i5 8GB 256GB SSD',
    'Notebook HP ProBook 440 G6 i3 8GB 240GB SSD',
    'MacBook Air M1 8GB 256GB',
    'Desktop Dell OptiPlex 7060 i5 8GB 240GB SSD',
  ];
  // Mediana e dispersão de cada etapa, em horas. A nota fiscal é a etapa lenta de propósito.
  const stageTime: Record<Exclude<Status, 'Entregue/Enviada'>, [number, number]> = {
    'Pendente': [3, 0.7],
    'Em preparacao': [5, 0.6],
    'Aguardando teste': [2.5, 0.6],
    'Pronta': [1.5, 0.7],
    'Aguardando retirada': [4, 0.8],
    'Aguardando nota fiscal': [26, 0.75],
    'Aguardando embalagem': [3, 0.6],
  };

  const insertProduct = db.prepare(
    `INSERT INTO product_suggestions (name, times_used, last_used_at, stock) VALUES (?, 0, ?, 0)`,
  );
  const productIds = products.map((name) => Number(insertProduct.run(name, nowIso).lastInsertRowid));

  const insertSale = db.prepare(
    `INSERT INTO sales (date, platform, company, is_priority, seller_name, order_reference, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '', ?, ?)`,
  );
  const insertItem = db.prepare(
    `INSERT INTO sale_items (sale_id, internal_code, product_name, status, technician, serial_number, real_os,
       withdrawn_by, withdrawn_recipient, withdrawn_at, packaged_by, packaged_at, checklist, notes, created_at,
       updated_at, nf_number, commercial_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
  );
  const insertHistory = db.prepare(
    `INSERT INTO item_history (item_id, event_type, description, created_at) VALUES (?, ?, ?, ?)`,
  );
  const insertLifecycle = db.prepare(
    `INSERT INTO machine_lifecycle_events (item_id, serial, stock_unit_id, action, reason, actor_id, actor_name,
       created_at, previous_state, next_state) VALUES (?, ?, NULL, ?, ?, 1, 'Gestão', ?, 'active', ?)`,
  );
  const insertWarranty = db.prepare(
    `INSERT INTO warranties (id, serial, tracker, created_at, created_by_user_id, created_by_name, purchase_date,
       warranty_months, company, product_name, sale_item_id, order_number, invoice_number, link_source,
       activated_at, expires_at, full_name, email, phone)
     VALUES (?, ?, ?, ?, 1, 'Gestão', ?, ?, ?, ?, ?, ?, ?, 'local_sale', ?, ?, ?, ?, ?)`,
  );

  db.exec('BEGIN');
  let itemCounter = 0;
  const DAYS = 45;
  for (let day = DAYS; day >= 0; day--) {
    const dayStart = new Date(now.getTime() - day * 24 * HOUR);
    const weekday = dayStart.getUTCDay();
    if (weekday === 0) continue;
    const salesToday = weekday === 6 ? 2 + Math.floor(random() * 3) : 7 + Math.floor(random() * 6);

    for (let s = 0; s < salesToday; s++) {
      const createdMs = Date.UTC(dayStart.getUTCFullYear(), dayStart.getUTCMonth(), dayStart.getUTCDate(), 12, 0) + random() * 8 * HOUR;
      if (createdMs > now.getTime()) continue;
      const date = iso(createdMs).slice(0, 10);
      const platform = pick(platforms);
      const company = pick(companies);
      const priority = chance(0.12) ? 1 : 0;
      const saleId = Number(
        insertSale.run(date, platform, company, priority, pick(sellers), `PED-${100000 + Math.floor(random() * 899999)}`, iso(createdMs), iso(createdMs)).lastInsertRowid,
      );
      const quantity = chance(0.75) ? 1 : chance(0.6) ? 2 : 3 + Math.floor(random() * 2);
      const product = pick(products);

      for (let q = 0; q < quantity; q++) {
        itemCounter++;
        const code = `CAIJ-${String(itemCounter).padStart(4, '0')}`;
        const serial = `${pick(['5CG', 'PF', 'CN', 'C02', 'J'])}${Math.floor(random() * 1e7).toString(36).toUpperCase().padStart(5, '0')}`;
        const os = String(20000 + itemCounter);
        const technician = pick(technicians);

        // Percorre a fila até chegar ao fim ou ao "agora".
        const events: Array<{ at: number; text: string; type: 'created' | 'updated' }> = [
          { at: createdMs, text: `Item criado na bancada com codigo ${code}.`, type: 'created' },
        ];
        let status: Status = 'Pendente';
        let t = createdMs;
        let assigned = false;
        let checklistDone = false;
        let nf: string | null = null;
        let withdrawnAt: number | null = null;
        let packagedAt: number | null = null;
        const failed = chance(0.08) ? pick(CHECKLIST_LABELS) : null;
        while (status !== 'Entregue/Enviada') {
          const [median, spread] = stageTime[status as Exclude<Status, 'Entregue/Enviada'>];
          const leave = t + hours(median * (priority ? 0.6 : 1), spread) * HOUR;
          if (leave > now.getTime()) break;
          const next = STATUSES[STATUSES.indexOf(status) + 1];
          if (next === 'Em preparacao') assigned = true;
          if (next === 'Em preparacao') events.push({ at: leave - 60_000, text: `OS vinculada: ${os}.`, type: 'updated' });
          if (next === 'Pronta') {
            checklistDone = true;
            events.push({ at: leave - 60_000, text: 'Checklist tecnico atualizado.', type: 'updated' });
          }
          if (status === 'Aguardando retirada') withdrawnAt = leave;
          if (status === 'Aguardando nota fiscal') nf = String(5000 + itemCounter);
          if (status === 'Aguardando embalagem') packagedAt = leave;
          events.push({ at: leave, text: `Status alterado de ${status} para ${next}.`, type: 'updated' });
          status = next;
          t = leave;
        }

        let commercialState = 'active';
        let lifecycle: { action: 'cancel' | 'return'; reason: string; at: number } | null = null;
        if (status !== 'Entregue/Enviada' && chance(0.03)) {
          commercialState = 'cancelled';
          lifecycle = { action: 'cancel', reason: 'Cliente desistiu antes do envio', at: t + HOUR };
        } else if (status === 'Entregue/Enviada' && chance(0.025)) {
          commercialState = 'returned';
          lifecycle = { action: 'return', reason: 'Arrependimento dentro de 7 dias', at: t + 72 * HOUR };
        }
        if (lifecycle && lifecycle.at > now.getTime()) {
          lifecycle = null;
          commercialState = 'active';
        }

        const checklist = Object.fromEntries(
          CHECKLIST_LABELS.map((label) => [label, checklistDone ? (label === failed ? 'reprovado' : 'aprovado') : 'nao_testado']),
        );
        const last = events[events.length - 1].at;
        const itemId = Number(
          insertItem.run(
            saleId, code, product, status, assigned ? technician : null, assigned ? serial : null, assigned ? os : null,
            withdrawnAt ? pick(sellers) : null, withdrawnAt ? company : null, withdrawnAt ? iso(withdrawnAt) : null,
            packagedAt ? technician : null, packagedAt ? iso(packagedAt) : null,
            JSON.stringify(checklist), iso(createdMs), iso(last), nf, commercialState,
          ).lastInsertRowid,
        );
        for (const event of events) insertHistory.run(itemId, event.type, event.text, iso(event.at));
        if (lifecycle) {
          const label = lifecycle.action === 'cancel' ? 'Cancelamento' : 'Devolução recebida';
          insertHistory.run(itemId, 'updated', `${label} por Gestão: ${lifecycle.reason}.`, iso(lifecycle.at));
          insertLifecycle.run(itemId, serial, lifecycle.action, lifecycle.reason, iso(lifecycle.at), lifecycle.action === 'cancel' ? 'cancelled' : 'returned');
        }

        // Garantia com dados pessoais FALSOS, para provar que nunca saem pelo MCP.
        if (status === 'Entregue/Enviada' && chance(0.7)) {
          const activated = chance(0.6) ? t + 48 * HOUR : null;
          const months = pick([3, 6, 12]);
          insertWarranty.run(
            `w-${itemId}`, serial, `QR${itemId}`, iso(t), date, months, company, product, itemId, `PED-${saleId}`, nf,
            activated && activated < now.getTime() ? iso(activated) : null,
            activated ? iso(activated + months * 30 * 24 * HOUR) : null,
            `Cliente Ficticio ${itemId}`, `cliente${itemId}@exemplo.invalid`, `+55 11 90000-${String(itemId).padStart(4, '0')}`,
          );
        }
      }
    }
  }

  // Lotes e estoque.
  const lotId = Number(
    db.prepare(
      `INSERT INTO stock_lots (name, entry_date, store, source_file_name, imported_by_user_id, imported_by_name, row_count, created_at, updated_at)
       VALUES ('Lote demonstração 07', ?, 'CAIJ', 'lote-07.xlsx', 1, 'Gestão', 120, ?, ?)`,
    ).run(nowIso.slice(0, 10), nowIso, nowIso).lastInsertRowid,
  );
  const insertUnit = db.prepare(
    `INSERT INTO stock_units (product_id, status, serial_number, model, store, location, lot_id, created_at, triage_at, ready_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let u = 0; u < 160; u++) {
    const index = Math.floor(random() * products.length);
    const status = pick(['recebida', 'em_triagem', 'em_triagem', 'pronta', 'pronta', 'pronta', 'vendida']);
    const created = now.getTime() - random() * 40 * 24 * HOUR;
    insertUnit.run(
      productIds[index], status, `EST${String(u).padStart(5, '0')}`, null, pick(['CAIJ', 'CAIJ', 'AIJ', 'CRIGOR']),
      `Prateleira ${1 + Math.floor(random() * 12)}`, lotId, iso(created),
      status === 'recebida' ? null : iso(created + 24 * HOUR), status === 'pronta' || status === 'vendida' ? iso(created + 72 * HOUR) : null,
    );
  }

  // Base de clientes com dados FALSOS.
  const insertCustomer = db.prepare(`INSERT INTO customers (name, document, email, phone, created_at) VALUES (?, ?, ?, ?, ?)`);
  for (let c = 1; c <= 200; c++) {
    insertCustomer.run(`Cliente Ficticio ${c}`, `000.000.${String(c).padStart(3, '0')}-00`, `cliente${c}@exemplo.invalid`, `+55 11 90000-${String(c).padStart(4, '0')}`, nowIso);
  }

  db.exec('COMMIT');
  const counts = {
    vendas: Number((db.prepare('SELECT COUNT(*) AS n FROM sales').get() as { n: number }).n),
    maquinas: Number((db.prepare('SELECT COUNT(*) AS n FROM sale_items').get() as { n: number }).n),
    eventos: Number((db.prepare('SELECT COUNT(*) AS n FROM item_history').get() as { n: number }).n),
  };
  db.close();
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const out = process.argv[2] ?? 'demo/infocaij-demo.sqlite';
  const counts = seedDemo(out, process.argv[3] ?? DEFAULT_NOW);
  console.log(`Banco de demonstração criado em ${out}:`, counts);
}
