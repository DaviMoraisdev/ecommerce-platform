import {
  findAllProducts,
  createProduct,
  updateProduct,
  deleteProduct,
} from '../src/services/product.service';
import { Product } from '../src/models/product.model';
import { redisFns } from './helpers/mockRedisInstrumented';

jest.mock('../src/config/redis', () =>
  require('./helpers/mockRedisInstrumented').makeInstrumentedRedis()
);
jest.mock('../src/services/inventory.client', () => ({
  fetchAvailability: jest.fn().mockResolvedValue(null),
}));

beforeEach(() => {
  redisFns.get.mockReset();
  redisFns.set.mockReset();
  redisFns.incr.mockReset();
  redisFns.incr.mockResolvedValue(1);
});

async function seedProducts(n: number) {
  const docs = [];
  for (let i = 0; i < n; i++) {
    docs.push({ name: `P${i}`, description: `d${i}`, price: 10 + i, category: 'geral' });
  }
  await Product.insertMany(docs);
}

// Captura a cacheKey que o service usa: e o 1o argumento do redis.get da
// LEITURA do cache (a 2a chamada de get; a 1a e a versao). Com get devolvendo
// null, o service segue para o banco e chama set — o 1o arg do set tambem e a key.
async function keyForOptions(opts: any): Promise<string> {
  redisFns.get.mockResolvedValue(null);
  redisFns.set.mockClear();
  await findAllProducts(opts);
  return redisFns.set.mock.calls[0][0] as string;
}

describe('cache — hit e miss', () => {
  it('HIT: get devolve valor cacheado -> retorna sem consultar o banco', async () => {
    const cachedResult = { data: [{ name: 'DoCache' }], page: 1, limit: 20, total: 1, totalPages: 1 };
    redisFns.get
      .mockResolvedValueOnce('0')
      .mockResolvedValueOnce(JSON.stringify(cachedResult));

    await seedProducts(3);
    const result = await findAllProducts({});

    expect(result.data).toHaveLength(1);
    expect((result.data[0] as any).name).toBe('DoCache');
    expect(redisFns.set).not.toHaveBeenCalled();
  });

  it('MISS: get devolve null -> busca no banco e retorna formato paginado', async () => {
    redisFns.get.mockResolvedValue(null);
    await seedProducts(3);
    const result = await findAllProducts({});

    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('total', 3);
    expect(result).toHaveProperty('totalPages', 1);
    expect(result.data).toHaveLength(3);
  });

  it('MISS grava no cache com TTL (EX, 60)', async () => {
    redisFns.get.mockResolvedValue(null);
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
  it('unicidade: params com delimitadores geram chaves diferentes (sem colisao)', async () => {
    // O caso classico de colisao: se a chave concatenasse com ':', category
    // 'a:s=b' poderia colidir com search 'b'. O array JSON evita isso.
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
    // Versao 0 -> chave contem v0.
    redisFns.get.mockResolvedValue(null);
    redisFns.set.mockClear();
    await findAllProducts({ category: 'x' });
    const keyV0 = redisFns.set.mock.calls[0][0] as string;

    // Simula versao incrementada: agora getCacheVersion le '1'.
    redisFns.get.mockReset();
    redisFns.get.mockResolvedValue(null);
    // 1a chamada get (versao) devolve '1'; demais (cache) null.
    redisFns.get.mockResolvedValueOnce('1');
    redisFns.set.mockClear();
    await findAllProducts({ category: 'x' });
    const keyV1 = redisFns.set.mock.calls[0][0] as string;

    expect(keyV0).toContain('v0');
    expect(keyV1).toContain('v1');
    expect(keyV0).not.toBe(keyV1);
  });
});

describe('cache — invalidacao (INCR da versao)', () => {
  it('createProduct chama incr (invalida o cache)', async () => {
    redisFns.get.mockResolvedValue(null);
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
  it('get lanca (Redis indisponivel na leitura) -> vai ao banco, nao quebra', async () => {
    redisFns.get.mockRejectedValue(new Error('Redis down'));
    await seedProducts(2);

    const result = await findAllProducts({});
    expect(result.data).toHaveLength(2); // veio do banco
  });

  it('set lanca (falha na escrita) -> retorna o resultado mesmo sem cachear', async () => {
    redisFns.get.mockResolvedValue(null);
    redisFns.set.mockRejectedValue(new Error('Redis down'));
    await seedProducts(2);

    const result = await findAllProducts({});
    expect(result.data).toHaveLength(2);
  });

  it('JSON invalido no cache -> JSON.parse lanca, cai no catch, vai ao banco', async () => {
    redisFns.get
      .mockResolvedValueOnce('0')             // versao
      .mockResolvedValueOnce('{corrompido');  // cache com JSON invalido
    await seedProducts(3);

    const result = await findAllProducts({});
    expect(result.data).toHaveLength(3); // caiu no catch e foi ao banco
  });

  it('getCacheVersion falha (get da versao lanca) -> usa versao 0, nao quebra', async () => {
    // 1a chamada (versao) lanca; a leitura do cache tambem retorna null.
    redisFns.get
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(null);
    await seedProducts(2);

    const result = await findAllProducts({});
    expect(result.data).toHaveLength(2);
  });

  it('invalidacao falha (incr lanca) -> a operacao (create) completa mesmo assim', async () => {
    redisFns.get.mockResolvedValue(null);
    redisFns.incr.mockRejectedValue(new Error('Redis down'));

    const created = await createProduct({
      name: 'Resiliente', description: 'd', price: 10, category: 'geral',
    } as any);

    // O produto foi criado apesar da invalidacao falhar.
    expect(created).toHaveProperty('_id');
    expect(created.name).toBe('Resiliente');
  });
});
