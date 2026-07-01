import { findProductById } from '../src/services/product.service';
import { Product } from '../src/models/product.model';
import { fetchAvailability } from '../src/services/inventory.client';

// fetchAvailability e mockado: ja testado isolado no 8c-1. Aqui controlamos
// o retorno dele para simular os 3 cenarios de disponibilidade.
jest.mock('../src/services/inventory.client');
jest.mock('../src/config/redis', () => require('./helpers/mockRedis').makeRedisMock());

const mockFetch = fetchAvailability as jest.MockedFunction<typeof fetchAvailability>;

afterEach(() => {
  jest.clearAllMocks();
});

async function seedProduct(active = true) {
  return Product.create({
    name: 'Monitor 4K',
    description: '27 polegadas',
    price: 1500,
    category: 'perifericos',
    active,
  });
}

const MISSING_ID = '0123456789abcdef01234567';

describe('findProductById', () => {
  it('produto ausente -> null', async () => {
    const result = await findProductById(MISSING_ID);
    expect(result).toBeNull();
    // Nem chega a consultar disponibilidade se o produto nao existe.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('produto inativo (active:false) -> null', async () => {
    const product = await seedProduct(false);
    const result = await findProductById(String(product._id));
    expect(result).toBeNull();
  });

  it('com availability e estoque > 0 -> inStock true', async () => {
    const product = await seedProduct();
    mockFetch.mockResolvedValue({
      productId: String(product._id),
      quantity: 10,
      reserved: 3,
      available: 7,
    });

    const result = await findProductById(String(product._id));

    expect(result).not.toBeNull();
    expect(result?.availability).toEqual({ available: 7, inStock: true });
    expect(result?.name).toBe('Monitor 4K');
  });

  it('com availability e estoque = 0 -> inStock false', async () => {
    const product = await seedProduct();
    mockFetch.mockResolvedValue({
      productId: String(product._id),
      quantity: 5,
      reserved: 5,
      available: 0,
    });

    const result = await findProductById(String(product._id));

    // Prova a derivacao inStock = available > 0 (0 nao e "em estoque").
    expect(result?.availability).toEqual({ available: 0, inStock: false });
  });

  it('availability null (inventory fora) -> produto retornado com availability null', async () => {
    const product = await seedProduct();
    mockFetch.mockResolvedValue(null);

    const result = await findProductById(String(product._id));

    // Degradacao graciosa: o produto ainda volta, so sem disponibilidade.
    expect(result).not.toBeNull();
    expect(result?.availability).toBeNull();
    expect(result?.name).toBe('Monitor 4K');
  });
});
