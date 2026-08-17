import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';

interface ClaimsEsperadas {
  id: string;
  role?: string;
}

/**
 * Valida o shape minimo antes de confiar em qualquer claim.
 *
 * Sem isto, um token valido mas com payload inesperado entregaria
 * `userId === undefined` adiante, e o servico criaria pagamento sem dono.
 */
function claimsValidas(payload: unknown): payload is ClaimsEsperadas {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as { id?: unknown; role?: unknown };
  if (typeof p.id !== 'string' || p.id.trim() === '') return false;
  if (p.role !== undefined && typeof p.role !== 'string') return false;
  return true;
}

/**
 * Fabrica o middleware com o segredo JA VALIDADO pelo loadConfig, em vez de ler
 * `process.env.JWT_SECRET as string` no meio da requisicao (padrao dos outros
 * servicos). Assim o segredo passou pelas checagens de placeholder e tamanho, e
 * o middleware fica testavel sem tocar no ambiente.
 */
export function criarAuthMiddleware(jwtSecret: string): RequestHandler {
  return function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    const cabecalho = req.headers.authorization;

    if (!cabecalho || !cabecalho.startsWith('Bearer ')) {
      res.status(401).json({ code: 'NAO_AUTORIZADO', error: 'Token nao fornecido' });
      return;
    }

    const token = cabecalho.slice('Bearer '.length).trim();
    if (token === '') {
      res.status(401).json({ code: 'NAO_AUTORIZADO', error: 'Token nao fornecido' });
      return;
    }

    let payload: unknown;
    try {
      // algorithms explicito: sem isto, um token que declara outro `alg` pode
      // ser aceito dependendo da versao da biblioteca — confusao de algoritmo.
      // O TECH_DEBT pede isto para todos os servicos (Fase 7); aqui ja nasce.
      payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
    } catch {
      // Mensagem generica: nao distinguimos expirado de assinatura invalida, para
      // nao dar ao atacante sinal sobre qual parte do token esta errada.
      res.status(401).json({ code: 'NAO_AUTORIZADO', error: 'Token invalido ou expirado' });
      return;
    }

    if (!claimsValidas(payload)) {
      res.status(401).json({ code: 'NAO_AUTORIZADO', error: 'Token sem claims obrigatorias' });
      return;
    }

    req.userId = payload.id;
    req.userRole = payload.role;
    next();
  };
}
