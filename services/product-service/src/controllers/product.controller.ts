import { Request, Response } from 'express';
import * as productService from '../services/product.service';

function handleError(error: any, res: Response): void {
  // Erro de validacao do Mongoose (ex: preco negativo) -> 400
  if (error.name === 'ValidationError') {
    res.status(400).json({ error: 'Dados invalidos', details: error.message });
    return;
  }
  // ID malformado -> 400
  if (error.name === 'CastError') {
    res.status(400).json({ error: 'ID invalido' });
    return;
  }
  res.status(500).json({ error: 'Erro interno do servidor' });
}

export async function create(req: Request, res: Response): Promise<void> {
  try {
    const { name, description, price, category } = req.body;
    if (!name || !description || price === undefined || !category) {
      res.status(400).json({ error: 'name, description, price e category sao obrigatorios' });
      return;
    }
    const product = await productService.createProduct(req.body);
    res.status(201).json(product);
  } catch (error: any) {
    handleError(error, res);
  }
}

export async function findAll(req: Request, res: Response): Promise<void> {
  try {
    const page = req.query.page ? parseInt(String(req.query.page), 10) : undefined;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;
    const category = req.query.category ? String(req.query.category) : undefined;

    const result = await productService.findAllProducts({ page, limit, search, category });
    res.status(200).json(result);
  } catch (error: any) {
    handleError(error, res);
  }
}

export async function findOne(req: Request, res: Response): Promise<void> {
  try {
    const id = String(req.params.id);
    const product = await productService.findProductById(id);
    if (!product) {
      res.status(404).json({ error: 'Produto nao encontrado' });
      return;
    }
    res.status(200).json(product);
  } catch (error: any) {
    handleError(error, res);
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  try {
    const id = String(req.params.id);
    const product = await productService.updateProduct(id, req.body);
    if (!product) {
      res.status(404).json({ error: 'Produto nao encontrado' });
      return;
    }
    res.status(200).json(product);
  } catch (error: any) {
    handleError(error, res);
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  try {
    const id = String(req.params.id);
    const product = await productService.deleteProduct(id);
    if (!product) {
      res.status(404).json({ error: 'Produto nao encontrado' });
      return;
    }
    res.status(200).json({ message: 'Produto removido com sucesso' });
  } catch (error: any) {
    handleError(error, res);
  }
}
