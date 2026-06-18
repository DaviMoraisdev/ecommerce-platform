// Client para comunicacao com o inventory-service via REST.
// O product-service NAO acessa o banco de estoque — ele consome a API publica.

const TIMEOUT_MS = 3000;

export interface StockAvailability {
  productId: string;
  quantity: number;
  reserved: number;
  available: number;
}

// Valida que a resposta do inventory tem o formato e os tipos esperados.
// Dado que cruza a fronteira entre servicos NAO e confiavel ate ser validado.
function isValidAvailability(data: unknown): data is StockAvailability {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const d = data as Record<string, unknown>;
  return (
    typeof d.productId === 'string' &&
    typeof d.quantity === 'number' && Number.isFinite(d.quantity) && d.quantity >= 0 &&
    typeof d.reserved === 'number' && Number.isFinite(d.reserved) && d.reserved >= 0 &&
    typeof d.available === 'number' && Number.isFinite(d.available)
  );
}

export async function fetchAvailability(productId: string): Promise<StockAvailability | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // Resolve a URL aqui (nao no topo do modulo) para garantir que o
    // dotenv ja carregou a variavel quando a funcao e chamada.
    const inventoryUrl = process.env.INVENTORY_SERVICE_URL || 'http://localhost:3004';
    // encodeURIComponent evita que caracteres especiais no id alterem a rota
    const url = `${inventoryUrl}/stock/${encodeURIComponent(productId)}`;
    const response = await fetch(url, { signal: controller.signal });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      console.warn(`[inventory.client] resposta inesperada: status ${response.status}`);
      return null;
    }

    const data = await response.json();

    // Valida o formato antes de confiar no dado externo
    if (!isValidAvailability(data)) {
      console.warn('[inventory.client] payload de estoque invalido descartado');
      return null;
    }

    return data;
  } catch (error) {
    // Distingue timeout de outras falhas no log, sem vazar dado sensivel
    const reason = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'falha de conexao';
    console.warn(`[inventory.client] estoque indisponivel (${reason})`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
