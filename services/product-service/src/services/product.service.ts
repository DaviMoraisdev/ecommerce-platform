import { Product, IProduct } from '../models/product.model';

// Campos que o cliente pode definir/alterar. Protege active, _id, timestamps.
const ALLOWED_FIELDS = ['name', 'description', 'price', 'category', 'imageUrl'];

function pickAllowedFields(data: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const field of ALLOWED_FIELDS) {
    if (data[field] !== undefined) {
      result[field] = data[field];
    }
  }
  return result;
}

export async function createProduct(data: Partial<IProduct>): Promise<IProduct> {
  const safeData = pickAllowedFields(data as Record<string, any>);
  const product = new Product(safeData);
  return await product.save();
}

export async function findAllProducts(): Promise<IProduct[]> {
  return await Product.find({ active: true }).sort({ createdAt: -1 });
}

export async function findProductById(id: string): Promise<IProduct | null> {
  // So retorna produtos ativos, mesmo no acesso direto por ID
  return await Product.findOne({ _id: id, active: true });
}

export async function updateProduct(id: string, data: Partial<IProduct>): Promise<IProduct | null> {
  const safeData = pickAllowedFields(data as Record<string, any>);
  // runValidators garante que o min:0 do preco seja respeitado no update
  // O filtro active:true impede atualizar produto ja removido
  return await Product.findOneAndUpdate(
    { _id: id, active: true },
    safeData,
    { new: true, runValidators: true }
  );
}

export async function deleteProduct(id: string): Promise<IProduct | null> {
  // Soft delete: so age sobre produto ativo
  return await Product.findOneAndUpdate(
    { _id: id, active: true },
    { active: false },
    { new: true }
  );
}
