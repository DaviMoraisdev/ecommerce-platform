// Client REST para o product-service. O cart NAO acessa Mongo nem inventory:
// consome a API publica GET /products/:id, que ja vem enriquecida com
// disponibilidade (availability) pelo proprio product-service.

const TIMEOUT_MS = 3000;

export interface ProductInfo {
  id: string;
  name: string;
  price: number;
  availability: { available: number; inStock: boolean } | null;
}

// Resultado em 3 estados — diferente do inventory.client da Fase 3 (que
// retornava null): aqui precisamos distinguir "produto nao existe" (404 ->
// rejeitar) de "servico indisponivel" (timeout/erro -> rejeitar no add,
// degradar na leitura). Um null unico perderia essa distincao.
export type ProductResult =
  | { status: 'ok'; product: ProductInfo }
  | { status: 'not_found' }
  | { status: 'unavailable' };

function isValidProduct(data: unknown): data is {
  _id: string;
  name: string;
  price: number;
  availability: { available: number; inStock: boolean } | null;
} {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  const availabilityOk =
    d.availability === null ||
    (typeof d.availability === 'object' &&
      d.availability !== null &&
      typeof (d.availability as Record<string, unknown>).available === 'number');
  return (
    typeof d._id === 'string' &&
    typeof d.name === 'string' &&
    typeof d.price === 'number' &&
    Number.isFinite(d.price) &&
    d.price >= 0 &&
    availabilityOk
  );
}

export async function fetchProduct(productId: string): Promise<ProductResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // Resolve a URL aqui (nao no topo do modulo): garante que o dotenv ja
    // carregou quando a funcao e chamada.
    const productUrl = process.env.PRODUCT_SERVICE_URL || 'http://localhost:3003';
    const url = productUrl + '/products/' + encodeURIComponent(productId);
    const response = await fetch(url, { signal: controller.signal });

    if (response.status === 404) {
      return { status: 'not_found' };
    }
    if (!response.ok) {
      console.warn('[product.client] resposta inesperada: status ' + response.status);
      return { status: 'unavailable' };
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      console.warn('[product.client] payload de produto nao e JSON valido');
      return { status: 'unavailable' };
    }

    if (!isValidProduct(data)) {
      console.warn('[product.client] payload de produto invalido descartado');
      return { status: 'unavailable' };
    }

    return {
      status: 'ok',
      product: {
        id: String(data._id),
        name: data.name,
        price: data.price,
        availability: data.availability,
      },
    };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'AbortError'
        ? 'timeout'
        : 'falha de conexao';
    console.warn('[product.client] product-service indisponivel (' + reason + ')');
    return { status: 'unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}
