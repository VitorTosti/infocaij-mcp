import { ArgumentError, findTool, listTools, validateArgs, type ToolContext } from './tools.ts';
import { findPrompt, listPrompts } from './prompts.ts';

/**
 * Implementação do Model Context Protocol (JSON-RPC 2.0) sem dependências.
 * Especificação: https://modelcontextprotocol.io/specification
 */

export const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_INFO = { name: 'infocaij-mcp', title: 'InfoCAIJ', version: '0.1.0' };

const INSTRUCTIONS = `Servidor somente leitura sobre o InfoCAIJ, o sistema que acompanha vendas, bancada técnica, estoque e garantia de notebooks na CAIJ Informática.
Fluxo de cada máquina: Pendente → Em preparacao → Aguardando teste → Pronta → Aguardando retirada → Aguardando nota fiscal → Aguardando embalagem → Entregue/Enviada.
Comece por resumo_fila em perguntas gerais. Para "onde trava", use tempo_por_etapa. Para uma máquina específica, use consultar_maquina.
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

export function createHandler(ctx: ToolContext, log: (message: string) => void = () => {}) {
  function dispatch(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case 'initialize': {
        const requested = String(params.protocolVersion ?? '');
        return {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: listTools() };
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

  function callTool(params: Record<string, unknown>) {
    const name = String(params.name ?? '');
    const tool = findTool(name);
    if (!tool) throw new RpcError(ERROR.INVALID_PARAMS, `Ferramenta desconhecida: ${name}`);

    const started = Date.now();
    try {
      const args = validateArgs(tool.inputSchema, params.arguments);
      const result = tool.run(args, ctx);
      log(`${name} ok em ${Date.now() - started} ms`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false };
    } catch (error) {
      // Erros de ferramenta voltam como resultado, para o modelo poder corrigir a chamada.
      const message = error instanceof ArgumentError ? error.message : `Falha ao consultar o InfoCAIJ: ${(error as Error).message}`;
      log(`${name} falhou: ${message}`);
      return { content: [{ type: 'text', text: message }], isError: true };
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

  /** Processa uma mensagem. Notificações (sem id) não têm resposta. */
  return function handle(message: unknown): JsonRpcResponse | null {
    if (typeof message !== 'object' || message === null || (message as JsonRpcRequest).jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id: null, error: { code: ERROR.INVALID_REQUEST, message: 'Requisição JSON-RPC 2.0 inválida.' } };
    }
    const request = message as JsonRpcRequest;
    const isNotification = request.id === undefined || request.id === null;

    if (typeof request.method !== 'string') {
      // Respostas a pedidos do servidor (não usamos) e mensagens sem método são ignoradas.
      return null;
    }
    if (isNotification) return null;

    try {
      return { jsonrpc: '2.0', id: request.id as Id, result: dispatch(request.method, request.params ?? {}) };
    } catch (error) {
      const code = error instanceof RpcError ? error.code : ERROR.INTERNAL;
      return { jsonrpc: '2.0', id: request.id as Id, error: { code, message: (error as Error).message } };
    }
  };
}
