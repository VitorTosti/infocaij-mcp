import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tinyDb, handlerFor, call } from './helpers.ts';
import { parseStatusChange } from '../src/domain.ts';

const NOW = '2026-10-10T12:00:00.000Z';
const at = (hoursBeforeNow: number) => new Date(Date.parse(NOW) - hoursBeforeNow * 3_600_000).toISOString();

/**
 * Duas máquinas com tempos conhecidos:
 *  A: criada há 100 h → Em preparacao após 10 h → Aguardando teste após 20 h (está lá há 70 h).
 *  B: criada há 50 h → Em preparacao após 30 h (está lá há 20 h). Prioritária.
 * Uma terceira, cancelada, não pode aparecer na fila.
 */
function scenario() {
  return tinyDb((db) => {
    db.exec(`
      INSERT INTO sales (id, date, platform, company, is_priority, seller_name, order_reference, created_at, updated_at) VALUES
        (1, '2026-10-06', 'Shopee', 'CAIJ', 0, 'Fábio', 'PED-1', '${at(100)}', '${at(100)}'),
        (2, '2026-10-08', 'Mercado Livre', 'AIJ', 1, 'Gabi', 'PED-2', '${at(50)}', '${at(50)}'),
        (3, '2026-10-08', 'Shopee', 'CAIJ', 0, 'Gabi', 'PED-3', '${at(50)}', '${at(50)}');
      INSERT INTO sale_items (id, sale_id, internal_code, product_name, status, technician, serial_number, checklist, created_at, updated_at, commercial_state) VALUES
        (1, 1, 'CAIJ-0001', 'ThinkPad T480', 'Aguardando teste', 'Ana', 'SERIAL-A', '{}', '${at(100)}', '${at(70)}', 'active'),
        (2, 2, 'CAIJ-0002', 'Latitude 5490', 'Em preparacao', 'Bruno', 'SERIAL-B', '{}', '${at(50)}', '${at(20)}', 'active'),
        (3, 3, 'CAIJ-0003', 'Latitude 5490', 'Pendente', NULL, NULL, '{}', '${at(50)}', '${at(40)}', 'cancelled');
      INSERT INTO item_history (item_id, event_type, description, created_at) VALUES
        (1, 'created', 'Item criado na bancada com codigo CAIJ-0001.', '${at(100)}'),
        (1, 'updated', 'Status alterado de Pendente para Em preparacao.', '${at(90)}'),
        (1, 'updated', 'Checklist tecnico atualizado.', '${at(80)}'),
        (1, 'updated', 'Status alterado de Em preparacao para Aguardando teste.', '${at(70)}'),
        (2, 'created', 'Item criado na bancada com codigo CAIJ-0002.', '${at(50)}'),
        (2, 'updated', 'Status alterado de Pendente para Em preparacao.', '${at(20)}');
    `);
  });
}

test('parseStatusChange entende a frase gravada pelo InfoCAIJ, inclusive com barra', () => {
  assert.deepEqual(parseStatusChange('Status alterado de Aguardando embalagem para Entregue/Enviada.'), {
    from: 'Aguardando embalagem',
    to: 'Entregue/Enviada',
  });
  assert.equal(parseStatusChange('Status alterado de Pendente para Teletransporte.'), null);
  assert.equal(parseStatusChange('Checklist tecnico atualizado.'), null);
});

test('resumo_fila conta por etapa, ignora cancelados e mede a mais antiga', () => {
  const handle = handlerFor(scenario(), NOW);
  const result = call(handle, 'resumo_fila').json();
  const byStage = Object.fromEntries(result.etapas.map((e: any) => [e.etapa, e]));
  assert.equal(result.maquinas_em_aberto, 2);
  assert.equal(byStage['Aguardando teste'].maquinas, 1);
  assert.equal(byStage['Aguardando teste'].mais_antiga_horas, 70);
  assert.equal(byStage['Em preparacao'].prioritarias, 1);
  assert.equal(byStage['Em preparacao'].mais_antiga_horas, 20);
  assert.equal(byStage['Pendente'].maquinas, 0, 'o item cancelado não entra na fila');
});

test('itens_parados mede o tempo desde a última mudança de etapa', () => {
  const handle = handlerFor(scenario(), NOW);
  const result = call(handle, 'itens_parados', { horas_minimas: 24 }).json();
  assert.equal(result.total, 1);
  assert.equal(result.itens[0].codigo, 'CAIJ-0001');
  assert.equal(result.itens[0].horas_na_etapa, 70);

  const filtered = call(handle, 'itens_parados', { etapa: 'Em preparacao', horas_minimas: 0 }).json();
  assert.deepEqual(filtered.itens.map((i: any) => i.codigo), ['CAIJ-0002']);
});

test('tempo_por_etapa calcula a duração de cada passagem concluída', () => {
  const handle = handlerFor(scenario(), NOW);
  const result = call(handle, 'tempo_por_etapa', { dias: 30 }).json();
  const byStage = Object.fromEntries(result.etapas.map((e: any) => [e.etapa, e]));
  // Pendente: A ficou 10 h, B ficou 30 h → mediana 20 h.
  assert.equal(byStage['Pendente'].passagens, 2);
  assert.equal(byStage['Pendente'].mediana_horas, 20);
  // Em preparacao: só A concluiu (20 h). B ainda está lá e não conta.
  assert.equal(byStage['Em preparacao'].passagens, 1);
  assert.equal(byStage['Em preparacao'].mediana_horas, 20);
  assert.equal(result.gargalo, null, 'gargalo exige pelo menos 5 passagens');
  assert.equal(byStage['Pendente'].horas_totais, 40);
  assert.ok(result.etapas_sem_uso.includes('Pronta'));
});

test('gargalo é a etapa com mais horas somadas, mesmo com mediana baixa (cauda longa)', () => {
  // Etapa "Aguardando retirada": 9 máquinas passam em 1 h, 1 fica 100 h → mediana 1 h, total 109 h.
  // Etapa "Pendente": 10 máquinas passam em 5 h → mediana 5 h, total 50 h.
  const db = tinyDb((d) => {
    d.exec(`INSERT INTO sales (id, date, platform, company, created_at, updated_at) VALUES (1, '2026-10-01', 'Shopee', 'CAIJ', '${at(300)}', '${at(300)}')`);
    for (let i = 1; i <= 10; i++) {
      const start = 200;
      const retiradaHours = i === 10 ? 100 : 1;
      d.exec(`INSERT INTO sale_items (id, sale_id, internal_code, product_name, status, checklist, created_at, updated_at)
              VALUES (${i}, 1, 'CAIJ-${i}', 'X', 'Aguardando nota fiscal', '{}', '${at(start)}', '${at(start)}');
              INSERT INTO item_history (item_id, event_type, description, created_at) VALUES
              (${i}, 'updated', 'Status alterado de Pendente para Aguardando retirada.', '${at(start - 5)}'),
              (${i}, 'updated', 'Status alterado de Aguardando retirada para Aguardando nota fiscal.', '${at(start - 5 - retiradaHours)}');`);
    }
  });
  const result = call(handlerFor(db, NOW), 'tempo_por_etapa', { dias: 30 }).json();
  const byStage = Object.fromEntries(result.etapas.map((e: any) => [e.etapa, e]));
  assert.equal(byStage['Aguardando retirada'].mediana_horas, 1);
  assert.equal(byStage['Pendente'].mediana_horas, 5);
  assert.equal(result.gargalo, 'Aguardando retirada');
  assert.ok(result.etapas_sem_uso.includes('Em preparacao'));
});

test('consultar_maquina encontra por serial, código e ignora maiúsculas', () => {
  const handle = handlerFor(scenario(), NOW);
  for (const busca of ['serial-a', 'CAIJ-0001', '  SERIAL-A ']) {
    const result = call(handle, 'consultar_maquina', { busca }).json();
    assert.equal(result.encontrado, true, busca);
    assert.equal(result.vendas[0].codigo, 'CAIJ-0001');
  }
  const history = call(handle, 'consultar_maquina', { busca: 'CAIJ-0001' }).json().vendas[0].historico;
  assert.equal(history.length, 4);
  assert.match(history[0].evento, /Item criado/);

  const none = call(handle, 'consultar_maquina', { busca: 'NAO-EXISTE' }).json();
  assert.equal(none.encontrado, false);
});

test('vendas agrupa por plataforma e conta cancelamentos', () => {
  const handle = handlerFor(scenario(), NOW);
  const result = call(handle, 'vendas', { dias: 30, agrupar_por: 'plataforma' }).json();
  const shopee = result.grupos.find((g: any) => g.plataforma === 'Shopee');
  assert.equal(shopee.pedidos, 2);
  assert.equal(shopee.canceladas, 1);
  assert.equal(result.total_maquinas, 3);
});

test('tempo_entre_etapas mede da venda registrada até Pronta e conta quem pulou etapa', () => {
  // A: criada há 100 h, chegou a "Aguardando teste" há 70 h (ainda não está pronta).
  // C: criada há 60 h, foi direto de Pendente para Aguardando retirada há 40 h (pulou Pronta) → 20 h.
  // D: criada há 30 h, Pronta há 20 h → 10 h.
  const db = tinyDb((d) => {
    d.exec(`
      INSERT INTO sales (id, date, platform, company, created_at, updated_at) VALUES (1, '2026-10-06', 'Shopee', 'CAIJ', '${at(100)}', '${at(100)}');
      INSERT INTO sale_items (id, sale_id, internal_code, product_name, status, technician, checklist, created_at, updated_at) VALUES
        (1, 1, 'A', 'X', 'Aguardando teste', 'Ana', '{}', '${at(100)}', '${at(70)}'),
        (2, 1, 'C', 'X', 'Aguardando retirada', 'Bruno', '{}', '${at(60)}', '${at(40)}'),
        (3, 1, 'D', 'X', 'Pronta', 'Ana', '{}', '${at(30)}', '${at(20)}');
      INSERT INTO item_history (item_id, event_type, description, created_at) VALUES
        (1, 'updated', 'Status alterado de Pendente para Aguardando teste.', '${at(70)}'),
        (2, 'updated', 'Status alterado de Pendente para Aguardando retirada.', '${at(40)}'),
        (3, 'updated', 'Status alterado de Pendente para Pronta.', '${at(20)}');
    `);
  });
  const handle = handlerFor(db, NOW);
  const result = call(handle, 'tempo_entre_etapas', { ate: 'Pronta' }).json();
  assert.equal(result.de, 'Venda registrada');
  assert.equal(result.maquinas, 2);
  assert.equal(result.media_horas, 15);
  assert.equal(result.chegaram_pulando_a_etapa, 1);
  assert.equal(result.ainda_nao_chegaram, 1);

  const byTech = call(handle, 'tempo_entre_etapas', { ate: 'Pronta', agrupar_por: 'tecnico' }).json();
  assert.deepEqual(byTech.por_grupo.map((g: any) => [g.grupo, g.mediana_horas]).sort(), [['Ana', 10], ['Bruno', 20]]);

  const backwards = call(handle, 'tempo_entre_etapas', { de: 'Pronta', ate: 'Aguardando teste' });
  assert.equal(backwards.isError, true);
});
