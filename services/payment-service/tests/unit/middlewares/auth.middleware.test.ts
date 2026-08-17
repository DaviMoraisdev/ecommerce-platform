import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';

import { criarAuthMiddleware } from '../../../src/middlewares/auth.middleware';
import { SEGREDO_JWT } from '../../helpers/config';

interface ResDeTeste {
  status(codigo: number): ResDeTeste;
  json(corpo: unknown): ResDeTeste;
}

/**
 * Duble minimo de Response: so status() e json(), encadeaveis.
 *
 * Testar o middleware direto (sem supertest) isola o que esta sob teste — uma
 * falha aqui nao pode ser confundida com problema de rota ou de app.
 */
function resDeTeste() {
  const estado: { status: number; body: unknown } = { status: 0, body: undefined };
  const res: ResDeTeste = {
    status(codigo) {
      estado.status = codigo;
      return res;
    },
    json(corpo) {
      estado.body = corpo;
      return res;
    },
  };
  return { res: res as unknown as Response, estado };
}

function executar(authorization?: string) {
  const req = { headers: authorization ? { authorization } : {} } as Request;
  const { res, estado } = resDeTeste();
  const next = jest.fn();
  criarAuthMiddleware(SEGREDO_JWT)(req, res, next);
  return { req, estado, next };
}

describe('authMiddleware — cabecalho ausente ou malformado', () => {
  it.each([
    ['sem cabecalho', undefined],
    ['esquema errado', 'Basic YWJjOjEyMw=='],
    ['sem o espaco depois de Bearer', 'Bearertoken'],
    ['Bearer minusculo', 'bearer abc.def.ghi'],
    ['Bearer com token vazio', 'Bearer    '],
  ])('responde 401 e NAO chama next: %s', (_rotulo, cabecalho) => {
    const { estado, next } = executar(cabecalho);

    expect(estado.status).toBe(401);
    expect(estado.body).toEqual({ code: 'NAO_AUTORIZADO', error: 'Token nao fornecido' });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('authMiddleware — token invalido', () => {
  it('rejeita token assinado com outro segredo', () => {
    const token = jwt.sign({ id: 'usr_1' }, 'outro_segredo_completamente_diferente_123456');
    const { estado, next } = executar(`Bearer ${token}`);

    expect(estado.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejeita token que declara algoritmo diferente de HS256 (confusao de algoritmo)', () => {
    // Assinado com o segredo CORRETO, mas HS512. Sem a opcao algorithms, este
    // token passaria — e um atacante escolheria o algoritmo da verificacao.
    const token = jwt.sign({ id: 'usr_1' }, SEGREDO_JWT, { algorithm: 'HS512' });
    const { estado, next } = executar(`Bearer ${token}`);

    expect(estado.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejeita token expirado', () => {
    const token = jwt.sign({ id: 'usr_1' }, SEGREDO_JWT, { expiresIn: '-1s' });
    const { estado, next } = executar(`Bearer ${token}`);

    expect(estado.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('responde IDENTICO para expirado e para assinatura invalida', () => {
    const expirado = jwt.sign({ id: 'usr_1' }, SEGREDO_JWT, { expiresIn: '-1s' });
    const assinaturaRuim = jwt.sign({ id: 'usr_1' }, 'outro_segredo_bem_diferente_1234567890');

    const a = executar(`Bearer ${expirado}`);
    const b = executar(`Bearer ${assinaturaRuim}`);

    // Distinguir os dois casos diz ao atacante QUAL parte do token esta errada:
    // "expirado" confirma que a assinatura estava certa, ou seja, que o segredo
    // usado para forjar acertou. A resposta tem que ser indistinguivel.
    expect(a.estado.status).toBe(b.estado.status);
    expect(a.estado.body).toEqual(b.estado.body);
  });
});

describe('authMiddleware — claims invalidas', () => {
  it.each([
    ['payload string em vez de objeto', jwt.sign('apenas_texto', SEGREDO_JWT)],
    ['sem id', jwt.sign({ role: 'USER' }, SEGREDO_JWT)],
    ['id numerico', jwt.sign({ id: 42 }, SEGREDO_JWT)],
    ['id string vazia', jwt.sign({ id: '' }, SEGREDO_JWT)],
    ['id so com espacos', jwt.sign({ id: '   ' }, SEGREDO_JWT)],
    ['role numerico', jwt.sign({ id: 'usr_1', role: 7 }, SEGREDO_JWT)],
  ])('responde 401 quando %s', (_rotulo, token) => {
    const { estado, next } = executar(`Bearer ${token}`);

    expect(estado.status).toBe(401);
    expect(estado.body).toEqual({
      code: 'NAO_AUTORIZADO',
      error: 'Token sem claims obrigatorias',
    });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('authMiddleware — token valido', () => {
  it('chama next e popula userId e userRole', () => {
    const token = jwt.sign({ id: 'usr_42', role: 'ADMIN' }, SEGREDO_JWT);
    const { req, estado, next } = executar(`Bearer ${token}`);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(req.userId).toBe('usr_42');
    expect(req.userRole).toBe('ADMIN');
    expect(estado.status).toBe(0);
  });

  it('aceita token sem role e deixa userRole undefined', () => {
    const token = jwt.sign({ id: 'usr_42' }, SEGREDO_JWT);
    const { req, next } = executar(`Bearer ${token}`);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.userId).toBe('usr_42');
    expect(req.userRole).toBeUndefined();
  });

  it('tolera espaco em volta do token no cabecalho', () => {
    const token = jwt.sign({ id: 'usr_42' }, SEGREDO_JWT);
    const { req, next } = executar(`Bearer   ${token}   `);

    // Aqui APARAR e correto: o valor apos "Bearer " nao e identificador de
    // negocio, e o RFC 6750 trata o espaco como separador. Diferente do
    // Idempotency-Key, onde o espaco muda a identidade da requisicao.
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.userId).toBe('usr_42');
  });
});
