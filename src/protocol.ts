import { ArgumentError, findTool, listTools, validateArgs, type ToolContext } from './tools.ts';
import { findPrompt, listPrompts } from './prompts.ts';

/**
 * Implementação do Model Context Protocol (JSON-RPC 2.0) sem dependências.
 * Especificação: https://modelcontextprotocol.io/specification
 */

export const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_INFO = { name: 'infocaij-mcp', title: 'InfoCAIJ', version: '0.2.0' };

/** Saída estruturada (structuredContent e outputSchema) existe a partir desta versão do protocolo. */
const STRUCTURED_SINCE = '2025-06-18';

const INSTRUCTIONS = `Servidor somente leitura sobre o InfoCAIJ, o sistema que acompanha vendas, bancada técnica, estoque e garantia de notebooks na CAIJ Informática.
Fluxo de cada máquina: Pendente → Em preparacao → Aguardando teste → Pronta → Aguardando retirada → Aguardando nota fiscal → Aguardando embalagem → Entregue/Enviada.
Comece por resumo_fila em perguntas gerais. Para "onde trava", use tempo_por_etapa. Para uma máquina específica, use consultar_maquina.
Tempos vêm em horas corridas; para julgar atraso real use horas = "uteis", que desconta noites e fins de semana.
Nenhuma ferramenta altera dados e nenhuma retorna dados pessoais de clientes.`;

export const ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

type Id = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: Id | null;
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: Id | null; result: unknown }
  | { jsonrpc: '2.0'; id: Id | null; error: { code: number; message: string } };

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export interface HandlerOptions {
  /** Tempo máximo de uma chamada de ferramenta. Padrão: INFOCAIJ_MCP_TIMEOUT_MS ou 30 s. */
  timeoutMs?: number;
  /** Tamanho máximo do texto de uma resposta, em caracteres. Evita estourar o contexto do modelo. */
  maxChars?: number;
}

export function createHandler(ctx: ToolContext, log: (message: string) => void = () => {}, options: HandlerOptions = {}) {
  const timeoutMs = options.timeoutMs ?? Number(process.env.INFOCAIJ_MCP_TIMEOUT_MS ?? 30_000);
  const maxChars = options.maxChars ?? 200_000;

  let protocolVersion = SUPPORTED_VERSIONS[0];
  const structured = () => protocolVersion >= STRUCTURED_SINCE;

  /** Pedidos que o cliente cancelou: a resposta, quando pronta, é descartada. */
  const cancelled = new Set<Id>();
  const pending = new Set<Promise<unknown>>();

  async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const requested = String(params.protocolVersion ?? '');
        protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: listTools(structured()) };
      case 'tools/call':
        return callTool(params);
      case 'prompts/list':
        return { prompts: listPrompts() };
      case 'prompts/get':
        return getPrompt(params);
      default:
        throw new RpcError(ERROR.METHOD_NOT_FOUND, `Método não suportado: ${method}`);
    }
  }

  function toolError(message: string) {
    return { content: [{ type: 'text', text: message }], isError: true };
  }

  async function callTool(params: Record<string, unknown>) {
    const name = String(params.name ?? '');
    const tool = findTool(name);
    if (!tool) throw new RpcError(ERROR.INVALID_PARAMS, `Ferramenta desconhecida: ${name}`);

    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const args = validateArgs(tool.inputSchema, params.arguments);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs);
      });
      const result = await Promise.race([tool.run(args, ctx), timeout]);
      const text = JSON.stringify(result, null, 2);
      if (text.length > maxChars) {
        log(`${name} recusada: resposta de ${text.length} caracteres`);
        return toolError('O resultado ficou grande demais. Peça um período menor ou filtre por etapa, plataforma ou técnico.');
      }
      log(`${name} ok em ${Date.now() - started} ms`);
      return {
        content: [{ type: 'text', text }],
        ...(structured() ? { structuredContent: result } : {}),
        isError: false,
      };
    } catch (error) {
      // Erros de ferramenta voltam como resultado, para o modelo poder corrigir a chamada.
      let message: string;
      if (error instanceof ArgumentError) message = error.message;
      else if (error instanceof TimeoutError) message = error.message;
      else message = `Falha ao consultar o InfoCAIJ: ${(error as Error).message}`;
      log(`${name} falhou: ${message}`);
      return toolError(message);
    } finally {
      clearTimeout(timer);
    }
  }

  function getPrompt(params: Record<string, unknown>) {
    const name = String(params.name ?? '');
    const prompt = findPrompt(name);
    if (!prompt) throw new RpcError(ERROR.INVALID_PARAMS, `Prompt desconhecido: ${name}`);
    const args = (params.arguments ?? {}) as Record<string, string>;
    for (const arg of prompt.arguments) {
      if (arg.required && !args[arg.name]) throw new RpcError(ERROR.INVALID_PARAMS, `Argumento obrigatório ausente: ${arg.name}`);
    }
    return {
      description: prompt.description,
      messages: [{ role: 'user', content: { type: 'text', text: prompt.render(args) } }],
    };
  }

  /** Processa uma mensagem. Notificações (sem id) não têm resposta, e pedidos cancelados também não. */
  async function handle(message: unknown): Promise<JsonRpcResponse | null> {
    if (typeof message !== 'object' || message === null || (message as JsonRpcRequest).jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id: null, error: { code: ERROR.INVALID_REQUEST, message: 'Requisição JSON-RPC 2.0 inválida.' } };
    }
    const request = message as JsonRpcRequest;
    const isNotification = request.id === undefined || request.id === null;

    if (typeof request.method !== 'string') {
      // Respostas a pedidos do servidor (não usamos) e mensagens sem método são ignoradas.
      return null;
    }
    if (isNotification) {
      if (request.method === 'notifications/cancelled') {
        const target = request.params?.requestId;
        if (typeof target === 'string' || typeof target === 'number') cancelled.add(target);
      }
      return null;
    }

    const id = request.id as Id;
    const work = (async (): Promise<JsonRpcResponse | null> => {
      try {
        const result = await dispatch(request.method, request.params ?? {});
        return { jsonrpc: '2.0', id, result };
      } catch (error) {
        const code = error instanceof RpcError ? error.code : ERROR.INTERNAL;
        return { jsonrpc: '2.0', id, error: { code, message: (error as Error).message } };
      }
    })();
    pending.add(work);
    try {
      const response = await work;
      if (cancelled.delete(id)) {
        log(`pedido ${id} cancelado pelo cliente; resposta descartada`);
        return null;
      }
      return response;
    } finally {
      pending.delete(work);
    }
  }

  /** Resolve quando não há pedido em andamento. Usado para encerrar sem cortar respostas. */
  handle.idle = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };

  return handle;
}

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`A consulta passou de ${ms < 10_000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)} s e foi interrompida. Tente um período menor.`);
  }
}
