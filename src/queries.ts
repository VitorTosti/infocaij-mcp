import { all, get, type Db, type Row } from './db.ts';
import { DEFAULT_SCHEDULE, businessHoursBetween, describeSchedule, type Schedule } from './horario.ts';
import { CHECKLIST_LABELS, FINAL_STATUS, STATUSES, parseStatusChange, type Status } from './domain.ts';

/**
 * Consultas somente leitura sobre o InfoCAIJ.
 *
 * Regra de privacidade: nenhuma função seleciona colunas de clientes
 * (tabelas customers*, nome/e-mail/telefone de garantias). As colunas
 * devolvidas são listadas explicitamente; não há SELECT *.
 */

const HOUR = 3_600_000;

export interface Clock {
  now: Date;
  /** Expediente usado quando a consulta pede horas úteis. */
  schedule?: Schedule;
}

export type Horas = 'corridas' | 'uteis';

/** Tempo entre dois instantes, em horas corridas ou úteis. */
function span(fromMs: number, toMs: number, clock: Clock, modo: Horas): number {
  return modo === 'uteis' ? businessHoursBetween(fromMs, toMs, clock.schedule ?? DEFAULT_SCHEDULE) : (toMs - fromMs) / HOUR;
}

function modoInfo(clock: Clock, modo: Horas) {
  return modo === 'uteis'
    ? { horas: modo, horario_util: describeSchedule(clock.schedule ?? DEFAULT_SCHEDULE) }
    : { horas: modo };
}

// ---------------------------------------------------------------- utilidades

function hoursBetween(fromIso: string, to: Date): number {
  return (to.getTime() - Date.parse(fromIso)) / HOUR;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function daysAgo(clock: Clock, days: number): Date {
  return new Date(clock.now.getTime() - days * 24 * HOUR);
}

const ACTIVE = "COALESCE(i.commercial_state, 'active') = 'active'";

// ------------------------------------------------------- linha do tempo por item

interface Stay {
  status: Status;
  enteredAt: string;
  leftAt: string | null;
}

interface Timeline {
  itemId: number;
  internalCode: string;
  productName: string;
  status: Status;
  technician: string | null;
  platform: string;
  company: string;
  priority: boolean;
  stays: Stay[];
}

/**
 * Quais máquinas carregar. Só máquinas ativas (não canceladas nem devolvidas) entram nos cálculos.
 * - `open`: só as que ainda não foram entregues.
 * - `{ since }`: as em aberto mais as que tiveram alguma mudança de etapa (ou foram criadas) desde
 *   `since`. Toda passagem concluída, chegada ou entrega no período é uma mudança no período, então o
 *   resultado é o mesmo de carregar tudo, sem ler o histórico de meses de máquinas já entregues.
 */
type Scope = 'open' | { since: string };

function scopeFilter(scope: Scope): { where: string; params: Record<string, unknown> } {
  const open = `i.status <> $final`;
  if (scope === 'open') return { where: `${ACTIVE} AND ${open}`, params: { $final: FINAL_STATUS } };
  return {
    // IN com subconsulta independente (calculada uma vez), e não EXISTS correlacionado: sem índice em
    // item_history.item_id, o EXISTS percorreria o histórico inteiro para cada linha.
    where: `${ACTIVE} AND (${open} OR i.created_at >= $since OR i.id IN (
              SELECT c.item_id FROM item_history c
               WHERE c.created_at >= $since AND c.description LIKE 'Status alterado de %'))`,
    params: { $final: FINAL_STATUS, $since: scope.since },
  };
}

/**
 * Reconstrói quanto tempo cada máquina passou em cada etapa a partir do
 * histórico ("Status alterado de X para Y."). A primeira etapa começa na
 * criação do item.
 */
async function loadTimelines(db: Db, scope: Scope): Promise<Timeline[]> {
  const { where, params } = scopeFilter(scope);
  const items = await all(
    db,
    `SELECT i.id, i.internal_code, i.product_name, i.status, i.technician, i.created_at,
            s.platform, s.company, s.is_priority
       FROM sale_items i JOIN sales s ON s.id = i.sale_id
      WHERE ${where}
      ORDER BY i.id`,
    params,
  );
  // O histórico completo de cada máquina escolhida: as etapas anteriores ao período definem onde ela estava.
  const history = await all(
    db,
    `SELECT h.item_id, h.description, h.created_at FROM item_history h JOIN sale_items i ON i.id = h.item_id
      WHERE h.description LIKE 'Status alterado de %' AND ${where}
      ORDER BY h.item_id, h.created_at, h.id`,
    params,
  );

  const changesByItem = new Map<number, Row[]>();
  for (const row of history) {
    const id = Number(row.item_id);
    const list = changesByItem.get(id) ?? [];
    list.push(row);
    changesByItem.set(id, list);
  }

  return items.map((item) => {
    const changes = (changesByItem.get(Number(item.id)) ?? [])
      .map((row) => ({ at: String(row.created_at), change: parseStatusChange(String(row.description)) }))
      .filter((entry): entry is { at: string; change: { from: Status; to: Status } } => entry.change !== null);

    const firstStatus = changes[0]?.change.from ?? (item.status as Status);
    const stays: Stay[] = [{ status: firstStatus, enteredAt: String(item.created_at), leftAt: null }];
    for (const { at, change } of changes) {
      stays[stays.length - 1].leftAt = at;
      stays.push({ status: change.to, enteredAt: at, leftAt: null });
    }

    return {
      itemId: Number(item.id),
      internalCode: String(item.internal_code),
      productName: String(item.product_name),
      status: item.status as Status,
      technician: (item.technician as string | null) ?? null,
      platform: String(item.platform),
      company: String(item.company),
      priority: Number(item.is_priority) === 1,
      stays,
    };
  });
}

function currentStay(timeline: Timeline): Stay {
  return timeline.stays[timeline.stays.length - 1];
}

// ------------------------------------------------------------------- ferramentas

export async function resumoFila(db: Db, clock: Clock) {
  const open = await loadTimelines(db, 'open');

  const etapas = STATUSES.filter((s) => s !== FINAL_STATUS).map((status) => {
    const here = open.filter((t) => t.status === status);
    const ages = here.map((t) => hoursBetween(currentStay(t).enteredAt, clock.now));
    return {
      etapa: status,
      maquinas: here.length,
      prioritarias: here.filter((t) => t.priority).length,
      mais_antiga_horas: ages.length ? round1(Math.max(...ages)) : null,
    };
  });

  const since = daysAgo(clock, 7).toISOString();
  const delivered = await get(
    db,
    `SELECT COUNT(DISTINCT h.item_id) AS n FROM item_history h JOIN sale_items i ON i.id = h.item_id
      WHERE h.description LIKE '%para Entregue/Enviada.' AND h.created_at >= $since AND ${ACTIVE}`,
    { $since: since },
  );

  return {
    gerado_em: clock.now.toISOString(),
    maquinas_em_aberto: open.length,
    entregues_ultimos_7_dias: Number(delivered?.n ?? 0),
    etapas,
  };
}

export async function itensParados(
  db: Db,
  clock: Clock,
  args: { etapa?: Status; horas_minimas: number; limite: number; horas?: Horas },
) {
  const modo = args.horas ?? 'corridas';
  const stuck = (await loadTimelines(db, 'open'))
    .filter((t) => !args.etapa || t.status === args.etapa)
    .map((t) => ({ t, hours: span(Date.parse(currentStay(t).enteredAt), clock.now.getTime(), clock, modo) }))
    .filter(({ hours }) => hours >= args.horas_minimas)
    .sort((a, b) => b.hours - a.hours);

  return {
    criterio: `${args.etapa ?? 'qualquer etapa'} há pelo menos ${args.horas_minimas} h${modo === 'uteis' ? ' úteis' : ''}`,
    ...modoInfo(clock, modo),
    total: stuck.length,
    itens: stuck.slice(0, args.limite).map(({ t, hours }) => ({
      codigo: t.internalCode,
      produto: t.productName,
      etapa: t.status,
      horas_na_etapa: round1(hours),
      desde: currentStay(t).enteredAt,
      tecnico: t.technician,
      plataforma: t.platform,
      empresa: t.company,
      prioridade: t.priority,
    })),
  };
}

const WEEK = 7 * 24 * HOUR;

/** Passagens concluídas, gargalo e tempo de venda até entrega para saídas em [fromMs, toMs). */
function stageStats(timelines: Timeline[], fromMs: number, toMs: number, clock: Clock, modo: Horas) {
  const inWindow = (iso: string) => {
    const t = Date.parse(iso);
    return t >= fromMs && t < toMs;
  };
  const etapas = STATUSES.filter((s) => s !== FINAL_STATUS).map((status) => {
    const durations = timelines
      .flatMap((t) => t.stays)
      .filter((stay) => stay.status === status && stay.leftAt && inWindow(stay.leftAt))
      .map((stay) => span(Date.parse(stay.enteredAt), Date.parse(stay.leftAt as string), clock, modo))
      .sort((a, b) => a - b);
    return {
      etapa: status,
      passagens: durations.length,
      mediana_horas: round1(percentile(durations, 0.5)),
      p90_horas: round1(percentile(durations, 0.9)),
      horas_totais: Math.round(durations.reduce((sum, h) => sum + h, 0)),
      participacao_pct: 0,
    };
  });

  // Gargalo = etapa onde as máquinas somam mais horas paradas. A mediana sozinha esconde
  // etapas em que a maioria passa rápido, mas algumas ficam dias (cauda longa).
  const total = etapas.reduce((sum, e) => sum + e.horas_totais, 0);
  for (const e of etapas) e.participacao_pct = total ? Math.round((e.horas_totais / total) * 100) : 0;
  const ranked = etapas.filter((e) => e.passagens >= 5).sort((a, b) => b.horas_totais - a.horas_totais);

  const leadTimes = timelines
    .filter((t) => t.status === FINAL_STATUS)
    .map((t) => ({ start: t.stays[0].enteredAt, end: currentStay(t).enteredAt }))
    .filter(({ end }) => inWindow(end))
    .map(({ start, end }) => span(Date.parse(start), Date.parse(end), clock, modo))
    .sort((a, b) => a - b);

  return {
    etapas,
    gargalo: ranked[0]?.etapa ?? null,
    venda_ate_entrega: {
      maquinas: leadTimes.length,
      mediana_horas: round1(percentile(leadTimes, 0.5)),
      p90_horas: round1(percentile(leadTimes, 0.9)),
    },
  };
}

export async function tempoPorEtapa(db: Db, clock: Clock, args: { dias: number; horas?: Horas; por_semana?: boolean }) {
  const modo = args.horas ?? 'corridas';
  const now = clock.now.getTime();
  const since = daysAgo(clock, args.dias).getTime();
  // Semanas de 7 dias terminando agora, da mais antiga para a mais recente, cobrindo o período inteiro.
  const weeks = args.por_semana ? Math.ceil(args.dias / 7) : 0;
  const earliest = Math.min(since, now - weeks * WEEK);
  const timelines = await loadTimelines(db, { since: new Date(earliest).toISOString() });

  // Sem limite superior: um evento registrado depois de `now` (relógio fixo em demonstrações) entra no
  // período atual, como sempre entrou.
  const { etapas, gargalo, venda_ate_entrega } = stageStats(timelines, since, Infinity, clock, modo);

  const semanas = Array.from({ length: weeks }, (_, i) => {
    const start = now - (weeks - i) * WEEK;
    const end = now - (weeks - i - 1) * WEEK;
    const week = stageStats(timelines, start, i === weeks - 1 ? Infinity : end, clock, modo);
    return {
      inicio: new Date(start).toISOString(),
      fim: new Date(end).toISOString(),
      passagens: week.etapas.reduce((sum, e) => sum + e.passagens, 0),
      gargalo: week.gargalo,
      venda_ate_entrega: week.venda_ate_entrega,
      etapas: week.etapas.map(({ etapa, passagens, mediana_horas, horas_totais }) => ({ etapa, passagens, mediana_horas, horas_totais })),
    };
  });

  return {
    periodo_dias: args.dias,
    ...modoInfo(clock, modo),
    observacao:
      (modo === 'uteis' ? 'Horas úteis (fora do expediente não conta). ' : 'Horas corridas, não horas úteis. ') +
      'Considera só passagens concluídas no período. ' +
      'Gargalo é a etapa com mais horas_totais (soma do tempo de todas as máquinas), não a de maior mediana.' +
      (weeks
        ? ` semanas: ${weeks} blocos de 7 dias terminando agora, do mais antigo ao mais recente; ` +
          'gargalo da semana exige pelo menos 5 passagens na etapa, senão vem null.'
        : ''),
    gargalo,
    etapas_sem_uso: etapas.filter((e) => e.passagens === 0).map((e) => e.etapa),
    venda_ate_entrega,
    etapas,
    ...(weeks ? { semanas } : {}),
  };
}

export const VENDA_REGISTRADA = 'Venda registrada';

/**
 * Tempo entre dois pontos da fila, por máquina.
 * Início: criação do item (venda registrada) ou primeira entrada na etapa `de`.
 * Fim: primeira vez que a máquina chega à etapa `ate` OU a uma etapa posterior,
 * porque a equipe às vezes pula etapas. Quantas pularam é informado à parte.
 */
export async function tempoEntreEtapas(
  db: Db,
  clock: Clock,
  args: { de: string; ate: Status; dias: number; agrupar_por?: 'tecnico' | 'plataforma' | 'empresa'; horas?: Horas },
) {
  const modo = args.horas ?? 'corridas';
  const since = daysAgo(clock, args.dias).getTime();
  const targetIndex = STATUSES.indexOf(args.ate);
  const fromIndex = args.de === VENDA_REGISTRADA ? -1 : STATUSES.indexOf(args.de as Status);
  if (fromIndex >= targetIndex) {
    throw new Error(`"${args.de}" precisa vir antes de "${args.ate}" na fila.`);
  }

  const measured: Array<{ hours: number; skipped: boolean; group: string }> = [];
  let notYet = 0;
  for (const t of await loadTimelines(db, { since: new Date(since).toISOString() })) {
    const start =
      fromIndex === -1 ? t.stays[0].enteredAt : t.stays.find((s) => STATUSES.indexOf(s.status) === fromIndex)?.enteredAt;
    if (!start) continue;
    const arrival = t.stays.find(
      (s) => Date.parse(s.enteredAt) >= Date.parse(start) && STATUSES.indexOf(s.status) >= targetIndex && s !== t.stays[0],
    );
    if (!arrival) {
      notYet++;
      continue;
    }
    if (Date.parse(arrival.enteredAt) < since) continue;
    const group =
      args.agrupar_por === 'tecnico' ? t.technician ?? 'Sem técnico'
      : args.agrupar_por === 'plataforma' ? t.platform
      : args.agrupar_por === 'empresa' ? t.company
      : 'todas';
    measured.push({
      hours: span(Date.parse(start), Date.parse(arrival.enteredAt), clock, modo),
      skipped: arrival.status !== args.ate,
      group,
    });
  }

  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      maquinas: sorted.length,
      media_horas: sorted.length ? round1(sorted.reduce((sum, h) => sum + h, 0) / sorted.length) : 0,
      mediana_horas: round1(percentile(sorted, 0.5)),
      p90_horas: round1(percentile(sorted, 0.9)),
    };
  };

  const groups = [...new Set(measured.map((m) => m.group))]
    .map((group) => ({ grupo: group, ...stats(measured.filter((m) => m.group === group).map((m) => m.hours)) }))
    .sort((a, b) => b.maquinas - a.maquinas || a.grupo.localeCompare(b.grupo, 'pt-BR'));

  return {
    de: args.de,
    ate: args.ate,
    periodo_dias: args.dias,
    ...modoInfo(clock, modo),
    observacao:
      (modo === 'uteis' ? 'Horas úteis. ' : 'Horas corridas. ') +
      'Conta máquinas que chegaram ao destino no período. ' +
      'A média é puxada por poucos casos muito longos; a mediana mostra o caso típico.',
    ...stats(measured.map((m) => m.hours)),
    chegaram_pulando_a_etapa: measured.filter((m) => m.skipped).length,
    ainda_nao_chegaram: notYet,
    ...(args.agrupar_por ? { por_grupo: groups } : {}),
  };
}

export async function produtividade(db: Db, clock: Clock, args: { dias: number }) {
  const since = daysAgo(clock, args.dias).toISOString();
  const rows = await all(
    db,
    `SELECT COALESCE(i.technician, 'Sem técnico') AS tecnico,
            SUM(CASE WHEN h.description LIKE '%para Pronta.' THEN 1 ELSE 0 END) AS prontas,
            SUM(CASE WHEN h.description LIKE '%para Entregue/Enviada.' THEN 1 ELSE 0 END) AS entregues
       FROM item_history h JOIN sale_items i ON i.id = h.item_id
      WHERE h.created_at >= $since AND ${ACTIVE}
        AND (h.description LIKE '%para Pronta.' OR h.description LIKE '%para Entregue/Enviada.')
      GROUP BY tecnico ORDER BY prontas DESC, tecnico`,
    { $since: since },
  );
  const perDay = await all(
    db,
    `SELECT substr(h.created_at, 1, 10) AS dia, COUNT(*) AS prontas
       FROM item_history h JOIN sale_items i ON i.id = h.item_id
      WHERE h.created_at >= $since AND h.description LIKE '%para Pronta.' AND ${ACTIVE}
      GROUP BY dia ORDER BY dia`,
    { $since: since },
  );

  return {
    periodo_dias: args.dias,
    por_tecnico: rows.map((r) => ({ tecnico: String(r.tecnico), prontas: Number(r.prontas), entregues: Number(r.entregues) })),
    prontas_por_dia: perDay.map((r) => ({ dia: String(r.dia), prontas: Number(r.prontas) })),
  };
}

const GROUP_COLUMNS = {
  plataforma: 's.platform',
  empresa: 's.company',
  vendedor: "COALESCE(NULLIF(s.seller_name, ''), 'Não informado')",
  dia: 's.date',
} as const;

export type Agrupamento = keyof typeof GROUP_COLUMNS;

export async function vendas(db: Db, clock: Clock, args: { dias: number; agrupar_por: Agrupamento }) {
  const since = daysAgo(clock, args.dias).toISOString().slice(0, 10);
  const column = GROUP_COLUMNS[args.agrupar_por];
  const rows = await all(
    db,
    `SELECT ${column} AS grupo,
            COUNT(DISTINCT s.id) AS pedidos,
            COUNT(i.id) AS maquinas,
            SUM(CASE WHEN COALESCE(i.commercial_state, 'active') = 'cancelled' THEN 1 ELSE 0 END) AS canceladas,
            SUM(CASE WHEN COALESCE(i.commercial_state, 'active') = 'returned' THEN 1 ELSE 0 END) AS devolvidas
       FROM sales s JOIN sale_items i ON i.sale_id = s.id
      WHERE s.date >= $since
      GROUP BY grupo ORDER BY ${args.agrupar_por === 'dia' ? 'grupo' : 'maquinas DESC, grupo'}`,
    { $since: since },
  );
  const grupos = rows.map((r) => ({
    [args.agrupar_por]: String(r.grupo),
    pedidos: Number(r.pedidos),
    maquinas: Number(r.maquinas),
    canceladas: Number(r.canceladas),
    devolvidas: Number(r.devolvidas),
  }));
  return {
    periodo_dias: args.dias,
    total_pedidos: grupos.reduce((sum, g) => sum + g.pedidos, 0),
    total_maquinas: grupos.reduce((sum, g) => sum + g.maquinas, 0),
    grupos,
  };
}

export async function estoque(db: Db, args: { loja?: string }) {
  const where = args.loja ? 'WHERE u.store = $loja' : '';
  const params = args.loja ? { $loja: args.loja } : {};
  const byStatus = await all(
    db,
    `SELECT u.status AS status, COALESCE(u.store, 'Sem loja') AS loja, COUNT(*) AS unidades
       FROM stock_units u ${where} GROUP BY u.status, loja ORDER BY loja, u.status`,
    params,
  );
  const available = await all(
    db,
    `SELECT COALESCE(NULLIF(u.model, ''), p.name) AS modelo,
            SUM(CASE WHEN u.status = 'pronta' THEN 1 ELSE 0 END) AS prontas,
            SUM(CASE WHEN u.status IN ('recebida', 'em_triagem') THEN 1 ELSE 0 END) AS em_preparo
       FROM stock_units u JOIN product_suggestions p ON p.id = u.product_id
      ${args.loja ? 'WHERE u.store = $loja AND' : 'WHERE'} u.status <> 'vendida'
      GROUP BY modelo ORDER BY prontas DESC, em_preparo DESC, modelo LIMIT 15`,
    params,
  );
  return {
    loja: args.loja ?? 'todas',
    por_status: byStatus.map((r) => ({ loja: String(r.loja), status: String(r.status), unidades: Number(r.unidades) })),
    modelos_disponiveis: available.map((r) => ({
      modelo: String(r.modelo),
      prontas: Number(r.prontas),
      em_preparo: Number(r.em_preparo),
    })),
  };
}

function summarizeChecklist(raw: unknown) {
  let parsed: Record<string, string> = {};
  try {
    parsed = JSON.parse(String(raw ?? '{}'));
  } catch {
    parsed = {};
  }
  const value = (label: string) => parsed[label] ?? 'nao_testado';
  return {
    aprovados: CHECKLIST_LABELS.filter((l) => value(l) === 'aprovado').length,
    reprovados: CHECKLIST_LABELS.filter((l) => value(l) === 'reprovado'),
    nao_testados: CHECKLIST_LABELS.filter((l) => value(l) === 'nao_testado').length,
  };
}

function warrantyStatus(row: Row, now: Date) {
  if (!row.activated_at) return 'aguardando ativação';
  if (row.expires_at && Date.parse(String(row.expires_at)) < now.getTime()) return 'expirada';
  return 'ativa';
}

export async function consultarMaquina(db: Db, clock: Clock, args: { busca: string }) {
  const term = args.busca.trim();
  const items = await all(
    db,
    `SELECT i.id, i.internal_code, i.product_name, i.status, i.technician, i.serial_number, i.real_os,
            i.nf_number, i.withdrawn_by, i.withdrawn_at, i.packaged_by, i.packaged_at,
            COALESCE(i.commercial_state, 'active') AS commercial_state, i.checklist, i.created_at,
            s.date AS sale_date, s.platform, s.company, s.seller_name, s.order_reference, s.is_priority
       FROM sale_items i JOIN sales s ON s.id = i.sale_id
      WHERE upper(trim(i.serial_number)) = upper($t)
         OR upper(i.internal_code) = upper($t)
         OR trim(i.real_os) = $t
      ORDER BY i.created_at DESC LIMIT 5`,
    { $t: term },
  );

  const stock = await get(
    db,
    `SELECT u.status, u.store, u.location, u.model, u.os_number, u.triage_at, u.ready_at, u.sold_at,
            l.name AS lote, p.name AS produto
       FROM stock_units u
       JOIN product_suggestions p ON p.id = u.product_id
       LEFT JOIN stock_lots l ON l.id = u.lot_id
      WHERE upper(trim(u.serial_number)) = upper($t)
      ORDER BY u.id DESC LIMIT 1`,
    { $t: term },
  );

  if (items.length === 0 && !stock) {
    return { busca: term, encontrado: false, dica: 'Busque pela serial, pelo código interno (ex.: CAIJ-0001) ou pelo número da OS.' };
  }

  const vendasDaMaquina = await Promise.all(items.map(async (item) => {
    const id = Number(item.id);
    const history = (
      await all(
        db,
        `SELECT created_at, description FROM item_history WHERE item_id = $id ORDER BY created_at DESC, id DESC LIMIT 25`,
        { $id: id },
      )
    ).reverse();
    const lifecycle = await all(
      db,
      `SELECT action, reason, actor_name, created_at FROM machine_lifecycle_events WHERE item_id = $id ORDER BY created_at`,
      { $id: id },
    );
    // Garantia: só situação e prazos. Nome, e-mail e telefone do cliente nunca são selecionados.
    const warranty = await get(
      db,
      `SELECT warranty_months, purchase_date, activated_at, expires_at FROM warranties
        WHERE sale_item_id = $id OR (serial = $serial AND $serial <> '') ORDER BY created_at DESC LIMIT 1`,
      { $id: id, $serial: String(item.serial_number ?? '') },
    );

    return {
      codigo: String(item.internal_code),
      produto: String(item.product_name),
      etapa: String(item.status),
      situacao_comercial: String(item.commercial_state),
      serial: item.serial_number ?? null,
      os: item.real_os ?? null,
      tecnico: item.technician ?? null,
      venda: {
        data: String(item.sale_date),
        plataforma: String(item.platform),
        empresa: String(item.company),
        vendedor: item.seller_name || null,
        referencia_pedido: item.order_reference || null,
        prioridade: Number(item.is_priority) === 1,
      },
      nota_fiscal: item.nf_number ?? null,
      retirada: item.withdrawn_at ? { por: item.withdrawn_by, em: item.withdrawn_at } : null,
      embalagem: item.packaged_at ? { por: item.packaged_by, em: item.packaged_at } : null,
      checklist: summarizeChecklist(item.checklist),
      garantia: warranty
        ? {
            meses: Number(warranty.warranty_months),
            compra: warranty.purchase_date,
            situacao: warrantyStatus(warranty, clock.now),
            expira_em: warranty.expires_at ?? null,
          }
        : null,
      eventos_comerciais: lifecycle.map((e) => ({
        acao: e.action === 'cancel' ? 'cancelamento' : 'devolução',
        motivo: e.reason,
        por: e.actor_name,
        em: e.created_at,
      })),
      historico: history.map((h) => ({ em: String(h.created_at), evento: String(h.description) })),
    };
  }));

  return {
    busca: term,
    encontrado: true,
    estoque: stock
      ? {
          produto: stock.produto,
          modelo: stock.model ?? null,
          situacao: stock.status,
          loja: stock.store ?? null,
          local: stock.location ?? null,
          lote: stock.lote ?? null,
          os: stock.os_number ?? null,
          triagem_em: stock.triage_at ?? null,
          pronta_em: stock.ready_at ?? null,
          vendida_em: stock.sold_at ?? null,
        }
      : null,
    vendas: vendasDaMaquina,
  };
}
