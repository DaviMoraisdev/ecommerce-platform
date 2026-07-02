import {
  findAllProducts,
  createProduct,
  updateProduct,
  deleteProduct,
} from '../src/services/product.service';
import { Product } from '../src/models/product.model';
import { redisFns, resetRedisMock } from './helpers/mockRedisInstrumented';

jest.mock('../src/config/redis', () =>
  require('./helpers/mockRedisInstrumented').makeInstrumentedRedis()
);
jest.mock('../src/services/inventory.client', () => ({
  fetchAvailability: jest.fn().mockResolvedValue(null),
}));

beforeEach(() => {
  resetRedisMock();
});

async function seedProducts(n: number) {
  const docs = [];
  for (let i = 0; i < n; i++) {
    docs.push({ name: `P${i}`, description: `d${i}`, price: 10 + i, category: 'geral' });
  }
  await Product.insertMany(docs);
}

// Captura a cacheKey pela LEITURA do cache: o service faz get(versao) e
// get(cacheKey). O 2o get (indice 1) e a chave do cache.
async function keyForOptions(opts: any): Promise<string> {
  redisFns.get.mockClear();
  await findAllProducts(opts);
  // calls: [0] = versao, [1] = cacheKey
  return redisFns.get.mock.calls[1][0] as string;
}

describe('cache — hit e miss', () => {
  it('HIT: retorna o cacheado SEM consultar o banco', async () => {
    // Spies no Mongo: provam que o hit nao toca o banco (achado do review).
    const findSpy = jest.spyOn(Product, 'find');
    const countSpy = jest.spyOn(Product, 'countDocuments');

    const cachedResult = { data: [{ name: 'DoCache' }], page: 1, limit: 20, total: 1, totalPages: 1 };
    // Pre-popula o cache no store: primeiro descobrimos a chave, depois gravamos.
    await seedProducts(3);
    const key = await keyForOptions({});
    await redisFns.set(key, JSON.stringify(cachedResult));

    findSpy.mockClear();
    countSpy.mockClear();

    const result = await findAllProducts({});

    expect(result.data).toHaveLength(1);
    expect((result.data[0] as any).name).toBe('DoCache');
    // O cerne: cache hit NAO consulta o banco.
    expect(findSpy).not.toHaveBeenCalled();
    expect(countSpy).not.toHaveBeenCalled();

    findSpy.mockRestore();
    countSpy.mockRestore();
  });

  it('MISS: busca no banco e retorna formato paginado', async () => {
    await seedProducts(3);
    const result = await findAllProducts({});

    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('total', 3);
    expect(result).toHaveProperty('totalPages', 1);
    expect(result.data).toHaveLength(3);
  });

  it('MISS grava no cache com TTL (EX, 60)', async () => {
    await seedProducts(2);
    await findAllProducts({});

    expect(redisFns.set).toHaveBeenCalledTimes(1);
    const args = redisFns.set.mock.calls[0];
    expect(typeof args[0]).toBe('string');
    expect(typeof args[1]).toBe('string');
    expect(args[2]).toBe('EX');
    expect(args[3]).toBe(60);
  });
});

describe('cache — chave', () => {
  it('unicidade: params com delimitadores geram chaves diferentes', async () => {
    const keyA = await keyForOptions({ category: 'a:s=b' });
    const keyB = await keyForOptions({ search: 'b' });
    expect(keyA).not.toBe(keyB);
  });

  it('determinismo: os mesmos params geram a mesma chave', async () => {
    const key1 = await keyForOptions({ category: 'eletronicos', page: 2 });
    const key2 = await keyForOptions({ category: 'eletronicos', page: 2 });
    expect(key1).toBe(key2);
  });

  it('a versao faz parte da chave: apos invalidacao (incr), a chave muda', async () => {
    // Store stateful: a chave reflete a versao real lida do store.
    const keyBefore = await keyForOptions({ category: 'x' });
    expect(keyBefore).toContain('v0');

    // Invalida de verdade: incr na versao. O store passa a ter version=1.
    await createProduct({ name: 'N', description: 'd', price: 10, category: 'geral' } as any);

    const keyAfter = await keyForOptions({ category: 'x' });
    expect(keyAfter).toContain('v1');
    expect(keyAfter).not.toBe(keyBefore);
  });
});

describe('cache — invalidacao (INCR da versao)', () => {
  it('createProduct chama incr na chave de versao', async () => {
    await createProduct({ name: 'Novo', description: 'd', price: 10, category: 'geral' } as any);
    expect(redisFns.incr).toHaveBeenCalledWith('products:list:version');
  });

  it('updateProduct chama incr quando atualiza', async () => {
    const p = await Product.create({ name: 'X', description: 'd', price: 10, category: 'geral' });
    redisFns.incr.mockClear();
    await updateProduct(String(p._id), { price: 20 });
    expect(redisFns.incr).toHaveBeenCalledWith('products:list:version');
  });

  it('updateProduct NAO chama incr se o produto nao existe', async () => {
    redisFns.incr.mockClear();
    await updateProduct('0123456789abcdef01234567', { price: 20 });
    expect(redisFns.incr).not.toHaveBeenCalled();
  });

  it('deleteProduct chama incr quando deleta', async () => {
    const p = await Product.create({ name: 'Y', description: 'd', price: 10, category: 'geral' });
    redisFns.incr.mockClear();
    await deleteProduct(String(p._id));
    expect(redisFns.incr).toHaveBeenCalledWith('products:list:version');
  });
});

describe('cache — degradacao graciosa', () => {
  it('get lanca (Redis indisponivel na leitura) -> vai ao banco', async () => {
    redisFns.get.mockRejectedValue(new Error('Redis down'));
    await seedProducts(2);

    const result = await findAllProducts({});
    expect(result.data).toHaveLength(2);
  });

  it('set lanca (falha na escrita) -> retorna resultado mesmo sem cachear', async () => {
    redisFns.set.mockRejectedValue(new Error('Redis down'));
    await seedProducts(2);

    const result = await findAllProducts({});
    expect(result.data).toHaveLength(2);
  });

  it('JSON invalido no cache -> cai no catch, vai ao banco', async () => {
    await seedProducts(3);
    // Grava lixo na chave de cache que sera lida.
    const key = await keyForOptions({});
    await redisFns.set(key, '{corrompido');

    const result = await findAllProducts({});
    expect(result.data).toHaveLength(3);
  });

  it('getCacheVersion falha -> usa versao 0, nao quebra', async () => {
    // So o primeiro get (versao) lanca; os demais seguem o default stateful.
    redisFns.get.mockRejectedValueOnce(new Error('down'));
    await seedProducts(2);

    const result = await findAllProducts({});
    expect(result.data).toHaveLength(2);
  });

  it('invalidacao falha (incr lanca) -> a operacao (create) completa', async () => {
    redisFns.incr.mockRejectedValue(new Error('Redis down'));

    const created = await createProduct({
      name: 'Resiliente', description: 'd', price: 10, category: 'geral',
    } as any);

    expect(created).toHaveProperty('_id');
    expect(created.name).toBe('Resiliente');
  });
});
