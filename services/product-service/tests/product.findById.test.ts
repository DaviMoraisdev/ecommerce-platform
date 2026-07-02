import { findProductById } from '../src/services/product.service';
import { Product } from '../src/models/product.model';
import { fetchAvailability } from '../src/services/inventory.client';

jest.mock('../src/services/inventory.client');
jest.mock('../src/config/redis', () => require('./helpers/mockRedis').makeRedisMock());

const mockFetch = fetchAvailability as jest.MockedFunction<typeof fetchAvailability>;

beforeEach(() => {
  mockFetch.mockReset();
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
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('produto inativo (active:false) -> null', async () => {
    const product = await seedProduct(false);
    const result = await findProductById(String(product._id));
    expect(result).toBeNull();
  });

  it('ID malformado -> lanca CastError (service nao tem try/catch, propaga)', async () => {
    // O contrato do SERVICE e propagar o CastError do Mongoose. A traducao
    // desse erro para HTTP 400 e responsabilidade do controller (handleError),
    // testada separadamente na camada de rota — nao aqui.
    await expect(findProductById('id-invalido')).rejects.toThrow(
      expect.objectContaining({ name: 'CastError' })
    );
    expect(mockFetch).not.toHaveBeenCalled();
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

    expect(result?.availability).toEqual({ available: 0, inStock: false });
  });

  it('availability null (inventory fora) -> produto retornado com availability null', async () => {
    const product = await seedProduct();
    mockFetch.mockResolvedValue(null);

    const result = await findProductById(String(product._id));

    expect(result).not.toBeNull();
    expect(result?.availability).toBeNull();
    expect(result?.name).toBe('Monitor 4K');
  });
});
