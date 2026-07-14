const TIMEOUT_MS = 3000;

export interface ProductInfo {
  id: string;
  name: string;
  price: number;
  availability: { available: number; inStock: boolean } | null;
}

export type ProductResult =
  | { status: 'ok'; product: ProductInfo }
  | { status: 'not_found' }
  | { status: 'unavailable' };

// available deve ser inteiro >= 0 (contagem de estoque); inStock booleano.
// Rejeita NaN/Infinity/negativo/decimais — senao NaN faria desiredQty > NaN
// ser sempre falso, furando a checagem de estoque.
function isValidAvailability(a: unknown): a is { available: number; inStock: boolean } {
  if (typeof a !== 'object' || a === null) return false;
  const av = a as Record<string, unknown>;
  return (
    typeof av.available === 'number' &&
    Number.isInteger(av.available) &&
    av.available >= 0 &&
    typeof av.inStock === 'boolean'
  );
}

function isValidProduct(data: unknown): data is {
  _id: string;
  name: string;
  price: number;
  availability: { available: number; inStock: boolean } | null;
} {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  const availabilityOk = d.availability === null || isValidAvailability(d.availability);
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
    const productUrl = process.env.PRODUCT_SERVICE_URL || 'http://localhost:3003';
    const url = productUrl + '/products/' + encodeURIComponent(productId);
    const response = await fetch(url, { signal: controller.signal });

    // 404 = nao existe; 400 = id malformado (CastError do product-service).
    // Ambos sao "produto invalido/inexistente" do ponto de vista do cart,
    // NAO indisponibilidade do servico (que esta saudavel respondendo 400).
    if (response.status === 404 || response.status === 400) {
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
