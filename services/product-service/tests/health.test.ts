import request from 'supertest';
import app from '../src/app';

// O /health foi extraido para app.ts na refatoracao de testabilidade.
// Este teste prova que a rota responde — usada por health probes de
// orquestracao e monitoramento. Nao depende de banco nem de servicos externos.
describe('GET /health', () => {
  it('responde 200 com status ok e nome do servico', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('product-service');
    expect(res.body).toHaveProperty('timestamp');
  });
});
