import { Product, IProduct } from '../models/product.model';
import { fetchAvailability } from './inventory.client';
import { getRedisClient } from '../config/redis';
import crypto from 'crypto';

const ALLOWED_FIELDS = ['name', 'description', 'price', 'category', 'imageUrl'];

// Prefixo, chave de versao e TTL do cache de listagem
const LIST_CACHE_PREFIX = 'products:list:';
const LIST_VERSION_KEY = 'products:list:version';
const LIST_CACHE_TTL = 60; // segundos

// Le a versao atual do cache. Se nao existe, assume 1.
// A versao faz parte da chave de cada listagem cacheada — quando ela muda,
// todo cache anterior fica orfao (escrito sob versao velha que ninguem le).
async function getCacheVersion(): Promise<string> {
  try {
    const redis = getRedisClient();
    const version = await redis.get(LIST_VERSION_KEY);
    // Default '0' (nao '1') para nao colidir com o primeiro INCR, que tambem
    // produz '1'. Assim a primeira invalidacao realmente muda a versao lida.
    return version || '0';
  } catch {
    return '0';
  }
}

// Invalida o cache de listagem INCREMENTANDO a versao. Chamada quando um produto muda.
// Em vez de apagar chaves (que uma escrita atrasada poderia recriar com dado velho),
// mudamos a versao: todo cache anterior fica sob uma versao que ninguem mais le.
// Resolve a condicao de corrida e e O(1) — nao varre o keyspace.
async function invalidateListCache(): Promise<void> {
  try {
    const redis = getRedisClient();
    // INCR cria a chave em 1 se nao existir, ou incrementa. Operacao atomica.
    await redis.incr(LIST_VERSION_KEY);
  } catch (err) {
    // Falha na invalidacao nao quebra a operacao. O TTL de 60s e a rede de seguranca.
    console.warn('[cache] invalidacao falhou (TTL cobrira)');
  }
}
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

function pickAllowedFields(data: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const field of ALLOWED_FIELDS) {
    if (data[field] !== undefined) {
      result[field] = data[field];
    }
  }
  return result;
}

interface FindAllOptions {
  page?: number;
  limit?: number;
  search?: string;
  category?: string;
}

interface PaginatedResult {
  data: IProduct[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export async function createProduct(data: Partial<IProduct>): Promise<IProduct> {
  const safeData = pickAllowedFields(data as Record<string, any>);
  const product = new Product(safeData);
  const saved = await product.save();
  await invalidateListCache();
  return saved;
}

export async function findAllProducts(options: FindAllOptions = {}): Promise<PaginatedResult> {
  // Sanitiza paginacao: pagina minima 1, limite entre 1 e MAX_LIMIT
  const page = Math.max(1, options.page || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, options.limit || DEFAULT_LIMIT));
  const skip = (page - 1) * limit;

  // Le a versao atual e a inclui na chave. Hash dos parametros para limitar
  // o tamanho/cardinalidade da chave (search/category sao limitados no controller,
  // mas o hash garante chave de tamanho fixo).
  const version = await getCacheVersion();
  const rawParams = `p=${page}:l=${limit}:c=${options.category || ''}:s=${options.search || ''}`;
  const paramHash = crypto.createHash('sha1').update(rawParams).digest('hex');
  const cacheKey = `${LIST_CACHE_PREFIX}v${version}:${paramHash}`;

  // 1. Tenta servir do cache (cache HIT). getRedisClient dentro do try para
  // que erro de criacao do cliente tambem caia na degradacao graciosa.
  try {
    const redis = getRedisClient();
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as PaginatedResult;
    }
  } catch (err) {
    console.warn('[cache] leitura falhou, indo ao banco');
  }

  // 2. Cache MISS: monta o filtro e busca no banco
  const filter: Record<string, any> = { active: true };
  if (options.category) {
    filter.category = options.category;
  }
  if (options.search) {
    filter.$text = { $search: options.search };
  }

  const [data, total] = await Promise.all([
    Product.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Product.countDocuments(filter),
  ]);

  const result: PaginatedResult = {
    data,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };

  // 3. Guarda no cache para as proximas requisicoes, com expiracao (TTL)
  try {
    const redis = getRedisClient();
    await redis.set(cacheKey, JSON.stringify(result), 'EX', LIST_CACHE_TTL);
  } catch (err) {
    console.warn('[cache] escrita falhou');
  }

  return result;
}

export async function findProductById(id: string) {
  const product = await Product.findOne({ _id: id, active: true });
  if (!product) {
    return null;
  }

  // Consulta o inventory-service para enriquecer com disponibilidade.
  // Se o estoque nao responder, availability vem null e o produto
  // ainda e retornado (degradacao graciosa).
  const availability = await fetchAvailability(String(product._id));

  // Expoe apenas o minimo necessario ao cliente: se ha estoque e quantos
  // restam. quantity total e reserved sao dados operacionais internos.
  return {
    ...product.toObject(),
    availability: availability
      ? {
          available: availability.available,
          inStock: availability.available > 0,
        }
      : null,
  };
}

export async function updateProduct(id: string, data: Partial<IProduct>): Promise<IProduct | null> {
  const safeData = pickAllowedFields(data as Record<string, any>);
  const updated = await Product.findOneAndUpdate(
    { _id: id, active: true },
    safeData,
    { new: true, runValidators: true }
  );
  // So invalida se algo mudou de fato (evita churn de cache em no-op)
  if (updated) {
    await invalidateListCache();
  }
  return updated;
}

export async function deleteProduct(id: string): Promise<IProduct | null> {
  const deleted = await Product.findOneAndUpdate(
    { _id: id, active: true },
    { active: false },
    { new: true }
  );
  if (deleted) {
    await invalidateListCache();
  }
  return deleted;
}
