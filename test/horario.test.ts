import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tinyDb, handlerFor, call } from './helpers.ts';
import { DEFAULT_SCHEDULE, businessHoursBetween, describeSchedule, easterSunday, nationalHolidays, scheduleFromEnv } from '../src/horario.ts';

// Horário de Brasília (UTC-03:00). 2026-10-16 é sexta-feira e 2026-10-19 é segunda.
const t = (iso: string) => Date.parse(`${iso}-03:00`);
const hours = (a: string, b: string, schedule = DEFAULT_SCHEDULE) => businessHoursBetween(t(a), t(b), schedule);

test('horas úteis: dentro do expediente, vale o relógio', () => {
  assert.equal(hours('2026-10-19T10:00:00', '2026-10-19T12:30:00'), 2.5);
});

test('horas úteis: noite e fim de semana não contam', () => {
  // Sexta 17:00 até segunda 09:00: 1 h na sexta (17-18) e 1 h na segunda (08-09).
  assert.equal(hours('2026-10-16T17:00:00', '2026-10-19T09:00:00'), 2);
  // Só sábado e domingo.
  assert.equal(hours('2026-10-17T08:00:00', '2026-10-18T18:00:00'), 0);
  // Da noite de terça à manhã de quarta: nada antes de 08:00 nem depois de 18:00.
  assert.equal(hours('2026-10-20T19:00:00', '2026-10-21T07:00:00'), 0);
});

test('horas úteis: semana inteira são 5 dias de 10 horas', () => {
  assert.equal(hours('2026-10-19T00:00:00', '2026-10-26T00:00:00'), 50);
});

test('horas úteis: intervalo vazio ou invertido dá zero', () => {
  assert.equal(hours('2026-10-19T10:00:00', '2026-10-19T10:00:00'), 0);
  assert.equal(hours('2026-10-19T12:00:00', '2026-10-19T10:00:00'), 0);
});

test('horas úteis respeitam um expediente e um fuso próprios', () => {
  const sabado = { offsetMin: 0, startMin: 9 * 60, endMin: 13 * 60, days: [6] };
  // Em UTC, sábado 2026-10-17 das 09:00 às 13:00 = 4 h; segunda não conta.
  assert.equal(businessHoursBetween(Date.parse('2026-10-17T00:00:00Z'), Date.parse('2026-10-19T00:00:00Z'), sabado), 4);
  // O mesmo instante, visto em UTC-03:00, cai em outro horário local: 06:00 às 10:00 UTC = 03:00 às 07:00 local → fora do expediente.
  assert.equal(businessHoursBetween(Date.parse('2026-10-19T06:00:00Z'), Date.parse('2026-10-19T10:00:00Z')), 0);
  assert.equal(businessHoursBetween(Date.parse('2026-10-19T11:00:00Z'), Date.parse('2026-10-19T15:00:00Z')), 4);
});

test('scheduleFromEnv lê expediente, dias e fuso, e recusa valores inválidos', () => {
  assert.deepEqual(scheduleFromEnv({}), DEFAULT_SCHEDULE);
  const custom = scheduleFromEnv({ INFOCAIJ_HORARIO_UTIL: '09:30-17:00', INFOCAIJ_DIAS_UTEIS: '1-5,6', INFOCAIJ_FUSO: '+01:00' });
  assert.deepEqual(custom, { offsetMin: 60, startMin: 570, endMin: 1020, days: [1, 2, 3, 4, 5, 6], nationalHolidays: true, extraHolidays: [] });
  assert.match(describeSchedule(DEFAULT_SCHEDULE), /seg, ter, qua, qui, sex, 08:00 às 18:00 \(UTC-03:00\), sem expediente nos feriados nacionais/);
  assert.throws(() => scheduleFromEnv({ INFOCAIJ_HORARIO_UTIL: '18:00-08:00' }), /fim deve vir depois/);
  assert.throws(() => scheduleFromEnv({ INFOCAIJ_HORARIO_UTIL: '8h-18h' }), /Horário inválido/);
  assert.throws(() => scheduleFromEnv({ INFOCAIJ_DIAS_UTEIS: '0-9' }), /INFOCAIJ_DIAS_UTEIS/);
  assert.throws(() => scheduleFromEnv({ INFOCAIJ_FUSO: 'Brasilia' }), /INFOCAIJ_FUSO/);
});

// ------------------------------------------------------------------------ feriados

test('Páscoa e Sexta-feira Santa caem nas datas certas', () => {
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  assert.equal(iso(easterSunday(2025)), '2025-04-20');
  assert.equal(iso(easterSunday(2026)), '2026-04-05');
  assert.equal(iso(easterSunday(2027)), '2027-03-28');
  assert.ok(nationalHolidays(2026).has('04-03'), 'Sexta-feira Santa de 2026');
  assert.ok(nationalHolidays(2027).has('03-26'), 'Sexta-feira Santa de 2027');
  assert.ok(nationalHolidays(2026).has('11-20'), 'Consciência Negra é feriado nacional desde 2024');
});

test('feriado nacional não conta como hora útil', () => {
  // Segunda 12/10/2026 é Nossa Senhora Aparecida: da sexta 17:00 à terça 09:00 sobra 1 h na sexta e 1 h na terça.
  assert.equal(hours('2026-10-09T17:00:00', '2026-10-13T09:00:00'), 2);
  // O mesmo intervalo sem descontar feriados inclui as 10 h da segunda.
  assert.equal(hours('2026-10-09T17:00:00', '2026-10-13T09:00:00', { ...DEFAULT_SCHEDULE, nationalHolidays: false }), 12);
  // Semana de Finados (02/11, segunda): 4 dias de 10 h.
  assert.equal(hours('2026-11-02T00:00:00', '2026-11-09T00:00:00'), 40);
});

test('datas extras: uma vez (AAAA-MM-DD) ou todo ano (MM-DD)', () => {
  const schedule = scheduleFromEnv({ INFOCAIJ_FERIADOS: '2026-10-19, 08-20' });
  assert.deepEqual(schedule.extraHolidays, ['2026-10-19', '08-20']);
  assert.equal(hours('2026-10-19T08:00:00', '2026-10-19T18:00:00', schedule), 0);
  assert.equal(hours('2027-10-19T08:00:00', '2027-10-19T18:00:00', schedule), 10, 'só em 2026');
  assert.equal(hours('2027-08-20T08:00:00', '2027-08-20T18:00:00', schedule), 0, 'todo ano');
  assert.match(describeSchedule(schedule), /2 datas extras sem expediente/);
  assert.equal(scheduleFromEnv({ INFOCAIJ_FERIADOS_NACIONAIS: 'nao' }).nationalHolidays, false);
  assert.match(describeSchedule(scheduleFromEnv({ INFOCAIJ_FERIADOS_NACIONAIS: 'nao' })), /sem descontar feriados/);
  assert.throws(() => scheduleFromEnv({ INFOCAIJ_FERIADOS: '20/08' }), /INFOCAIJ_FERIADOS: data inválida/);
  assert.throws(() => scheduleFromEnv({ INFOCAIJ_FERIADOS: '13-01' }), /INFOCAIJ_FERIADOS: data inválida/);
  assert.throws(() => scheduleFromEnv({ INFOCAIJ_FERIADOS_NACIONAIS: 'talvez' }), /sim" ou "nao/);
});

// ------------------------------------------------- as ferramentas, com sexta à tarde e segunda de manhã
const NOW = '2026-10-19T14:00:00.000Z'; // segunda 11:00 em Brasília
const iso = (local: string) => new Date(t(local)).toISOString();

/** Uma máquina que entrou em "Aguardando nota fiscal" na sexta 17:00 e continua lá na segunda 11:00. */
function sextaAteSegunda() {
  return tinyDb((db) => {
    db.exec(`
      INSERT INTO sales (id, date, platform, company, is_priority, seller_name, order_reference, created_at, updated_at)
        VALUES (1, '2026-10-15', 'Shopee', 'CAIJ', 0, 'Fábio', 'PED-1', '${iso('2026-10-15T09:00:00')}', '${iso('2026-10-15T09:00:00')}');
      INSERT INTO sale_items (id, sale_id, internal_code, product_name, status, technician, serial_number, checklist, created_at, updated_at, commercial_state)
        VALUES (1, 1, 'CAIJ-0001', 'ThinkPad T480', 'Aguardando nota fiscal', 'Ana', 'SERIAL-A', '{}', '${iso('2026-10-15T09:00:00')}', '${iso('2026-10-16T17:00:00')}', 'active');
      INSERT INTO item_history (item_id, event_type, description, created_at) VALUES
        (1, 'updated', 'Status alterado de Pendente para Pronta.', '${iso('2026-10-16T09:00:00')}'),
        (1, 'updated', 'Status alterado de Pronta para Aguardando nota fiscal.', '${iso('2026-10-16T17:00:00')}');
    `);
  });
}

test('itens_parados: o fim de semana não conta como tempo parado em horas úteis', async () => {
  const handle = handlerFor(sextaAteSegunda(), NOW);
  const corridas = (await call(handle, 'itens_parados', { horas_minimas: 0 })).json();
  assert.equal(corridas.horas, 'corridas');
  assert.equal(corridas.itens[0].horas_na_etapa, 66, 'sexta 17:00 até segunda 11:00 = 66 h corridas');

  const uteis = (await call(handle, 'itens_parados', { horas_minimas: 0, horas: 'uteis' })).json();
  assert.equal(uteis.horas, 'uteis');
  assert.match(uteis.horario_util, /08:00 às 18:00/);
  assert.equal(uteis.itens[0].horas_na_etapa, 4, '1 h na sexta (17-18) + 3 h na segunda (08-11)');
  assert.match(uteis.criterio, /úteis/);
});

test('itens_parados: o limite mínimo é medido na unidade escolhida', async () => {
  const handle = handlerFor(sextaAteSegunda(), NOW);
  // 66 h corridas passam de 48, mas só 4 h úteis: a máquina não está "parada há mais de 48 h úteis".
  assert.equal((await call(handle, 'itens_parados', { horas_minimas: 48 })).json().total, 1);
  assert.equal((await call(handle, 'itens_parados', { horas_minimas: 48, horas: 'uteis' })).json().total, 0);
});

test('tempo_por_etapa e tempo_entre_etapas aceitam horas úteis', async () => {
  const handle = handlerFor(sextaAteSegunda(), NOW);
  const porEtapa = (await call(handle, 'tempo_por_etapa', { dias: 30, horas: 'uteis' })).json();
  assert.equal(porEtapa.horas, 'uteis');
  assert.match(porEtapa.observacao, /Horas úteis/);
  // Pronta: sexta 09:00 a 17:00 = 8 h, que são 8 h úteis também.
  assert.equal(porEtapa.etapas.find((e: any) => e.etapa === 'Pronta').mediana_horas, 8);

  // Venda registrada (quinta 09:00) até Pronta (sexta 09:00): 24 h corridas, 10 h úteis (quinta 09-18 = 9 h + sexta 08-09 = 1 h).
  const corridas = (await call(handle, 'tempo_entre_etapas', { ate: 'Pronta' })).json();
  const uteis = (await call(handle, 'tempo_entre_etapas', { ate: 'Pronta', horas: 'uteis' })).json();
  assert.equal(corridas.mediana_horas, 24);
  assert.equal(uteis.mediana_horas, 10);
  assert.equal(uteis.horas, 'uteis');
});

test('um expediente configurado muda o resultado', async () => {
  const integral = { offsetMin: -180, startMin: 0, endMin: 24 * 60, days: [1, 2, 3, 4, 5, 6, 7] };
  const handle = handlerFor(sextaAteSegunda(), NOW, integral);
  const result = (await call(handle, 'itens_parados', { horas_minimas: 0, horas: 'uteis' })).json();
  assert.equal(result.itens[0].horas_na_etapa, 66, '24 h por dia, 7 dias: igual ao relógio');
});

test('padrão continua sendo horas corridas', async () => {
  const handle = handlerFor(sextaAteSegunda(), NOW);
  const result = (await call(handle, 'tempo_por_etapa', { dias: 30 })).json();
  assert.equal(result.horas, 'corridas');
  assert.equal('horario_util' in result, false);
  assert.match(result.observacao, /Horas corridas/);
});
