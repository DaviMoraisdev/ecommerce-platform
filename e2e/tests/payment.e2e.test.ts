import {
  mintToken, key, seedProduct, cleanupProduct, setStock, getStock,
  addToCart, createOrder, createPayment, getOrderStatus, waitForOrderStatus, waitUntil,
  signWebhook, postWebhook, fakeWebhookBody, request, health, paymentUrl,
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
  h.payment = (await request('GET', paymentUrl() + '/health')).status;
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
    // mas o caso termina assim que AS DUAS condicoes valerem.
    //
    // Pedido e estoque vivem em servicos diferentes: esperar so o status e ler
    // o estoque uma vez tornava o caso intermitente se a liberacao ficasse
    // visivel depois da transicao (achado 4.2 do review do PR #69). A espera
    // conjunta tambem faz a mensagem de falha mostrar os dois lados.
    const estado = await waitUntil(
      async () => ({
        status: await getOrderStatus(token, orderId),
        reserved: (await getStock(productId)).reserved,
      }),
      (e) => e.status === 'CANCELADO' && e.reserved === 0,
      PAYMENT_WINDOW_MS + 60_000,
      1_000,
    );
    expect(estado).toEqual({ status: 'CANCELADO', reserved: 0 });
  }, 150_000);
});

describe('e2e - webhook do provedor (rota real, sem broker)', () => {
  it('P3: assinatura invalida e recusada com 401', async () => {
    // O que este caso prova: a rota recusa bytes nao autenticados. Que NADA e
    // gravado no inbox antes da autenticacao esta provado contra Postgres na
    // integracao do payment (Bloco 4) — aqui nao ha como observar persistencia
    // sem trazer um cliente de banco para a suite, e um nome que afirmasse isso
    // seria mais forte que a assercao (achado 3 do review do PR #69).
    const forjado = signWebhook(fakeWebhookBody(), { secret: 'segredo-errado-' + key() });
    const r = await postWebhook(forjado);
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ code: 'ASSINATURA_INVALIDA' });
  });

  it('P4: evento autentico para cobranca DESCONHECIDA -> 503 retentavel', async () => {
    // O que este caso prova: o contrato HTTP do write-ahead (Bloco 4) —
    // providerRef desconhecido nao e erro terminal, e o provedor deve
    // reentregar. Que a linha nasce no inbox e provado na integracao; daqui so
    // se observa o codigo de resposta (achado 6.1 do review do PR #69).
    const r = await postWebhook(signWebhook(fakeWebhookBody()));
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: 'EVENTO_AINDA_NAO_APLICAVEL' });
  });

  it('P5: assinatura valida FORA da janela de tolerancia -> 401', async () => {
    // Discrimina em par com o P4: MESMO corpo, MESMA assinatura valida — muda
    // so o timestamp. Com o atual, 503 (P4); com 600 s de idade, 401. Como a
    // assinatura confere, a unica recusa possivel e a verificacao de frescor
    // (tolerancia de 300 s no provedor). Substitui o caso anterior, que enviava
    // webhook forjado para uma cobranca inexistente e afirmava que um pedido
    // pago nao mudava: a rejeicao vinha da assinatura, entao o vinculo com o
    // pedido nunca era exercitado (achado 6.2 do review do PR #69).
    const velho = signWebhook(fakeWebhookBody(), {
      timestampSeconds: Math.floor(Date.now() / 1000) - 600,
    });
    const r = await postWebhook(velho);
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ code: 'ASSINATURA_INVALIDA' });
  });
});
