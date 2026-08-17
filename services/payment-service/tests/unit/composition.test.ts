import jwt from 'jsonwebtoken';
import request from 'supertest';

import { configDeTeste, SEGREDO_JWT } from '../helpers/config';

// getPrisma() exige connectDatabase previo — o bootstrap garante essa ordem em
// producao. Aqui o cliente e substituido porque o alvo do teste e a FIACAO,
// nao o banco.
jest.mock('../../src/config/database', () => ({
  getPrisma: jest.fn(() => ({})),
}));

import { construirApp } from '../../src/composition';

describe('construirApp — fiacao de producao', () => {
  it('expoe /health sem exigir autenticacao', async () => {
    const resposta = await request(construirApp(configDeTeste())).get('/health');
    expect(resposta.status).toBe(200);
  });

  it('protege POST /payments com o middleware de autenticacao REAL', async () => {
    // O que SO este teste pega: que o middleware montado e o REAL, construido
    // com o segredo que veio na config. Remover o router.use() quebra tambem os
    // testes de duble (verificado: 26 falhas) — mas trocar criarAuthMiddleware
    // por um duble permissivo, ou passar o segredo errado, passaria por todos
    // eles. Ver o teste do segredo abaixo.
    const resposta = await request(construirApp(configDeTeste()))
      .post('/payments')
      .send({ orderId: 'ord_1', paymentMethodToken: 'tok_visa' });

    expect(resposta.status).toBe(401);
    expect(resposta.body).toEqual({ code: 'NAO_AUTORIZADO', error: 'Token nao fornecido' });
  });

  it('rejeita token assinado com segredo diferente do que veio na config', async () => {
    const token = jwt.sign({ id: 'usr_1' }, 'segredo_que_nao_e_o_da_config_1234567890');

    const resposta = await request(construirApp(configDeTeste()))
      .post('/payments')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderId: 'ord_1', paymentMethodToken: 'tok_visa' });

    expect(resposta.status).toBe(401);
  });

  it('alcanca o controller REAL depois de autenticar, e ele valida a entrada', async () => {
    const token = jwt.sign({ id: 'usr_1' }, SEGREDO_JWT);

    // Sem Idempotency-Key: se a resposta for 400, o middleware liberou e o
    // controller real assumiu. Prova a ordem auth -> controller sem tocar no
    // banco nem no provedor.
    const resposta = await request(construirApp(configDeTeste()))
      .post('/payments')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderId: 'ord_1', paymentMethodToken: 'tok_visa' });

    expect(resposta.status).toBe(400);
    expect(resposta.body.code).toBe('REQUISICAO_INVALIDA');
  });

  it('falha na composicao quando o provedor configurado nao tem adapter', () => {
    // A config valida a INTENCAO (o valor stripe e aceito); a factory valida a
    // CAPACIDADE. O erro tem que aparecer no boot, nao na primeira cobranca.
    expect(() => construirApp(configDeTeste({ provider: 'stripe' }))).toThrow(/Bloco 9/);
  });
});
