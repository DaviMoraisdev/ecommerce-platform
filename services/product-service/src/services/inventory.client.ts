// Client para comunicacao com o inventory-service via REST.
// O product-service NAO acessa o banco de estoque — ele consome a API publica.

const INVENTORY_URL = process.env.INVENTORY_SERVICE_URL || 'http://localhost:3004';
const TIMEOUT_MS = 3000;

export interface StockAvailability {
  productId: string;
  quantity: number;
  reserved: number;
  available: number;
}

// Busca a disponibilidade de um produto no inventory-service.
// Retorna null se nao houver estoque cadastrado ou se o servico falhar.
export async function fetchAvailability(productId: string): Promise<StockAvailability | null> {
  // AbortController implementa o timeout: se a resposta demorar demais,
  // cancelamos a requisicao em vez de travar o product-service.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${INVENTORY_URL}/stock/${productId}`, {
      signal: controller.signal,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as StockAvailability;
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
