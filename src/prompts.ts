/**
 * Prompts do servidor: roteiros prontos que o cliente MCP oferece ao usuário
 * (no Claude, aparecem no menu "+" ou como comando de barra).
 *
 * Cada prompt diz quais ferramentas usar, em que ordem, como apresentar o
 * resultado e o que não fazer. A ideia é que o mesmo pedido gere o mesmo
 * tipo de relatório toda vez.
 */

interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}

interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  arguments: PromptArgument[];
  render: (args: Record<string, string>) => string;
}

const RULES = `Regras:
- Use apenas números retornados pelas ferramentas. Se um dado não existir, diga que não existe.
- Tempos são em horas corridas; converta para dias quando passar de 48 h (ex.: "3,5 dias").
- Escreva em português, frases curtas, sem jargão de banco de dados.
- Não exponha dados de clientes; as ferramentas não os retornam e você não deve pedir.`;

export const PROMPTS: PromptDefinition[] = [
  {
    name: 'relatorio_semanal',
    title: 'Relatório semanal da operação',
    description: 'Gera o relatório da semana para a gestão: entregas, gargalo, máquinas paradas e vendas.',
    arguments: [],
    render: () => `Monte o relatório semanal da operação da CAIJ.

Passos:
1. Chame resumo_fila para a situação atual.
2. Chame tempo_por_etapa com dias = 7 e depois com dias = 30, para comparar a semana com o mês.
3. Chame itens_parados com horas_minimas = 72.
4. Chame produtividade com dias = 7.
5. Chame vendas com dias = 7 e agrupar_por = "plataforma".

Formato da resposta:
## Semana em uma frase
Uma frase com o número que mais importa (entregas da semana) e se melhorou ou piorou em relação ao mês.

## Onde a fila trava
A etapa gargalo, com mediana da semana e do mês lado a lado. Se mudou, diga qual era antes.

## Para resolver hoje
Até 5 máquinas paradas há mais tempo: código, produto, etapa e há quanto tempo. Prioritárias primeiro.

## Ritmo da bancada
Prontas e entregues por técnico, em uma tabela.

## Vendas
Pedidos e máquinas por plataforma, com cancelamentos e devoluções se houver.

## Recomendação
Uma ação concreta para a próxima semana, justificada por um número acima.

${RULES}`,
  },
  {
    name: 'diagnostico_gargalo',
    title: 'Diagnóstico de gargalo',
    description: 'Investiga uma etapa da fila: por que ela demora e quais máquinas estão presas nela.',
    arguments: [
      {
        name: 'etapa',
        description: 'Etapa a investigar, por exemplo "Aguardando nota fiscal". Deixe vazio para o assistente escolher o gargalo.',
        required: false,
      },
    ],
    render: ({ etapa }) => `Investigue o gargalo da fila da CAIJ${etapa ? ` na etapa "${etapa}"` : ''}.

Passos:
1. Chame tempo_por_etapa com dias = 30.${etapa ? '' : ' Use a etapa indicada em "gargalo".'}
2. Chame itens_parados filtrando essa etapa, com horas_minimas = 24 e limite = 30.
3. Para as 3 máquinas mais antigas, chame consultar_maquina e leia o histórico.

Responda:
- Quanto tempo a etapa costuma levar (mediana) e quanto leva nos piores casos (p90).
- Quantas máquinas estão nela agora e há quanto tempo.
- O padrão que aparece no histórico das mais antigas (mesmo técnico, mesma plataforma, mesma empresa, evento que se repete).
- Uma hipótese de causa e o que conferir para confirmá-la. Deixe claro que é hipótese.

${RULES}`,
  },
  {
    name: 'status_pedido',
    title: 'Status para o vendedor',
    description: 'Responde a um vendedor, em linguagem simples, em que pé está uma máquina ou pedido.',
    arguments: [
      { name: 'busca', description: 'Serial, código interno ou número da OS.', required: true },
    ],
    render: ({ busca }) => `Um vendedor quer saber como está a máquina "${busca}".

Chame consultar_maquina com busca = "${busca}" e responda em até 3 frases, como se fosse uma mensagem de WhatsApp:
- Em que etapa ela está e desde quando.
- O que falta para ela ser enviada (próxima etapa).
- Se houver checklist reprovado, cancelamento ou devolução, avise.

Se não encontrar, peça a serial ou o código interno correto.

${RULES}`,
  },
];

export function listPrompts() {
  return PROMPTS.map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args }));
}

export function findPrompt(name: string) {
  return PROMPTS.find((prompt) => prompt.name === name);
}
