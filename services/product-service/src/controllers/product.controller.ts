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

const MAX_PAGE = 10000;
const MAX_SEARCH_LENGTH = 100;

// Valida um inteiro positivo. Retorna o numero ou uma string de erro.
function parsePositiveInt(raw: string, fieldName: string, max: number): number | { error: string } {
  // Rejeita decimais, letras, negativos: so aceita digitos
  if (!/^[0-9]+$/.test(raw)) {
    return { error: `${fieldName} deve ser um inteiro positivo` };
  }
  const value = parseInt(raw, 10);
  if (value < 1) {
    return { error: `${fieldName} deve ser maior ou igual a 1` };
  }
  if (value > max) {
    return { error: `${fieldName} excede o maximo permitido (${max})` };
  }
  return value;
}

export async function findAll(req: Request, res: Response): Promise<void> {
  try {
    let page: number | undefined;
    let limit: number | undefined;
    let search: string | undefined;
    let category: string | undefined;

    // Valida page
    if (req.query.page !== undefined) {
      const result = parsePositiveInt(String(req.query.page), 'page', MAX_PAGE);
      if (typeof result === 'object') {
        res.status(400).json({ error: result.error });
        return;
      }
      page = result;
    }

    // Valida limit
    if (req.query.limit !== undefined) {
      const result = parsePositiveInt(String(req.query.limit), 'limit', 50);
      if (typeof result === 'object') {
        res.status(400).json({ error: result.error });
        return;
      }
      limit = result;
    }

    // Valida search: trim, nao vazio, max 100 chars
    if (req.query.search !== undefined) {
      const trimmed = String(req.query.search).trim();
      if (trimmed.length === 0) {
        res.status(400).json({ error: 'search nao pode ser vazio' });
        return;
      }
      if (trimmed.length > MAX_SEARCH_LENGTH) {
        res.status(400).json({ error: `search excede ${MAX_SEARCH_LENGTH} caracteres` });
        return;
      }
      search = trimmed;
    }

    // Valida category: trim, nao vazio
    if (req.query.category !== undefined) {
      const trimmed = String(req.query.category).trim();
      if (trimmed.length === 0) {
        res.status(400).json({ error: 'category nao pode ser vazio' });
        return;
      }
      category = trimmed;
    }

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
