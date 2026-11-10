import { withDb, type Source } from './db.ts';
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
  type Horas,
} from './queries.ts';

type JsonSchema = {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
};

export interface ToolContext {
  source: Source;
  clock: () => Clock;
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  /** Forma do resultado (JSON Schema). Vai em outputSchema e descreve o structuredContent. */
  outputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

// ------------------------------------------------------------ esquemas de saída
type Schema = Record<string, unknown>;
const str: Schema = { type: 'string' };
const num: Schema = { type: 'number' };
const int: Schema = { type: 'integer' };
const bool: Schema = { type: 'boolean' };
const nullable = (s: Schema): Schema => ({ ...s, type: [s.type as string, 'null'] });
const arr = (items: Schema): Schema => ({ type: 'array', items });
/** Objeto fechado: todas as propriedades são obrigatórias, menos as listadas em optional. */
const obj = (properties: Record<string, Schema>, optional: string[] = []): Schema => ({
  type: 'object',
  properties,
  required: Object.keys(properties).filter((k) => !optional.includes(k)),
  additionalProperties: false,
});
const HORAS_OUT: Record<string, Schema> = { horas: { type: 'string', enum: ['corridas', 'uteis'] }, horario_util: str };
const HORAS_IN = {
  type: 'string',
  enum: ['corridas', 'uteis'],
  default: 'corridas',
  description:
    '"corridas" (padrão) conta o relógio todo; "uteis" desconta noites, fins de semana e feriados (expediente configurado no servidor). ' +
    'Prefira "uteis" para julgar se algo está atrasado de verdade.',
};

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
    outputSchema: obj({
      gerado_em: str,
      maquinas_em_aberto: int,
      entregues_ultimos_7_dias: int,
      etapas: arr(obj({ etapa: str, maquinas: int, prioritarias: int, mais_antiga_horas: nullable(num) })),
    }),
    run: (_args, ctx) => withDb(ctx.source, (db) => resumoFila(db, ctx.clock())),
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
        horas: HORAS_IN,
      },
      additionalProperties: false,
    },
    outputSchema: obj(
      {
        criterio: str,
        ...HORAS_OUT,
        total: int,
        itens: arr(
          obj({
            codigo: str, produto: str, etapa: str, horas_na_etapa: num, desde: str,
            tecnico: nullable(str), plataforma: str, empresa: str, prioridade: bool,
          }),
        ),
      },
      ['horario_util'],
    ),
    run: (args, ctx) =>
      withDb(ctx.source, (db) =>
        itensParados(db, ctx.clock(), {
          etapa: args.etapa as (typeof OPEN_STATUSES)[number] | undefined,
          horas_minimas: args.horas_minimas as number,
          limite: args.limite as number,
          horas: args.horas as Horas,
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
      'Use para "onde a fila trava?", "o que mais atrasa as entregas?" ou para comparar períodos. ' +
      'Com por_semana, devolve também a evolução semana a semana (gargalo, tempo por etapa e da venda até a entrega), ' +
      'para "está melhorando?" ou "o gargalo mudou?" numa chamada só.',
    inputSchema: {
      type: 'object',
      properties: {
        dias: { type: 'integer', minimum: 1, maximum: 365, default: 30, description: 'Janela analisada em dias (padrão 30).' },
        horas: HORAS_IN,
        por_semana: {
          type: 'boolean',
          default: false,
          description: 'Inclui "semanas": o período quebrado em blocos de 7 dias terminando agora, do mais antigo ao mais recente.',
        },
      },
      additionalProperties: false,
    },
    outputSchema: obj(
      {
        periodo_dias: int,
        ...HORAS_OUT,
        observacao: str,
        gargalo: nullable(str),
        etapas_sem_uso: arr(str),
        venda_ate_entrega: obj({ maquinas: int, mediana_horas: num, p90_horas: num }),
        etapas: arr(
          obj({ etapa: str, passagens: int, mediana_horas: num, p90_horas: num, horas_totais: int, participacao_pct: int }),
        ),
        semanas: arr(
          obj({
            inicio: str,
            fim: str,
            passagens: int,
            gargalo: nullable(str),
            venda_ate_entrega: obj({ maquinas: int, mediana_horas: num, p90_horas: num }),
            etapas: arr(obj({ etapa: str, passagens: int, mediana_horas: num, horas_totais: int })),
          }),
        ),
      },
      ['horario_util', 'semanas'],
    ),
    run: (args, ctx) =>
      withDb(ctx.source, (db) =>
        tempoPorEtapa(db, ctx.clock(), { dias: args.dias as number, horas: args.horas as Horas, por_semana: args.por_semana as boolean }),
      ),
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
        horas: HORAS_IN,
      },
      required: ['ate'],
      additionalProperties: false,
    },
    outputSchema: obj(
      {
        de: str,
        ate: str,
        periodo_dias: int,
        ...HORAS_OUT,
        observacao: str,
        maquinas: int,
        media_horas: num,
        mediana_horas: num,
        p90_horas: num,
        chegaram_pulando_a_etapa: int,
        ainda_nao_chegaram: int,
        por_grupo: arr(obj({ grupo: str, maquinas: int, media_horas: num, mediana_horas: num, p90_horas: num })),
      },
      ['horario_util', 'por_grupo'],
    ),
    run: (args, ctx) =>
      withDb(ctx.source, (db) =>
        tempoEntreEtapas(db, ctx.clock(), {
          de: args.de as string,
          ate: args.ate as (typeof STATUSES)[number],
          dias: args.dias as number,
          agrupar_por: args.agrupar_por as 'tecnico' | undefined,
          horas: args.horas as Horas,
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
    outputSchema: obj({
      periodo_dias: int,
      por_tecnico: arr(obj({ tecnico: str, prontas: int, entregues: int })),
      prontas_por_dia: arr(obj({ dia: str, prontas: int })),
    }),
    run: (args, ctx) => withDb(ctx.source, (db) => produtividade(db, ctx.clock(), { dias: args.dias as number })),
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
    outputSchema: obj({
      periodo_dias: int,
      total_pedidos: int,
      total_maquinas: int,
      // Cada grupo tem também uma chave com o nome do agrupamento (plataforma, empresa, vendedor ou dia).
      grupos: arr({
        type: 'object',
        properties: { pedidos: int, maquinas: int, canceladas: int, devolvidas: int },
        required: ['pedidos', 'maquinas', 'canceladas', 'devolvidas'],
        additionalProperties: true,
      }),
    }),
    run: (args, ctx) =>
      withDb(ctx.source, (db) =>
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
    outputSchema: obj({
      loja: str,
      por_status: arr(obj({ loja: str, status: str, unidades: int })),
      modelos_disponiveis: arr(obj({ modelo: str, prontas: int, em_preparo: int })),
    }),
    run: (args, ctx) => withDb(ctx.source, (db) => estoque(db, { loja: args.loja as string | undefined })),
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
    outputSchema: obj(
      {
        busca: str,
        encontrado: bool,
        dica: str,
        estoque: nullable({ type: 'object' }),
        vendas: arr(
          obj({
            codigo: str, produto: str, etapa: str, situacao_comercial: str,
            serial: nullable(str), os: nullable(str), tecnico: nullable(str),
            venda: obj({ data: str, plataforma: str, empresa: str, vendedor: nullable(str), referencia_pedido: nullable(str), prioridade: bool }),
            nota_fiscal: nullable(str),
            retirada: nullable({ type: 'object' }),
            embalagem: nullable({ type: 'object' }),
            checklist: obj({ aprovados: int, reprovados: arr(str), nao_testados: int }),
            garantia: nullable({ type: 'object' }),
            eventos_comerciais: arr({ type: 'object' }),
            historico: arr(obj({ em: str, evento: str })),
          }),
        ),
      },
      ['dica', 'estoque', 'vendas'],
    ),
    run: (args, ctx) => withDb(ctx.source, (db) => consultarMaquina(db, ctx.clock(), { busca: args.busca as string })),
  },
];

/** outputSchema só existe a partir do protocolo 2025-06-18; clientes antigos não o recebem. */
export function listTools(withOutputSchema = true) {
  return TOOLS.map(({ name, title, description, inputSchema, outputSchema }) => ({
    name,
    title,
    description,
    inputSchema,
    ...(withOutputSchema ? { outputSchema } : {}),
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
    if (spec.type === 'boolean') {
      if (value === 'true' || value === 'false') value = value === 'true';
      if (typeof value !== 'boolean') throw new ArgumentError(`${key} deve ser true ou false.`);
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
