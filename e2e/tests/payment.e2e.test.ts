import {
  mintToken, key, seedProduct, cleanupProduct, setStock, getStock,
  addToCart, createOrder, createPayment, getOrder, waitForOrderStatus,
  signWebhook, postWebhook, fakeWebhookBody, request, health, PAYMENT_URL,
} from '../src/helpers';

/**
 * Bloco 8f — pagamentos ponta a ponta (Fase 5).
 *
 * O que SO esta suite prova: a costura entre processos atravessando o RabbitMQ
 * real — payment.captured e payment.expired saindo da outbox do payment e
 * chegando ao consumidor do order. Nenhuma suite de integracao toca o broker.
 *
 * O que fica de fora, de proposito: webhook duplicado, fora de ordem e valor
 * divergente. Estao provados contra Postgres na integracao do payment (CASOS
 * 22/23/44 e coerencia de valor); aqui nao ha como fabricar o webhook da
 * cobranca certa (a resposta do POST /payments nao expoe providerRef) e o 200
 * da rota nao distingue aplicado de duplicata — o caso passaria com o mecanismo
 * removido.
 *
 * Pre-requisitos (README): payment-service em 3007 com PAYMENT_PROVIDER=fake,
 * PAYMENT_EXPIRATION_ENABLED=true e janela minima; order-service com
 * PAYMENTS_CONSUMER_ENABLED=true.
 */

const TOK_SUCCESS = 'tok_fake_success';
const TOK_PROCESSING = 'tok_fake_processing';
const PAYMENT_WINDOW_MS = 60_000; // PAYMENT_WINDOW_MINUTES=1 no .env do payment (minimo aceito)

const admin = mintToken('admin-' + key(), 'ADMIN');
const created: string[] = [];

async function newProduct(price: number, stock: number): Promise<string> {
  const id = await seedProduct(admin, price);
  created.push(id);
  await setStock(admin, id, stock);
  return id;
}

async function pedidoPendente(token: string, productId: string): Promise<string> {
  expect((await addToCart(token, productId, 1)).status).toBe(200);
  const order = await createOrder(token, key('idem'));
  expect(order.status).toBe(201);
  return order.body.id as string;
}

beforeAll(async () => {
  const h = await health();
  h.payment = (await request('GET', PAYMENT_URL + '/health')).status;
  const down = Object.entries(h).filter(([, s]) => s !== 200);
  if (down.length) throw new Error('stack incompleto: ' + JSON.stringify(h));
});

afterAll(async () => {
  for (const id of created) await cleanupProduct(admin, id).catch(() => undefined);
});

describe('e2e - pagamento ponta a ponta (payment -> broker -> order)', () => {
  it('P1: pagamento capturado leva o pedido a PAGO e mantem a reserva', async () => {
    const token = mintToken('u-' + key(), 'USER');
    const productId = await newProduct(50, 3);
    const orderId = await pedidoPendente(token, productId);

    const pago = await createPayment(token, orderId, TOK_SUCCESS, key('pay'));
    expect(pago.status).toBe(201);
    expect(pago.body).toMatchObject({ orderId, status: 'CAPTURED' });

    // outbox -> relay -> RabbitMQ -> consumidor do order. Polling, nao sleep.
    expect(await waitForOrderStatus(token, orderId, 'PAGO', 15_000)).toBe('PAGO');
    expect((await getStock(productId)).reserved).toBe(1);
  }, 30_000);

  it('P2: pagamento sem confirmacao expira e a compensacao cancela o pedido e libera o estoque', async () => {
    const token = mintToken('u-' + key(), 'USER');
    const productId = await newProduct(50, 3);
    const orderId = await pedidoPendente(token, productId);
    expect((await getStock(productId)).reserved).toBe(1);

    // Aceito pelo provedor, confirmacao NUNCA chega: fica PROCESSING ate a janela.
    const aceito = await createPayment(token, orderId, TOK_PROCESSING, key('pay'));
    expect([201, 202]).toContain(aceito.status);
    expect(aceito.body).toMatchObject({ orderId, status: 'PROCESSING' });

    // Janela (1 min) + poll da varredura + relay + consumidor. Teto generoso,
    // mas o caso termina assim que o status chegar.
    const status = await waitForOrderStatus(token, orderId, 'CANCELADO', PAYMENT_WINDOW_MS + 60_000, 1_000);
    expect(status).toBe('CANCELADO');
    expect((await getStock(productId)).reserved).toBe(0);
  }, 150_000);
});

describe('e2e - webhook do provedor (rota real, sem broker)', () => {
  it('P3: assinatura invalida -> 401 e nada e gravado', async () => {
    const forjado = signWebhook(fakeWebhookBody(), { secret: 'segredo-errado-' + key() });
    const r = await postWebhook(forjado);
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ code: 'ASSINATURA_INVALIDA' });
  });

  it('P4: evento autentico para cobranca DESCONHECIDA -> 503 retentavel', async () => {
    // Contrato do write-ahead (Bloco 4): providerRef desconhecido nao e erro
    // terminal; a linha nasce no inbox e o provedor deve reentregar.
    const r = await postWebhook(signWebhook(fakeWebhookBody()));
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: 'EVENTO_AINDA_NAO_APLICAVEL' });
  });

  it('P5: um pedido PAGO nao e alterado por webhook forjado', async () => {
    const token = mintToken('u-' + key(), 'USER');
    const productId = await newProduct(50, 3);
    const orderId = await pedidoPendente(token, productId);
    expect((await createPayment(token, orderId, TOK_SUCCESS, key('pay'))).status).toBe(201);
    expect(await waitForOrderStatus(token, orderId, 'PAGO', 15_000)).toBe('PAGO');

    const forjado = signWebhook(fakeWebhookBody({ type: 'payment.canceled' }), { secret: 'x' + key() });
    expect((await postWebhook(forjado)).status).toBe(401);
    expect((await getOrder(token, orderId)).body.status).toBe('PAGO');
  }, 30_000);
});
