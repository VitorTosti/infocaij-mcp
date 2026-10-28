/**
 * Vocabulário do InfoCAIJ, espelhado de src/shared/schema.ts do sistema.
 * Mantido aqui para o servidor MCP não depender do código da aplicação.
 */

export const STATUSES = [
  'Pendente',
  'Em preparacao',
  'Aguardando teste',
  'Pronta',
  'Aguardando retirada',
  'Aguardando nota fiscal',
  'Aguardando embalagem',
  'Entregue/Enviada',
] as const;

export type Status = (typeof STATUSES)[number];

export const FINAL_STATUS: Status = 'Entregue/Enviada';

export const PLATFORMS = ['Shopee', 'Mercado Livre', 'Cassio', 'Venda Externa', 'Venda Interna'] as const;
export const COMPANIES = ['CAIJ', 'AIJ', 'CRIGOR', 'ALUAP'] as const;
export const STOCK_STATUSES = ['recebida', 'em_triagem', 'pronta', 'vendida'] as const;

export const CHECKLIST_LABELS = [
  'Liga', 'Tela', 'Teclado', 'Touchpad', 'Wi-Fi', 'Som', 'Portas USB', 'Bateria', 'Carregador', 'Sistema instalado',
] as const;

/** Formato gravado pelo repositório: "Status alterado de <anterior> para <próximo>." */
const STATUS_CHANGE = /^Status alterado de (.+) para (.+)\.$/;

export function parseStatusChange(description: string): { from: Status; to: Status } | null {
  const match = STATUS_CHANGE.exec(description.trim());
  if (!match) return null;
  const from = match[1] as Status;
  const to = match[2] as Status;
  if (!STATUSES.includes(from) || !STATUSES.includes(to)) return null;
  return { from, to };
}

export function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}
