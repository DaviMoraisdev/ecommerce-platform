import {Request, Response } from 'express';
import { registerUser, loginUser, refreshAccessToken, getUserById } from '../services/auth.service';

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
      res.status(400).json({ error: 'email e password sao obrigatorios'})
      return;
    }

    const result = await loginUser (email, password);
    res.status(200).json(result);
  } catch (error: any) {
    if (error.message === 'INVALID_CREDENTIALS') {
      res.status(401).json({ error: 'Credentials invalidas' });
      return;
    }
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
}
export async function me(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).userId;
    const user = await getUserById(userId);
    res.status(200).json(user);
  } catch (error: any){
    res.status(404).json({ error: 'Usuario nao encontrado'});
    return;
  }
  res.status(500).json({ error: 'Erro interno do servidor'});
  }
  
export async function refresh(req: Request, res: Response): Promise<void> {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      res.status(400).json({ error: 'refreshToken e obrigatorio' });
      return;
    }

    const result = await refreshAccessToken(refreshToken);
    res.status(200).json(result);
  } catch (error: any) {
    if (error.message === 'INVALID_REFRESH_TOKEN') {
      res.status(401).json({ error: 'Refresh token invalido ou expirado' });
      return;
    }
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
}