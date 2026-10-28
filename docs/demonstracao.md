# Demonstração

Sessões reais com o Claude Code conectado ao servidor, usando o banco de demonstração (`npm run seed`, data de referência 28/10/2026).
As perguntas foram feitas em linguagem natural. A lista de ferramentas mostra o que o modelo decidiu chamar, com os argumentos.

## 1. Onde a nossa fila está travando no último mês? Compare com a última semana.

**Ferramentas chamadas:** `tempo_por_etapa({"dias": 30})`, `tempo_por_etapa({"dias": 7})`, `resumo_fila({})`

**A fila trava em "Aguardando nota fiscal", tanto no último mês quanto na última semana.**

| Etapa (mediana / p90, em horas) | 30 dias | 7 dias |
|---|---|---|
| Pendente | 2,8 / 7,0 | 2,4 / 6,3 |
| Em preparação | 4,7 / 10,4 | 4,1 / 8,1 |
| Aguardando teste | 2,4 / 5,0 | 2,3 / 4,0 |
| Pronta | 1,5 / 3,5 | 1,3 / 3,8 |
| Aguardando retirada | 3,8 / 9,6 | 5,0 / 13,3 |
| **Aguardando nota fiscal** | **24,7 / 60,9** | **21,9 / 46,7** |
| Aguardando embalagem | 2,9 / 6,1 | 3,3 / 5,7 |
| **Venda até entrega** | **47,7 / 87,5** | **41,6 / 76,2** |

As horas são corridas, não úteis.

**O que mostram os números**
- **A nota fiscal pesa mais que todas as outras etapas.** A mediana de cerca de 22 a 25 horas equivale a mais da metade do tempo de venda até a entrega, que é de 42 a 48 horas.
- **A cauda é o maior problema.** No mês, 10% das máquinas esperam mais de 61 horas pela nota (p90).
- **A última semana está um pouco melhor que o mês.** A espera pela nota caiu de 24,7 para 21,9 horas na mediana e de 60,9 para 46,7 no p90. O tempo total de venda até a entrega caiu de 47,7 para 41,6 horas. Com 51 máquinas na semana, parte dessa diferença pode ser oscilação normal.
- **"Aguardando retirada" piorou.** A mediana subiu de 3,8 para 5,0 horas e o p90 de 9,6 para 13,3. Vale acompanhar, mas ainda é pequeno perto da nota fiscal.
- **A bancada técnica está estável.** Pendente, preparação, teste e pronta ficaram iguais ou um pouco melhores.

**Situação agora**
- Das 27 máquinas em aberto, **15 estão aguardando nota fiscal** e nenhuma delas é prioritária. A mais antiga está parada há 107,5 horas, cerca de 4,5 dias.
- As demais etapas estão fluindo. A mais antiga em cada uma tem no máximo 5,3 horas.

Posso listar as máquinas paradas na nota fiscal, com código, produto e técnico, para você cobrar as mais antigas.

---

## 2. Um vendedor perguntou da máquina CN27YDZ. Em que pé ela está e a garantia está ativa?

**Ferramentas chamadas:** `consultar_maquina({"busca": "CN27YDZ"})`

A máquina CN27YDZ já foi entregue/enviada, e a garantia está ativa.

**Situação**
- **Produto:** MacBook Air M1 8GB 256GB (código CAIJ-0001, OS 20001).
- **Etapa:** Entregue/Enviada. A embalagem foi concluída em 22/09/2026, por Bruno.
- **Venda:** 14/09/2026, pela Shopee (pedido PED-722680), vendedor Hugo.
- **Nota fiscal:** 5001.
- **Checklist técnico:** 10 itens aprovados, nenhum reprovado e nenhum sem testar.
- **Cancelamentos ou devoluções:** nenhum registrado.

**Garantia**
- **Prazo:** 12 meses, contados a partir da compra em 14/09/2026.
- **Situação:** ativa.
- **Vence em:** 19/09/2027. O sistema calcula o prazo a partir da data de envio, não da compra.

A máquina levou uns 8 dias entre a venda e o envio. A maior parte desse tempo foi esperando a nota fiscal, de 15/09 a 22/09.

---

## 3. Quantas máquinas vendemos por plataforma nos últimos 30 dias, e onde há mais devolução?

**Ferramentas chamadas:** `vendas({"agrupar_por": "plataforma", "dias": 30})`

Nos últimos 30 dias vendemos **315 máquinas em 226 pedidos**.

| Plataforma | Pedidos | Máquinas | Canceladas | Devolvidas | Taxa de devolução |
|---|---|---|---|---|---|
| Shopee | 74 | 110 | 1 | 0 | 0% |
| Mercado Livre | 55 | 65 | 1 | 1 | 1,5% |
| Cassio | 38 | 62 | 0 | 3 | **4,8%** |
| Venda Externa | 33 | 41 | 0 | 1 | 2,4% |
| Venda Interna | 26 | 37 | 0 | 0 | 0% |

- **Mais devolução:** Cassio, com 3 devoluções em 62 máquinas (4,8%). É o dobro da Venda Externa (2,4%) e mais de três vezes a do Mercado Livre (1,5%). Cassio é também a que mais devolve em número absoluto.
- **Mais vendas:** Shopee, com 110 máquinas (35% do total) e nenhuma devolução.
- **Amostra pequena:** são só 5 devoluções no total (1,6% das máquinas). Uma ou duas a mais ou a menos mudam bastante o ranking, então a diferença da Cassio pode ser acaso.

Dá para ver o mesmo recorte por empresa ou vendedor, ou para uma janela maior (60 ou 90 dias), para saber se a Cassio repete esse padrão.

---

## 4. Prompt `relatorio_semanal`

Disparado pelo menu de prompts do cliente (no Claude Code, `/mcp__infocaij__relatorio_semanal`), sem nenhuma outra instrução.

**Ferramentas chamadas:** `resumo_fila({})`, `tempo_por_etapa({"dias": 7})`, `tempo_por_etapa({"dias": 30})`, `itens_parados({"horas_minimas": 72})`, `produtividade({"dias": 7})`, `vendas({"dias": 7, "agrupar_por": "plataforma"})`

## Semana em uma frase
A bancada entregou **51 máquinas** nos últimos 7 dias. Isso fica abaixo do ritmo do mês (291 em 30 dias, cerca de 68 por semana), mas o tempo da venda até a entrega melhorou: mediana de 41,6 h contra 47,7 h no mês.

## Onde a fila trava
O gargalo continua sendo **Aguardando nota fiscal**, igual ao mês. Ele não mudou.

| | Semana | Mês |
|---|---|---|
| Mediana | 21,9 h | 24,7 h |
| P90 (os 10% mais lentos) | 46,7 h | 60,9 h (2,5 dias) |

- Hoje há **15 máquinas** nessa etapa, mais da metade das 27 em aberto.
- As demais etapas levam poucas horas. A maior depois da nota fiscal é Aguardando retirada, com mediana de 5 h.

## Para resolver hoje
Só uma máquina está parada há 72 h ou mais:

| Código | Produto | Etapa | Parada há | Prioritária |
|---|---|---|---|---|
| CAIJ-0430 | Notebook Lenovo ThinkPad E14 i5 16GB 256GB SSD | Aguardando nota fiscal | 4,5 dias (107,5 h) | Não |

- Ela é da Shopee, empresa CAIJ, e está com o técnico Bruno.
- Não há outras máquinas paradas há mais de 72 h. Não existem itens prioritários nessa lista.
- Duas máquinas prioritárias estão na fila, uma em preparação e outra aguardando teste. As duas entraram na etapa há menos de 5 h.

## Ritmo da bancada
| Técnico | Prontas | Entregues |
|---|---|---|
| Ana | 15 | 13 |
| Carla | 12 | 10 |
| Elias | 11 | 11 |
| Bruno | 11 | 9 |
| Diego | 9 | 8 |
| **Total** | **58** | **51** |

- O maior dia de máquinas prontas foi 23/10, com 14.
- O menor foi 25/10, com 3.
- A contagem por dia inclui hoje (28/10), por isso cobre 8 datas.

## Vendas
Foram **55 pedidos e 72 máquinas** na semana.

| Plataforma | Pedidos | Máquinas | Canceladas | Devolvidas |
|---|---|---|---|---|
| Shopee | 19 | 27 | 1 | 0 |
| Mercado Livre | 17 | 23 | 1 | 1 |
| Cassio | 7 | 9 | 0 | 0 |
| Venda Interna | 6 | 7 | 0 | 0 |
| Venda Externa | 6 | 6 | 0 | 0 |

- No total, houve 2 cancelamentos e 1 devolução.
- Foram vendidas 72 máquinas e entregues 51, então a fila tende a crescer se a nota fiscal não andar.

## Recomendação
**Destinar uma pessoa por dia à emissão de notas fiscais, começando pelas 15 máquinas que esperam hoje e pela CAIJ-0430.**

- Aguardando nota fiscal é a etapa mais lenta (mediana de 21,9 h), e a venda até a entrega leva 41,6 h na mediana.
- A etapa concentra 15 das 27 máquinas em aberto.
- Cortar esse tempo é o que mais encurta a entrega.
- Não existem dados no sistema sobre o motivo da espera. Vale perguntar a quem emite as notas o que atrasa.
