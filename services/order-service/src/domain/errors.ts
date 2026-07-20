// Erro de dominio com CODIGO estavel. Consumidores (rotas, logs) mapeiam
// por `code`, nunca por texto de mensagem — que pode mudar sem quebrar contrato.
export class DomainError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'DomainError';
  }
}

export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError;
}
