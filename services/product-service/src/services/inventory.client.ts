// Client para comunicacao com o inventory-service via REST.
// O product-service NAO acessa o banco de estoque — ele consome a API publica.

const TIMEOUT_MS = 3000;

export interface StockAvailability {
  productId: string;
  quantity: number;
  reserved: number;
  available: number;
}

// Valida o formato dos campos confiaveis (productId, quantity, reserved).
// available NAO e validado aqui — sera RECALCULADO, pois e um valor derivado
// e nao devemos confiar no numero que o inventory envia (pode vir inconsistente).
function hasValidFields(data: unknown): data is { productId: string; quantity: number; reserved: number } {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const d = data as Record<string, unknown>;
  return (
    typeof d.productId === 'string' &&
    typeof d.quantity === 'number' && Number.isFinite(d.quantity) && d.quantity >= 0 &&
    typeof d.reserved === 'number' && Number.isFinite(d.reserved) && d.reserved >= 0 &&
    d.reserved <= d.quantity
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

    // Parse do JSON isolado: erro aqui e payload malformado, nao falha de rede
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      console.warn('[inventory.client] payload de estoque nao e JSON valido');
      return null;
    }

    // Valida os campos confiaveis antes de usar
    if (!hasValidFields(data)) {
      console.warn('[inventory.client] payload de estoque invalido descartado');
      return null;
    }

    // RECALCULA available a partir dos campos validados — nunca confia no
    // available recebido, que poderia vir inconsistente ou negativo.
    const available = data.quantity - data.reserved;

    return {
      productId: data.productId,
      quantity: data.quantity,
      reserved: data.reserved,
      available,
    };
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'falha de conexao';
    console.warn(`[inventory.client] estoque indisponivel (${reason})`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
