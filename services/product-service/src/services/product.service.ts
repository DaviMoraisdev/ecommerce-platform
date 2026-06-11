import { Product, IProduct } from '../models/product.model';

export async function createProduct(data: Partial<IProduct>): Promise<IProduct> {
  const product = new Product(data);
  return await product.save();
}

export async function findAllProducts(): Promise<IProduct[]> {
  return await Product.find({ active: true }).sort({ createdAt: -1 });
}

export async function findProductById(id: string): Promise<IProduct | null> {
  return await Product.findById(id);
}

export async function updateProduct(id: string, data: Partial<IProduct>): Promise<IProduct | null> {
  return await Product.findByIdAndUpdate(id, data, { new: true });
}

export async function deleteProduct(id: string): Promise<IProduct | null> {
  // Soft delete: marca como inativo em vez de remover
  return await Product.findByIdAndUpdate(id, { active: false }, { new: true });
}
