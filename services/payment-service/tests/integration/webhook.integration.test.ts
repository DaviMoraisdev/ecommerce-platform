import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import {
  Prisma,
  PaymentStatus,
  TransactionStatus,
  TransactionType,
  WebhookStatus,
  type Payment,
  type PrismaClient,
} from '@prisma/client';
import { createApp } from '../../src/app';
import { connectDatabase, disconnectDatabase } from '../../src/config/database';
import { FakeProvider } from '../../src/providers/fake/fake.provider';
import type { WebhookRequest } from '../../src/providers/payment-provider.port';
import { criarWebhookRouter } from '../../src/routes/webhook.routes';
import { WebhookService } from '../../src/services/webhook.service';
import { SEGREDO_WEBHOOK } from '../helpers/config';
import { assertTestDatabase } from '../helpers/testDbGuard';

/**
 * SUITE ADVERSARIAL DO WEBHOOK — escrita ANTES da implementacao.
 *
 * Os defeitos do Bloco 3 apareceram nas INTERACOES, nao nos caminhos felizes.
 * Cada caso aqui e uma interacao conhecida por quebrar webhook em producao.
 *
 * As asserçoes olham o BANCO, nao o corpo da resposta: um handler pode devolver
 * 200 e nao ter aplicado nada. Estado persistido e a unica prova.
 */

const OUTRO_SEGREDO = 'outro000111122223333444455556666777788889999bbbb';
const VALOR = 12990;

let prisma: PrismaClient;

beforeAll(async () => {
  // Defesa em profundidade: ha deleteMany aqui e a config do Jest e
  // sobrescrevivel por linha de comando.
  assertTestDatabase(process.env);
  prisma = await connectDatabase(process.env.DATABASE_URL as string);
});

afterEach(async () => {
  await prisma.webhookEvent.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.paymentTransaction.deleteMany();
  await prisma.payment.deleteMany();
});

afterAll(async () => {
  await disconnectDatabase();
});

function montarApp() {
  const provider = new FakeProvider({ webhookSecret: SEGREDO_WEBHOOK });
  const service = new WebhookService({ prisma });
  const app = createApp({
    // A rota de pagamento nao participa destes testes; um Router vazio evita
    // arrastar PaymentService, orderClient e config para ca.
    payments: express.Router(),
    webhooks: criarWebhookRouter({ provider, service }),
  });
  return { app, provider };
}

/** Pagamento PROCESSING com AUTHORIZE PENDENTE: o estado real apos aceite assincrono. */
async function cenario(
  status: PaymentStatus = PaymentStatus.PROCESSING,
): Promise<{ payment: Payment; chargeRef: string }> {
  const chargeRef = `ch_${randomUUID()}`;
  const payment = await prisma.payment.create({
    data: {
      orderId: randomUUID(),
      userId: randomUUID(),
      amountCents: VALOR,
      currency: 'BRL',
      provider: 'fake',
      status,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    },
  });
  await prisma.paymentTransaction.create({
    data: {
      paymentId: payment.id,
      type: TransactionType.AUTHORIZE,
      status: TransactionStatus.PENDING,
      amountCents: VALOR,
      providerRef: chargeRef,
    },
  });
  return { payment, chargeRef };
}

function corpo(
  raiz: Record<string, unknown> = {},
  dados: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `evt_${randomUUID()}`,
    type: 'payment.succeeded',
    created_at: new Date().toISOString(),
    ...raiz,
    data: {
      charge_ref: `ch_${randomUUID()}`,
      state: 'SUCCEEDED',
      captured_amount_cents: VALOR,
      refunded_amount_cents: 0,
      decline_code: null,
      ...dados,
    },
  };
}

/**
 * Envia os BYTES EXATOS que foram assinados. Nunca passar objeto para .send():
 * superagent re-serializaria e a assinatura deixaria de bater por motivo
 * errado, escondendo o defeito que o caso 5 procura.
 */
function postar(app: express.Express, req: WebhookRequest) {
  return request(app)
    .post('/webhooks/fake')
    .set('content-type', 'application/json')
    .set(req.headers as Record<string, string>)
    .send(req.rawBody.toString('utf8'));
}

const transacoesDe = (paymentId: string) =>
  prisma.paymentTransaction.findMany({ where: { paymentId }, orderBy: { createdAt: 'asc' } });

// ==========================================================
// 1. Controle: o caminho feliz precisa funcionar
// ==========================================================
describe('webhook — caminho aplicado', () => {
  it('payment.succeeded leva a CAPTURED, fecha o AUTHORIZE e cria o CAPTURE', async () => {
    const { app, provider } = montarApp();
    const { payment, chargeRef } = await cenario();

    const res = await postar(app, provider.assinarCorpo(corpo({}, { charge_ref: chargeRef })));
    expect(res.status).toBe(200);

    const atualizado = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atualizado.status).toBe(PaymentStatus.CAPTURED);
    expect(atualizado.capturedAmountCents).toBe(VALOR);

    const trilha = await transacoesDe(payment.id);
    expect(trilha).toHaveLength(2);
    expect(trilha[0]).toMatchObject({
      type: TransactionType.AUTHORIZE,
      status: TransactionStatus.SUCCEEDED,
    });
    expect(trilha[1]).toMatchObject({
      type: TransactionType.CAPTURE,
      status: TransactionStatus.SUCCEEDED,
      amountCents: VALOR,
    });

    const inbox = await prisma.webhookEvent.findMany();
    expect(inbox).toHaveLength(1);
    expect(inbox[0].status).toBe(WebhookStatus.PROCESSED);
    expect(inbox[0].processedAt).not.toBeNull();
  });
});

// ==========================================================
// 2 e 3. Origem: so o provedor pode causar efeito
// ==========================================================
describe('webhook — autenticidade', () => {
  it('CASO 3: assinatura forjada devolve 401, NAO grava no inbox e nao altera estado', async () => {
    const { app, provider } = montarApp();
    const { payment, chargeRef } = await cenario();

    const res = await postar(
      app,
      provider.assinarCorpo(corpo({}, { charge_ref: chargeRef }), {
        assinarCom: OUTRO_SEGREDO,
      }),
    );

    expect(res.status).toBe(401);
    // Gravar antes de autenticar transformaria a rota em escrita nao
    // autenticada em banco: qualquer um encheria a tabela.
    expect(await prisma.webhookEvent.count()).toBe(0);
    const intacto = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(intacto.status).toBe(PaymentStatus.PROCESSING);
  });

  it('CASO 4: timestamp fora da janela devolve 401 e nao grava nada', async () => {
    const { app, provider } = montarApp();
    const { payment, chargeRef } = await cenario();

    const res = await postar(
      app,
      provider.assinarCorpo(corpo({}, { charge_ref: chargeRef }), {
        timestampSegundos: Math.floor(Date.now() / 1000) - 400,
      }),
    );

    expect(res.status).toBe(401);
    expect(await prisma.webhookEvent.count()).toBe(0);
    const intacto = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(intacto.status).toBe(PaymentStatus.PROCESSING);
  });

  it('CASO 5: corpo CRU chega intacto — express.json() nao alcanca a rota', async () => {
    const { app, provider } = montarApp();
    const { payment, chargeRef } = await cenario();

    // Mesmos DADOS, bytes DIFERENTES (indentado). A assinatura e sobre estes
    // bytes: um handler que re-serialize antes de verificar falha aqui.
    const cru = JSON.stringify(corpo({}, { charge_ref: chargeRef }), null, 2);
    const res = await postar(app, provider.assinarCorpo(cru));

    expect(res.status).toBe(200);
    const atualizado = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atualizado.status).toBe(PaymentStatus.CAPTURED);
  });
});

// ==========================================================
// 6 a 8. Exatamente-uma-vez
// ==========================================================
describe('webhook — idempotencia', () => {
  it('CASO 6: reentrega do MESMO evento nao duplica efeito nem linha de inbox', async () => {
    const { app, provider } = montarApp();
    const { payment, chargeRef } = await cenario();
    const req = provider.assinarCorpo(corpo({}, { charge_ref: chargeRef }));

    expect((await postar(app, req)).status).toBe(200);
    expect((await postar(app, req)).status).toBe(200);

    expect(await prisma.webhookEvent.count()).toBe(1);
    const trilha = await transacoesDe(payment.id);
    expect(trilha.filter((t) => t.type === TransactionType.CAPTURE)).toHaveLength(1);
  });

  it('CASO 7: dois eventos DISTINTOS com o mesmo estado nao criam CAPTURE duplicada', async () => {
    const { app, provider } = montarApp();
    const { payment, chargeRef } = await cenario();

    // O @@unique nao deduplica: sao providerEventId diferentes, e ambos sao
    // legitimos. A defesa e o handler curto-circuitar quando o estado alvo ja
    // e o atual — podeTransicionar(X, X) devolve true de proposito.
    await postar(app, provider.assinarCorpo(corpo({ id: 'evt_a' }, { charge_ref: chargeRef })));
    const res = await postar(
      app,
      provider.assinarCorpo(corpo({ id: 'evt_b' }, { charge_ref: chargeRef })),
    );

    expect(res.status).toBe(200);
    expect(await prisma.webhookEvent.count()).toBe(2);
    const trilha = await transacoesDe(payment.id);
    expect(trilha.filter((t) => t.type === TransactionType.CAPTURE)).toHaveLength(1);
  });

  it('CASO 8: linha RECEIVED orfa e RETOMADA, nao tratada como duplicata', async () => {
    const { app, provider } = montarApp();
    const { payment, chargeRef } = await cenario();
    const evento = corpo({}, { charge_ref: chargeRef });

    // Simula queda entre gravar o inbox e aplicar o efeito.
    await prisma.webhookEvent.create({
      data: {
        provider: 'fake',
        providerEventId: evento.id as string,
        eventType: evento.type as string,
        payload: evento as Prisma.InputJsonObject,
        providerCreatedAt: new Date(evento.created_at as string),
        status: WebhookStatus.RECEIVED,
      },
    });

    const res = await postar(app, provider.assinarCorpo(evento));

    expect(res.status).toBe(200);
    // Sem isto, uma falha transitoria prende o pagamento para sempre.
    const atualizado = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atualizado.status).toBe(PaymentStatus.CAPTURED);
    const inbox = await prisma.webhookEvent.findMany();
    expect(inbox).toHaveLength(1);
    expect(inbox[0].status).toBe(WebhookStatus.PROCESSED);
  });
});

// ==========================================================
// 9 a 12. Fail-closed: registra, recusa o efeito
// ==========================================================
describe('webhook — eventos que NAO podem alterar estado', () => {
  it('CASO 9: created_at nulo vira IGNORED e nao altera o pagamento', async () => {
    const { app, provider } = montarApp();
    const { payment, chargeRef } = await cenario();

    const res = await postar(
      app,
      provider.assinarCorpo(corpo({ created_at: null }, { charge_ref: chargeRef })),
    );

    expect(res.status).toBe(200);
    const intacto = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(intacto.status).toBe(PaymentStatus.PROCESSING);
    const inbox = await prisma.webhookEvent.findMany();
    expect(inbox[0].status).toBe(WebhookStatus.IGNORED);
    expect(inbox[0].providerCreatedAt).toBeNull();
    expect(inbox[0].lastError).toBeTruthy();
    expect(await transacoesDe(payment.id)).toHaveLength(1);
  });

  it('CASO 10: evento FORA DE ORDEM contra estado terminal vira IGNORED', async () => {
    const { app, provider } = montarApp();
    const { payment, chargeRef } = await cenario(PaymentStatus.CAPTURED);

    const res = await postar(
      app,
      provider.assinarCorpo(
        corpo({ type: 'payment.canceled' }, { charge_ref: chargeRef, state: 'CANCELED', captured_amount_cents: 0 }),
      ),
    );

    expect(res.status).toBe(200);
    const intacto = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(intacto.status).toBe(PaymentStatus.CAPTURED);
    const inbox = await prisma.webhookEvent.findMany();
    expect(inbox[0].status).toBe(WebhookStatus.IGNORED);
  });

  it('CASO 11: charge_ref desconhecido vira IGNORED sem quebrar', async () => {
    const { app, provider } = montarApp();
    const { payment } = await cenario();

    const res = await postar(app, provider.assinarCorpo(corpo()));

    expect(res.status).toBe(200);
    const intacto = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(intacto.status).toBe(PaymentStatus.PROCESSING);
    const inbox = await prisma.webhookEvent.findMany();
    expect(inbox[0].status).toBe(WebhookStatus.IGNORED);
  });

  it('CASO 12: evento de tipo nao suportado vira IGNORED preservando o tipo BRUTO', async () => {
    const { app, provider } = montarApp();

    const res = await postar(
      app,
      provider.assinarCorpo({
        id: `evt_${randomUUID()}`,
        type: 'customer.updated',
        created_at: new Date().toISOString(),
      }),
    );

    expect(res.status).toBe(200);
    const inbox = await prisma.webhookEvent.findMany();
    expect(inbox[0].status).toBe(WebhookStatus.IGNORED);
    // Gravar 'unsupported' perderia a informacao que o operador precisa para triar.
    expect(inbox[0].eventType).toBe('customer.updated');
  });
});

// ==========================================================
// 13. Trilha coerente do CANCELED — achado 4.6 do PR #52
// ==========================================================
describe('webhook — trilha de transacao do CANCELED', () => {
  it('CASO 13: CANCELED fecha o AUTHORIZE pendente com failureCode explicito', async () => {
    const { app, provider } = montarApp();
    const { payment, chargeRef } = await cenario();

    const res = await postar(
      app,
      provider.assinarCorpo(
        corpo({ type: 'payment.canceled' }, { charge_ref: chargeRef, state: 'CANCELED', captured_amount_cents: 0 }),
      ),
    );

    expect(res.status).toBe(200);
    const atualizado = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atualizado.status).toBe(PaymentStatus.CANCELED);

    // O defeito que este caso caca: pagamento terminal em CANCELED com a
    // transacao ainda PENDING, dizendo que a autorizacao segue em aberto.
    const trilha = await transacoesDe(payment.id);
    const autorizacao = trilha.find((t) => t.type === TransactionType.AUTHORIZE);
    expect(autorizacao?.status).toBe(TransactionStatus.FAILED);
    expect(autorizacao?.failureCode).toBe('PROVIDER_CANCELED');
  });
});

// ==========================================================
// 14. Reembolso: quinta variante da uniao, nao pode virar silencio
// ==========================================================
describe('webhook — refund.succeeded', () => {
  it('CASO 14: reembolso move refundedAmountCents e NAO muda o status', async () => {
    const { app, provider } = montarApp();
    const { payment, chargeRef } = await cenario(PaymentStatus.CAPTURED);
    await prisma.payment.update({
      where: { id: payment.id },
      data: { capturedAmountCents: VALOR },
    });

    const res = await postar(
      app,
      provider.assinarCorpo(
        corpo(
          { type: 'refund.succeeded' },
          { charge_ref: chargeRef, refunded_amount_cents: 5000 },
        ),
      ),
    );

    expect(res.status).toBe(200);

    // CAPTURED e TERMINAL: reembolso e aritmetica sobre refundedAmountCents
    // (decisao 9 da fase), nao transicao de estado.
    const atualizado = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atualizado.status).toBe(PaymentStatus.CAPTURED);
    expect(atualizado.refundedAmountCents).toBe(5000);

    const trilha = await transacoesDe(payment.id);
    const reembolso = trilha.find((t) => t.type === TransactionType.REFUND);
    expect(reembolso).toMatchObject({
      status: TransactionStatus.SUCCEEDED,
      amountCents: 5000,
    });

    const inbox = await prisma.webhookEvent.findMany();
    expect(inbox[0].status).toBe(WebhookStatus.PROCESSED);
  });
});
