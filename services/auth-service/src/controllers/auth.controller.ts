import { Request, Response } from 'express';
import { registerUser, loginUser } from '../services/auth.service';

export async function register(req: Request, res: Response): Promise<void> {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      res.status(400).json({ error: 'email, password e name sao obrigatorios' });
      return;
    }

    const user = await registerUser(email, password, name);
    res.status(201).json(user);
  } catch (error: any) {
    if (error.message === 'EMAIL_ALREADY_EXISTS') {
      res.status(409).json({ error: 'E-mail ja cadastrado' });
      return;
    }
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
}

export async function login(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'email e password sao obrigatorios' });
      return;
    }

    const user = await loginUser(email, password);
    res.status(200).json(user);
  } catch (error: any) {
    if (error.message === 'INVALID_CREDENTIALS') {
      res.status(401).json({ error: 'Credenciais invalidas' });
      return;
    }
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
}
