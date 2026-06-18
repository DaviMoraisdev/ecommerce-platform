import { Product, IProduct } from '../models/product.model';
import { fetchAvailability } from './inventory.client';

const ALLOWED_FIELDS = ['name', 'description', 'price', 'category', 'imageUrl'];
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
  return await product.save();
}

export async function findAllProducts(options: FindAllOptions = {}): Promise<PaginatedResult> {
  // Sanitiza paginacao: pagina minima 1, limite entre 1 e MAX_LIMIT
  const page = Math.max(1, options.page || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, options.limit || DEFAULT_LIMIT));
  const skip = (page - 1) * limit;

  // Monta o filtro base: apenas produtos ativos
  const filter: Record<string, any> = { active: true };

  // Filtro por categoria, se fornecido
  if (options.category) {
    filter.category = options.category;
  }

  // Busca por texto, se fornecida
  if (options.search) {
    filter.$text = { $search: options.search };
  }

  // Executa a query paginada e a contagem total em paralelo
  const [data, total] = await Promise.all([
    Product.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Product.countDocuments(filter),
  ]);

  return {
    data,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
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

  return {
    ...product.toObject(),
    availability: availability
      ? {
          quantity: availability.quantity,
          reserved: availability.reserved,
          available: availability.available,
        }
      : null,
  };
}

export async function updateProduct(id: string, data: Partial<IProduct>): Promise<IProduct | null> {
  const safeData = pickAllowedFields(data as Record<string, any>);
  return await Product.findOneAndUpdate(
    { _id: id, active: true },
    safeData,
    { new: true, runValidators: true }
  );
}

export async function deleteProduct(id: string): Promise<IProduct | null> {
  return await Product.findOneAndUpdate(
    { _id: id, active: true },
    { active: false },
    { new: true }
  );
}
