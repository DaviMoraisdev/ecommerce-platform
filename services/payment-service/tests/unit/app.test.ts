import request from 'supertest';
import { createApp } from '../../src/app';

describe('GET /health', () => {
  it('responde 200 com a identificacao do servico', async () => {
    const resposta = await request(createApp()).get('/health');

    expect(resposta.status).toBe(200);
    expect(resposta.body).toEqual({ status: 'ok', service: 'payment-service' });
  });

  it('aplica os cabecalhos de seguranca do helmet', async () => {
    const resposta = await request(createApp()).get('/health');

    expect(resposta.headers['x-content-type-options']).toBe('nosniff');
    expect(resposta.headers['x-powered-by']).toBeUndefined();
  });

  it('responde 404 para rota inexistente', async () => {
    const resposta = await request(createApp()).get('/rota-que-nao-existe');
    expect(resposta.status).toBe(404);
  });
});
