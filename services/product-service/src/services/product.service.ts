import { Product, IProduct } from '../models/product.model';
import { fetchAvailability } from './inventory.client';
import { getRedisClient } from '../config/redis';

const ALLOWED_FIELDS = ['name', 'description', 'price', 'category', 'imageUrl'];

// Prefixo e TTL do cache de listagem
const LIST_CACHE_PREFIX = 'products:list:';
const LIST_CACHE_TTL = 60; // segundos

// Invalida TODO o cache de listagem. Chamada sempre que um produto muda.
// Estrategia simples e segura (Opcao B): em vez de descobrir quais paginas
// foram afetadas, limpamos todas — evita servir dado velho.
async function invalidateListCache(): Promise<void> {
  try {
    const redis = getRedisClient();
    // Busca todas as chaves do cache de listagem e as remove
    const keys = await redis.keys(`${LIST_CACHE_PREFIX}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch (err) {
    // Falha na invalidacao nao pode quebrar a operacao principal.
    // O TTL de 60s e a rede de seguranca: o cache velho expira sozinho.
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

  // Monta a chave de cache a partir dos parametros desta consulta especifica
  const cacheKey = `${LIST_CACHE_PREFIX}p=${page}:l=${limit}:c=${options.category || ''}:s=${options.search || ''}`;

  const redis = getRedisClient();

  // 1. Tenta servir do cache (cache HIT)
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as PaginatedResult;
    }
  } catch (err) {
    // Se o Redis falhar, seguimos para o banco — cache nao pode quebrar o servico
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
  await invalidateListCache();
  return updated;
}

export async function deleteProduct(id: string): Promise<IProduct | null> {
  const deleted = await Product.findOneAndUpdate(
    { _id: id, active: true },
    { active: false },
    { new: true }
  );
  await invalidateListCache();
  return deleted;
}
