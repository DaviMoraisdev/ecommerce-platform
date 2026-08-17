import express, { type Router } from 'express';
import request from 'supertest';

import { createApp, type RotasDaAplicacao } from '../../src/app';

/**
 * Duble de rota: o app so precisa saber que recebeu um Router e o montou. O
 * comportamento real de /payments e testado no teste da rota e do controller.
 */
function rotasDeTeste(overrides: Partial<RotasDaAplicacao> = {}): RotasDaAplicacao {
  const payments: Router = express.Router();
  payments.post('/', (req, res) => {
    res.status(201).json({ recebido: req.body });
  });
  return { payments, ...overrides };
}

describe('GET /health', () => {
  it('responde 200 com a identificacao do servico', async () => {
    const resposta = await request(createApp(rotasDeTeste())).get('/health');
    expect(resposta.status).toBe(200);
    expect(resposta.body).toEqual({ status: 'ok', service: 'payment-service' });
  });

  it('aplica os cabecalhos de seguranca do helmet', async () => {
    const resposta = await request(createApp(rotasDeTeste())).get('/health');
    expect(resposta.headers['x-content-type-options']).toBe('nosniff');
    expect(resposta.headers['x-powered-by']).toBeUndefined();
  });
});

describe('createApp', () => {
  it('monta o router de pagamentos em /payments', async () => {
    const resposta = await request(createApp(rotasDeTeste()))
      .post('/payments')
      .send({ orderId: 'ped_1' });

    expect(resposta.status).toBe(201);
    expect(resposta.body).toEqual({ recebido: { orderId: 'ped_1' } });
  });

  it('responde 404 com corpo estruturado para rota inexistente', async () => {
    const resposta = await request(createApp(rotasDeTeste())).get('/rota-que-nao-existe');
    expect(resposta.status).toBe(404);
    expect(resposta.body).toEqual({
      code: 'ROTA_NAO_ENCONTRADA',
      error: 'Rota nao encontrada',
    });
  });
});

describe('handler de erro', () => {
  function appQueLanca(erro: unknown) {
    const payments: Router = express.Router();
    payments.post('/', () => {
      throw erro;
    });
    return createApp({ payments });
  }

  it('responde 500 generico e NAO vaza a mensagem interna', async () => {
    const erro = new Error('relation "payments" does not exist at character 42');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const resposta = await request(appQueLanca(erro)).post('/payments').send({});

    expect(resposta.status).toBe(500);
    expect(resposta.body).toEqual({ code: 'ERRO_INTERNO', error: 'Erro interno' });
    // A mensagem nao pode aparecer em NENHUMA parte da resposta.
    expect(JSON.stringify(resposta.body)).not.toContain('relation');
    expect(resposta.text).not.toContain('does not exist');
    // Mas TEM que chegar ao log do servidor, senao o erro fica invisivel.
    expect(spy).toHaveBeenCalledWith(expect.any(String), erro.message);
    spy.mockRestore();
  });

  it('preserva o status de erro que ja e do cliente em vez de virar 500', async () => {
    const erroComStatus = Object.assign(new Error('bad request'), { status: 422 });

    const resposta = await request(appQueLanca(erroComStatus)).post('/payments').send({});

    expect(resposta.status).toBe(422);
    expect(resposta.body.code).toBe('REQUISICAO_INVALIDA');
  });

  it('trata status 5xx anexado ao erro como falha do servidor, nao do cliente', async () => {
    const erroComStatus = Object.assign(new Error('gateway'), { status: 502 });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const resposta = await request(appQueLanca(erroComStatus)).post('/payments').send({});

    expect(resposta.status).toBe(500);
    spy.mockRestore();
  });
});

describe('limite de corpo', () => {
  it('rejeita corpo acima de 10kb com 413, nao com 500', async () => {
    const grande = { campo: 'x'.repeat(11 * 1024) };

    const resposta = await request(createApp(rotasDeTeste()))
      .post('/payments')
      .send(grande);

    expect(resposta.status).toBe(413);
    expect(resposta.body.code).toBe('REQUISICAO_INVALIDA');
  });

  it('rejeita JSON malformado com 400, nao com 500', async () => {
    const resposta = await request(createApp(rotasDeTeste()))
      .post('/payments')
      .set('Content-Type', 'application/json')
      .send('{"orderId": ');

    expect(resposta.status).toBe(400);
    expect(resposta.body.code).toBe('REQUISICAO_INVALIDA');
  });
});
