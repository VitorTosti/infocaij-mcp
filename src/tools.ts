import { withDb } from './db.ts';
import { STATUSES, FINAL_STATUS } from './domain.ts';
import {
  consultarMaquina,
  estoque,
  itensParados,
  produtividade,
  resumoFila,
  tempoPorEtapa,
  tempoEntreEtapas,
  VENDA_REGISTRADA,
  vendas,
  type Clock,
} from './queries.ts';

type JsonSchema = {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
};

export interface ToolContext {
  dbPath: string;
  clock: () => Clock;
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  run: (args: Record<string, unknown>, ctx: ToolContext) => unknown;
}

const OPEN_STATUSES = STATUSES.filter((s) => s !== FINAL_STATUS);

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOLS: ToolDefinition[] = [
  {
    name: 'resumo_fila',
    title: 'Resumo da fila',
    description:
      'Fotografia da operação agora: quantas máquinas estão em cada etapa da fila (de Pendente a Aguardando embalagem), ' +
      'quantas são prioritárias, há quanto tempo está a mais antiga de cada etapa e quantas foram entregues nos últimos 7 dias. ' +
      'Use primeiro para perguntas gerais como "como está a bancada?" ou "quanto falta entregar?".',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (_args, ctx) => withDb(ctx.dbPath, (db) => resumoFila(db, ctx.clock())),
  },
  {
    name: 'itens_parados',
    title: 'Máquinas paradas',
    description:
      'Lista máquinas que estão há muito tempo na mesma etapa, da mais antiga para a mais nova, com código, produto, técnico e plataforma. ' +
      'Use para "o que está travado?", "quem está esperando nota fiscal há mais de 2 dias?" ou para cobrar prioridades. ' +
      'O tempo é contado desde a última mudança de etapa, em horas corridas.',
    inputSchema: {
      type: 'object',
      properties: {
        etapa: { type: 'string', enum: OPEN_STATUSES, description: 'Filtra por uma etapa. Omita para todas.' },
        horas_minimas: { type: 'number', minimum: 0, maximum: 2000, default: 48, description: 'Tempo mínimo na etapa, em horas (padrão 48).' },
        limite: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Máximo de máquinas listadas (padrão 20).' },
      },
      additionalProperties: false,
    },
    run: (args, ctx) =>
      withDb(ctx.dbPath, (db) =>
        itensParados(db, ctx.clock(), {
          etapa: args.etapa as (typeof OPEN_STATUSES)[number] | undefined,
          horas_minimas: args.horas_minimas as number,
          limite: args.limite as number,
        }),
      ),
  },
  {
    name: 'tempo_por_etapa',
    title: 'Tempo por etapa',
    description:
      'Quanto tempo as máquinas passam em cada etapa (mediana, percentil 90 e soma de horas), calculado a partir do histórico de mudanças de status. ' +
      'O gargalo é a etapa onde as máquinas somam mais horas paradas: uma etapa pode ter mediana baixa e ainda ser o gargalo se algumas máquinas ficam dias nela (veja p90). ' +
      'Também lista etapas que a equipe não está usando e o tempo total da venda até a entrega. ' +
      'Use para "onde a fila trava?", "o que mais atrasa as entregas?" ou para comparar períodos.',
    inputSchema: {
      type: 'object',
      properties: {
        dias: { type: 'integer', minimum: 1, maximum: 365, default: 30, description: 'Janela analisada em dias (padrão 30).' },
      },
      additionalProperties: false,
    },
    run: (args, ctx) => withDb(ctx.dbPath, (db) => tempoPorEtapa(db, ctx.clock(), { dias: args.dias as number })),
  },
  {
    name: 'tempo_entre_etapas',
    title: 'Tempo entre dois pontos da fila',
    description:
      'Quanto tempo as máquinas levam de um ponto da fila até outro, com média, mediana e percentil 90 em horas. ' +
      'O início pode ser "Venda registrada" (criação do item) ou uma etapa; o destino é uma etapa. ' +
      'Se a equipe pulou a etapa de destino, conta a chegada à primeira etapa posterior e informa quantas pularam. ' +
      'Use para "quanto tempo da venda até ficar pronta?", "da pronta até a entrega?" ou para comparar técnicos e plataformas com agrupar_por. ' +
      'Prefira a mediana para o caso típico; cite a média só se pedirem e explique a diferença.',
    inputSchema: {
      type: 'object',
      properties: {
        de: {
          type: 'string',
          enum: [VENDA_REGISTRADA, ...OPEN_STATUSES],
          default: VENDA_REGISTRADA,
          description: 'Ponto de partida (padrão "Venda registrada").',
        },
        ate: { type: 'string', enum: STATUSES.filter((s) => s !== 'Pendente'), description: 'Etapa de destino, por exemplo "Pronta".' },
        dias: { type: 'integer', minimum: 1, maximum: 365, default: 30, description: 'Considera máquinas que chegaram ao destino nos últimos N dias (padrão 30).' },
        agrupar_por: { type: 'string', enum: ['tecnico', 'plataforma', 'empresa'], description: 'Quebra o resultado por técnico, plataforma ou empresa. Omita para o total.' },
      },
      required: ['ate'],
      additionalProperties: false,
    },
    run: (args, ctx) =>
      withDb(ctx.dbPath, (db) =>
        tempoEntreEtapas(db, ctx.clock(), {
          de: args.de as string,
          ate: args.ate as (typeof STATUSES)[number],
          dias: args.dias as number,
          agrupar_por: args.agrupar_por as 'tecnico' | undefined,
        }),
      ),
  },
  {
    name: 'produtividade',
    title: 'Produtividade da bancada',
    description:
      'Máquinas que chegaram a "Pronta" e a "Entregue/Enviada" no período, por técnico e por dia. ' +
      'Use para "quantas máquinas a bancada fechou esta semana?" ou "como foi o ritmo por dia?". ' +
      'O técnico é o responsável atual de cada máquina.',
    inputSchema: {
      type: 'object',
      properties: {
        dias: { type: 'integer', minimum: 1, maximum: 365, default: 7, description: 'Janela analisada em dias (padrão 7).' },
      },
      additionalProperties: false,
    },
    run: (args, ctx) => withDb(ctx.dbPath, (db) => produtividade(db, ctx.clock(), { dias: args.dias as number })),
  },
  {
    name: 'vendas',
    title: 'Vendas por período',
    description:
      'Pedidos e máquinas vendidas no período, agrupados por plataforma, empresa, vendedor ou dia. ' +
      'O período é pela data da venda. Canceladas e devolvidas são máquinas vendidas no período que foram canceladas ou devolvidas ' +
      'depois, em qualquer data; a taxa de devolução de um grupo é devolvidas ÷ maquinas. ' +
      'Use para "quanto vendemos no Mercado Livre este mês?" ou "qual empresa do grupo vendeu mais?".',
    inputSchema: {
      type: 'object',
      properties: {
        dias: { type: 'integer', minimum: 1, maximum: 365, default: 30, description: 'Janela analisada em dias (padrão 30).' },
        agrupar_por: {
          type: 'string',
          enum: ['plataforma', 'empresa', 'vendedor', 'dia'],
          default: 'plataforma',
          description: 'Como agrupar o resultado (padrão plataforma).',
        },
      },
      additionalProperties: false,
    },
    run: (args, ctx) =>
      withDb(ctx.dbPath, (db) =>
        vendas(db, ctx.clock(), { dias: args.dias as number, agrupar_por: args.agrupar_por as 'plataforma' }),
      ),
  },
  {
    name: 'estoque',
    title: 'Estoque de máquinas',
    description:
      'Unidades em estoque por situação (recebida, em triagem, pronta, vendida) e por loja, mais os modelos com unidades disponíveis. ' +
      'Use para "temos ThinkPad pronto?" ou "quanto está parado em triagem?".',
    inputSchema: {
      type: 'object',
      properties: {
        loja: { type: 'string', enum: ['CAIJ', 'AIJ', 'CRIGOR'], description: 'Filtra por loja. Omita para todas.' },
      },
      additionalProperties: false,
    },
    run: (args, ctx) => withDb(ctx.dbPath, (db) => estoque(db, { loja: args.loja as string | undefined })),
  },
  {
    name: 'consultar_maquina',
    title: 'Consultar máquina',
    description:
      'Dossiê de uma máquina pela serial, pelo código interno ou pelo número da OS: etapa atual, venda (plataforma, empresa, vendedor, pedido), ' +
      'nota fiscal, retirada, embalagem, checklist técnico, garantia, cancelamentos ou devoluções e histórico completo. ' +
      'Não inclui dados pessoais de clientes.',
    inputSchema: {
      type: 'object',
      properties: {
        busca: { type: 'string', minLength: 3, maxLength: 80, description: 'Serial, código interno ou número da OS.' },
      },
      required: ['busca'],
      additionalProperties: false,
    },
    run: (args, ctx) => withDb(ctx.dbPath, (db) => consultarMaquina(db, ctx.clock(), { busca: args.busca as string })),
  },
];

export function listTools() {
  return TOOLS.map(({ name, title, description, inputSchema }) => ({
    name,
    title,
    description,
    inputSchema,
    annotations: { title, ...READ_ONLY },
  }));
}

export class ArgumentError extends Error {}

/** Valida e aplica padrões conforme o inputSchema. Cobre o subconjunto de JSON Schema usado acima. */
export function validateArgs(schema: JsonSchema, raw: unknown): Record<string, unknown> {
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    throw new ArgumentError('Os argumentos devem ser um objeto.');
  }
  const input = (raw ?? {}) as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  for (const key of Object.keys(input)) {
    if (!(key in schema.properties)) throw new ArgumentError(`Argumento desconhecido: ${key}.`);
  }
  for (const key of schema.required ?? []) {
    if (input[key] === undefined) throw new ArgumentError(`Argumento obrigatório ausente: ${key}.`);
  }

  for (const [key, spec] of Object.entries(schema.properties)) {
    let value = input[key];
    if (value === undefined) {
      if ('default' in spec) output[key] = spec.default;
      continue;
    }
    if (spec.type === 'integer' || spec.type === 'number') {
      if (typeof value === 'string' && value.trim() !== '') value = Number(value);
      if (typeof value !== 'number' || Number.isNaN(value)) throw new ArgumentError(`${key} deve ser um número.`);
      if (spec.type === 'integer' && !Number.isInteger(value)) throw new ArgumentError(`${key} deve ser um número inteiro.`);
      if (typeof spec.minimum === 'number' && value < spec.minimum) throw new ArgumentError(`${key} deve ser no mínimo ${spec.minimum}.`);
      if (typeof spec.maximum === 'number' && value > spec.maximum) throw new ArgumentError(`${key} deve ser no máximo ${spec.maximum}.`);
    }
    if (spec.type === 'string') {
      if (typeof value !== 'string') throw new ArgumentError(`${key} deve ser um texto.`);
      if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
        throw new ArgumentError(`${key} deve ser um de: ${(spec.enum as string[]).join(', ')}.`);
      }
      if (typeof spec.minLength === 'number' && value.trim().length < spec.minLength) {
        throw new ArgumentError(`${key} deve ter pelo menos ${spec.minLength} caracteres.`);
      }
      if (typeof spec.maxLength === 'number' && value.length > spec.maxLength) {
        throw new ArgumentError(`${key} deve ter no máximo ${spec.maxLength} caracteres.`);
      }
    }
    output[key] = value;
  }
  return output;
}

export function findTool(name: string) {
  return TOOLS.find((tool) => tool.name === name);
}
