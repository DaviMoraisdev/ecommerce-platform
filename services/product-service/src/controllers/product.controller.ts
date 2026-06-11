import { Request, Response } from 'express';
import * as productService from '../services/product.service';

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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
}

export async function findAll(req: Request, res: Response): Promise<void> {
  try {
    const products = await productService.findAllProducts();
    res.status(200).json(products);
  } catch (error: any) {
    res.status(500).json({ error: 'Erro interno do servidor' });
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
    res.status(500).json({ error: 'Erro interno do servidor' });
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
    res.status(500).json({ error: 'Erro interno do servidor' });
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
}
