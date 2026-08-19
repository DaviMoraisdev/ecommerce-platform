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

  it('CASO 11: charge_ref desconhecido e RETENTAVEL, nao terminal', async () => {
    const { app, provider } = montarApp();
    const { payment } = await cenario();

    // O providerRef so e persistido no registrarDesfecho, DEPOIS da resposta
    // do provedor: a linha write-ahead nasce com providerRef null. Logo o
    // webhook pode chegar antes desse commit. Marcar IGNORED aqui perderia o
    // efeito financeiro para sempre, porque 200 impede a retentativa.
    const res = await postar(app, provider.assinarCorpo(corpo()));

    expect(res.status).toBe(503);
    const inbox = await prisma.webhookEvent.findMany();
    expect(inbox).toHaveLength(1);
    expect(inbox[0].status).toBe(WebhookStatus.RECEIVED);
    const intacto = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(intacto.status).toBe(PaymentStatus.PROCESSING);
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

// ==========================================================
// 15. A guarda que a sabotagem S9 revelou sem cobertura
// ==========================================================
describe('webhook — corpo que o parser raw nao aceita', () => {
  it('CASO 15: Content-Type diferente e recusado com 400 e nao grava nada', async () => {
    const { app, provider } = montarApp();
    const { payment, chargeRef } = await cenario();
    const req = provider.assinarCorpo(corpo({}, { charge_ref: chargeRef }));

    // express.raw({ type: "application/json" }) NAO lanca quando o tipo nao
    // casa: deixa req.body como {} e a verificacao rodaria sobre nada.
    const res = await request(app)
      .post('/webhooks/fake')
      .set('content-type', 'text/plain')
      .set('x-fake-signature', req.headers['x-fake-signature'] as string)
      .send(req.rawBody.toString('utf8'));

    expect(res.status).toBe(400);
    expect(await prisma.webhookEvent.count()).toBe(0);
    const intacto = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(intacto.status).toBe(PaymentStatus.PROCESSING);
  });
});

// ==========================================================
// 16. Cap de tamanho do corpo cru
// ==========================================================
describe('webhook — teto de tamanho do corpo', () => {
  it('CASO 16: corpo acima do teto e recusado com 413 e nao grava nada', async () => {
    const { app, provider } = montarApp();
    const { payment, chargeRef } = await cenario();

    // Corpo sem teto e vetor de exaustao de memoria. 80kb passa dos 64kb
    // do LIMITE_CORPO_WEBHOOK; o 413 do express.raw e traduzido pelo
    // handler de erro do app, que ja converte status de cliente em 4xx.
    const gordo = corpo({}, { charge_ref: chargeRef });
    gordo.recheio = 'x'.repeat(80000);

    const res = await postar(app, provider.assinarCorpo(gordo));

    expect(res.status).toBe(413);
    expect(await prisma.webhookEvent.count()).toBe(0);
    const intacto = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(intacto.status).toBe(PaymentStatus.PROCESSING);
  });
});

// ==========================================================
// 17. Sanitizacao em ESCRITA do payload do inbox
// ==========================================================
describe('webhook — sanitizacao do payload gravado', () => {
  it('CASO 17: campo sensivel e redigido, o resto do payload e preservado', async () => {
    const { app, provider } = montarApp();
    const { chargeRef } = await cenario();

    const evento = corpo({}, { charge_ref: chargeRef });
    evento.token = 'tok_supersecreto';
    (evento.data as Record<string, unknown>).cvv = '123';

    const res = await postar(app, provider.assinarCorpo(evento));
    expect(res.status).toBe(200);

    const inbox = await prisma.webhookEvent.findMany();
    const payload = inbox[0].payload as Record<string, unknown>;

    expect(payload.token).toBe('[redigido]');
    expect((payload.data as Record<string, unknown>).cvv).toBe('[redigido]');

    // Denylist, e nao allowlist: o inbox existe para preservar a evidencia
    // integra, inclusive campos que nao conhecemos.
    expect(payload.id).toBe(evento.id);
    expect(JSON.stringify(inbox[0].payload)).not.toContain('tok_supersecreto');
  });
});

// ==========================================================
// 18 e 19. Assinatura valida NAO torna o valor coerente
// ==========================================================
describe('webhook — coerencia de valor', () => {
  it('CASO 18: captura com valor divergente do cobrado vira IGNORED', async () => {
    const { app, provider } = montarApp();
    const { payment, chargeRef } = await cenario();

    const res = await postar(
      app,
      provider.assinarCorpo(
        corpo({}, { charge_ref: chargeRef, captured_amount_cents: 999 }),
      ),
    );

    expect(res.status).toBe(200);
    const intacto = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(intacto.status).toBe(PaymentStatus.PROCESSING);
    expect(intacto.capturedAmountCents).toBe(0);
    const trilha = await transacoesDe(payment.id);
    expect(trilha.filter((t) => t.type === TransactionType.CAPTURE)).toHaveLength(0);
    const inbox = await prisma.webhookEvent.findMany();
    expect(inbox[0].status).toBe(WebhookStatus.IGNORED);
  });

  it('CASO 19: reembolso acima do capturado NO NOSSO ESTADO vira IGNORED', async () => {
    const { app, provider } = montarApp();

    // Fixture deliberadamente divergente: pagamento CAPTURED com
    // capturedAmountCents ainda zerado. Modela desacordo entre o NOSSO estado
    // e o do provedor — exatamente o que a reconciliacao do Bloco 6 trata.
    const { payment, chargeRef } = await cenario(PaymentStatus.CAPTURED);

    // Payload INTERNAMENTE COERENTE (refunded <= captured). Com refunded maior
    // que captured no proprio payload, quem recusa e o fake.wire com 400, e o
    // teste provaria o WIRE, nao esta guarda. Sao invariantes diferentes: o
    // wire compara campos do payload entre si; a guarda compara o payload com
    // o NOSSO banco, coisa que nenhum adapter tem como fazer.
    const res = await postar(
      app,
      provider.assinarCorpo(
        corpo(
          { type: 'refund.succeeded' },
          {
            charge_ref: chargeRef,
            captured_amount_cents: VALOR,
            refunded_amount_cents: VALOR,
          },
        ),
      ),
    );

    expect(res.status).toBe(200);

    // A linha de inbox prova que o evento PASSOU pelo verifyWebhook e chegou
    // ao servico. Recusa do wire devolveria 400 e zero linha.
    const inbox = await prisma.webhookEvent.findMany();
    expect(inbox).toHaveLength(1);
    expect(inbox[0].status).toBe(WebhookStatus.IGNORED);

    const intacto = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(intacto.refundedAmountCents).toBe(0);
    const trilha = await transacoesDe(payment.id);
    expect(trilha.filter((t) => t.type === TransactionType.REFUND)).toHaveLength(0);
  });
});

// ==========================================================
// 20 a 24. Achados do review do PR #53
// ==========================================================
describe('webhook — achados do review', () => {
  it('CASO 20: valor de campo nao reconhecido nao e persistido; segredo e redigido', async () => {
    const { app, provider } = montarApp();
    const { chargeRef } = await cenario();

    const evento = corpo({}, { charge_ref: chargeRef });
    // Aliases reais de dado de autenticacao de cartao (PCI/SAD).
    evento.access_token = 'at_segredo';
    evento.cardNumber = '4111111111111111';
    evento.apiKey = 'ak_segredo';
    evento['x-api-key'] = 'xak_segredo';
    evento.card_cvv = 'cvv_segredo';
    evento.cvv2 = 'cvv2_segredo';
    evento.primary_pan = 'pan_segredo';
    evento.customer_iban = 'iban_segredo';
    evento.security_code = 'sc_segredo';
    evento.verification_value = 'vv_segredo';
    evento.pin_block = 'pin_segredo';
    evento.track2 = 'track_segredo';
    evento.magstripe_data = 'mag_segredo';
    evento.cryptogram = 'crypto_segredo';
    (evento.data as Record<string, unknown>).private_key = 'pk_segredo';
    // Campo desconhecido e INOFENSIVO: nem por isso o valor pode ser persistido.
    evento.company = 'ACME expansion LTDA';
    // Estruturas desconhecidas: o bypass da allowlist por NOME. Array recursa e
    // o escalar dentro dele escapava; objeto desconhecido reativava a allowlist
    // global, entao `id` e `state` sobreviviam num caminho proibido.
    evento.extra_array = ['segredo_array'];
    evento.extra_object = { id: 'segredo_objeto', state: 'segredo_estado' };
    evento.extra_nested = [{ type: 'segredo_aninhado' }];

    expect((await postar(app, provider.assinarCorpo(evento))).status).toBe(200);

    const inbox = await prisma.webhookEvent.findMany();
    const payload = inbox[0].payload as Record<string, unknown>;
    const serializado = JSON.stringify(payload);

    const segredos = [
      'at_segredo', '4111111111111111', 'ak_segredo', 'xak_segredo',
      'cvv_segredo', 'cvv2_segredo', 'pan_segredo', 'iban_segredo',
      'sc_segredo', 'vv_segredo', 'pin_segredo', 'track_segredo',
      'mag_segredo', 'crypto_segredo', 'pk_segredo', 'ACME expansion LTDA',
      'segredo_array', 'segredo_objeto', 'segredo_estado', 'segredo_aninhado',
    ];
    for (const segredo of segredos) {
      expect(serializado).not.toContain(segredo);
    }

    // Campo do CONTRATO preserva valor.
    expect(payload.id).toBe(evento.id);
    expect(payload.type).toBe('payment.succeeded');

    // Campo fora do contrato preserva a CHAVE, para o operador saber que veio,
    // e perde o VALOR. Campo que sabemos ser segredo recebe marca distinta.
    expect(payload.company).toBe('[nao-reconhecido]');
    expect(payload.magstripe_data).toBe('[redigido]');
    // `primary_pan` so e pego pela camada de SEGMENTOS (nenhuma raiz casa com
    // ele). Sem esta assercao, desligar a segmentacao nao derrubaria nada, e a
    // camada viraria decorativa depois da allowlist.
    expect(payload.primary_pan).toBe('[redigido]');

    // ALLOWLIST POR CAMINHO: `id` e do contrato NA RAIZ. O mesmo nome dentro de
    // um objeto desconhecido nao pode reativar a allowlist.
    const extraObjeto = payload.extra_object as Record<string, unknown>;
    expect(extraObjeto.id).toBe('[nao-reconhecido]');
    expect(extraObjeto.state).toBe('[nao-reconhecido]');
    expect(payload.extra_array).toEqual(['[nao-reconhecido]']);

    // A FORMA sobrevive: o operador ve que veio um array de objeto, sem o valor.
    expect(Array.isArray(payload.extra_nested)).toBe(true);
    expect((payload.extra_nested as Record<string, unknown>[])[0].type).toBe('[nao-reconhecido]');

    // Campo do contrato DENTRO de `data` continua preservado.
    expect((payload.data as Record<string, unknown>).charge_ref).toBe(chargeRef);
    expect(payload.access_token).toBe('[redigido]');
  });

  it('CASO 21: valor divergente em estado JA aplicado nao vira PROCESSED silencioso', async () => {
    const { app, provider } = montarApp();
    const { payment, chargeRef } = await cenario(PaymentStatus.CAPTURED);
    await prisma.payment.update({
      where: { id: payment.id },
      data: { capturedAmountCents: VALOR },
    });

    // Invariante monetaria tem de ser checada ANTES do curto-circuito de
    // idempotencia, senao a divergencia deixa de ser sinalizada para triagem.
    const res = await postar(
      app,
      provider.assinarCorpo(corpo({}, { charge_ref: chargeRef, captured_amount_cents: 999 })),
    );

    expect(res.status).toBe(200);
    const inbox = await prisma.webhookEvent.findMany();
    expect(inbox[0].status).toBe(WebhookStatus.IGNORED);
    const intacto = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(intacto.capturedAmountCents).toBe(VALOR);
  });

  // NAO-DETERMINISTICO: com Promise.all, se as duas requisicoes serializarem, a
  // segunda ja le o estado atualizado e o caso passa MESMO COM O DEFEITO. Vale
  // como invariante ponta a ponta, nao como prova. Quem prova a reavaliacao
  // apos CAS perdido e tests/unit/services/webhook.service.test.ts, onde o
  // dublê forca count: 0 de forma deterministica.
  it('CASO 22: reembolsos CONCORRENTES nao perdem o maior total', async () => {
    const { app, provider } = montarApp();
    const { payment, chargeRef } = await cenario(PaymentStatus.CAPTURED);
    await prisma.payment.update({
      where: { id: payment.id },
      data: { capturedAmountCents: VALOR },
    });

    const evento = (total: number) =>
      provider.assinarCorpo(
        corpo(
          { type: 'refund.succeeded' },
          {
            charge_ref: chargeRef,
            captured_amount_cents: VALOR,
            refunded_amount_cents: total,
          },
        ),
      );

    // Se o de 5000 vencer o CAS, o de 7000 NAO pode virar IGNORED com 200: o
    // provedor nao retenta e o banco ficaria abaixo do reembolso real.
    await Promise.all([postar(app, evento(5000)), postar(app, evento(7000))]);

    const final = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(final.refundedAmountCents).toBe(7000);

    const trilha = await transacoesDe(payment.id);
    const somaReembolsos = trilha
      .filter((t) => t.type === TransactionType.REFUND)
      .reduce((acc, t) => acc + t.amountCents, 0);
    expect(somaReembolsos).toBe(7000);
  });

  it('CASO 23: entregas CONCORRENTES do mesmo evento aplicam efeito UMA vez', async () => {
    const { app, provider } = montarApp();
    const { payment, chargeRef } = await cenario();
    const req = provider.assinarCorpo(corpo({}, { charge_ref: chargeRef }));

    await Promise.all([postar(app, req), postar(app, req)]);

    const final = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(final.status).toBe(PaymentStatus.CAPTURED);
    expect(await prisma.webhookEvent.count()).toBe(1);
    const trilha = await transacoesDe(payment.id);
    expect(trilha.filter((t) => t.type === TransactionType.CAPTURE)).toHaveLength(1);
    // O STATUS final da linha de inbox nao e afirmado aqui: sem claim de posse
    // a perdedora do CAS pode sobrescrever PROCESSED com IGNORED. Divida
    // registrada para o Bloco 6; o dinheiro e o que este caso protege.
  });

  it('CASO 24: retomada de linha FAILED nao infla attempts', async () => {
    const { app, provider } = montarApp();
    const { payment, chargeRef } = await cenario();
    const evento = corpo({}, { charge_ref: chargeRef });

    await prisma.webhookEvent.create({
      data: {
        provider: 'fake',
        providerEventId: evento.id as string,
        eventType: evento.type as string,
        payload: evento as Prisma.InputJsonObject,
        providerCreatedAt: new Date(evento.created_at as string),
        status: WebhookStatus.FAILED,
        attempts: 1,
        lastError: 'falha inesperada no processamento do webhook',
      },
    });

    expect((await postar(app, provider.assinarCorpo(evento))).status).toBe(200);

    const inbox = await prisma.webhookEvent.findMany();
    expect(inbox[0].status).toBe(WebhookStatus.PROCESSED);
    // attempts conta TENTATIVAS QUE FALHARAM. Uma retomada bem-sucedida nao
    // e uma falha nova; incrementar no registro E no catch conta duas vezes.
    expect(inbox[0].attempts).toBe(1);
    const final = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(final.status).toBe(PaymentStatus.CAPTURED);
  });
});

// ==========================================================
// 25. Ciclo completo do providerRef transitorio
// ==========================================================
describe('webhook — retomada apos providerRef aparecer', () => {
  it('CASO 25: 503 primeiro, aplicado depois que a transacao e persistida', async () => {
    const { app, provider } = montarApp();
    const chargeRef = `ch_${randomUUID()}`;

    // Pagamento SEM transacao ainda: o estado real entre o createCharge e o
    // commit do registrarDesfecho.
    const payment = await prisma.payment.create({
      data: {
        orderId: randomUUID(),
        userId: randomUUID(),
        amountCents: VALOR,
        currency: 'BRL',
        provider: 'fake',
        status: PaymentStatus.PROCESSING,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      },
    });

    const req = provider.assinarCorpo(corpo({}, { charge_ref: chargeRef }));

    expect((await postar(app, req)).status).toBe(503);
    const primeiro = await prisma.webhookEvent.findMany();
    expect(primeiro).toHaveLength(1);
    expect(primeiro[0].status).toBe(WebhookStatus.RECEIVED);

    // O registrarDesfecho commita o providerRef.
    await prisma.paymentTransaction.create({
      data: {
        paymentId: payment.id,
        type: TransactionType.AUTHORIZE,
        status: TransactionStatus.PENDING,
        amountCents: VALOR,
        providerRef: chargeRef,
      },
    });

    // MESMO evento reentregue: colide no unique, e retomado, e aplica.
    expect((await postar(app, req)).status).toBe(200);

    const inbox = await prisma.webhookEvent.findMany();
    expect(inbox).toHaveLength(1);
    expect(inbox[0].status).toBe(WebhookStatus.PROCESSED);
    expect(inbox[0].lastError).toBeNull();

    const final = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(final.status).toBe(PaymentStatus.CAPTURED);
  });
});

// ==========================================================
// 26. Caminho que a sabotagem S31 revelou sem cobertura
// ==========================================================
describe('webhook — `data` como array', () => {
  it('CASO 26: array no lugar de `data` nao reativa a allowlist do contrato', async () => {
    const { app, provider } = montarApp();

    // Evento NAO suportado: o fake.wire so valida a estrutura de cobranca em
    // tipos suportados, entao este `data` chega cru ao sanitizador. Sem o modo
    // estrutura no ramo de array, os itens seriam sanitizados COM o no do
    // contrato e `charge_ref`/`state` preservariam valor num caminho invalido.
    const res = await postar(
      app,
      provider.assinarCorpo({
        id: `evt_${randomUUID()}`,
        type: 'customer.updated',
        created_at: new Date().toISOString(),
        data: [{ charge_ref: 'segredo_no_array', state: 'segredo_estado_array' }],
      }),
    );

    expect(res.status).toBe(200);

    const inbox = await prisma.webhookEvent.findMany();
    expect(inbox[0].status).toBe(WebhookStatus.IGNORED);

    const serializado = JSON.stringify(inbox[0].payload);
    expect(serializado).not.toContain('segredo_no_array');
    expect(serializado).not.toContain('segredo_estado_array');

    // A FORMA sobrevive: o operador ve que `data` veio como array.
    expect(Array.isArray((inbox[0].payload as Record<string, unknown>).data)).toBe(true);
  });
});

// ==========================================================
// 27 e 28. Achados da 5a rodada de review
// ==========================================================
describe('webhook — limites da arvore de contrato', () => {
  it('CASO 27: nome que NORMALIZA para campo do contrato nao e autorizado', async () => {
    const { app, provider } = montarApp();
    const { chargeRef } = await cenario();

    // A denylist PRECISA ser tolerante a variacao de escrita; a allowlist NAO.
    // Com a mesma normalizacao nas duas, i-d virava id e passava a preservar
    // valor na raiz, e d-a-t-a abria o caminho do contrato.
    const evento = corpo({}, { charge_ref: chargeRef });
    evento['i-d'] = 'segredo_id';
    evento['created@at'] = 'segredo_criado';
    evento['t.y.p.e'] = 'segredo_tipo';
    evento['d-a-t-a'] = { 'charge#ref': 'segredo_ref' };

    expect((await postar(app, provider.assinarCorpo(evento))).status).toBe(200);

    const payload = (await prisma.webhookEvent.findMany())[0].payload as Record<string, unknown>;
    const serializado = JSON.stringify(payload);
    for (const segredo of ['segredo_id', 'segredo_criado', 'segredo_tipo', 'segredo_ref']) {
      expect(serializado).not.toContain(segredo);
    }
    expect(payload['i-d']).toBe('[nao-reconhecido]');
    expect(payload['created@at']).toBe('[nao-reconhecido]');

    // O campo REAL do contrato continua preservado.
    expect(payload.id).toBe(evento.id);
    expect((payload.data as Record<string, unknown>).charge_ref).toBe(chargeRef);
  });

  it('CASO 28: chave herdada do prototipo nao derruba nem some da evidencia', async () => {
    const { app, provider } = montarApp();

    // STRING CRUA de proposito. Num literal TypeScript, `__proto__` DEFINE o
    // prototipo do objeto e nunca vira chave — o cenario passava sem testar
    // nada. So JSON.parse cria propriedade PROPRIA com esse nome.
    const id = `evt_${randomUUID()}`;
    const criadoEm = new Date().toISOString();
    const corpoCru =
      '{"id":"' + id + '","type":"customer.updated","created_at":"' + criadoEm + '",' +
      '"constructor":{"value":"segredo_ctor"},' +
      '"__proto__":{"value":"segredo_proto"}}';

    // `constructor` numa busca por objeto literal devolveria a propriedade
    // HERDADA de Object.prototype, seria tratada como no do contrato, e a
    // recursao estouraria TypeError: 500 e retentativa infinita.
    const res = await postar(app, provider.assinarCorpo(corpoCru));

    expect(res.status).toBe(200);
    const inbox = await prisma.webhookEvent.findMany();
    expect(inbox[0].status).toBe(WebhookStatus.IGNORED);

    const payload = inbox[0].payload as Record<string, unknown>;
    const serializado = JSON.stringify(payload);
    expect(serializado).not.toContain('segredo_ctor');
    expect(serializado).not.toContain('segredo_proto');

    // As duas chaves sobrevivem como EVIDENCIA. Com `saida = {}` em vez de
    // Object.create(null), atribuir `__proto__` reescreveria o prototipo e a
    // chave sumiria em silencio do inbox.
    expect(Object.keys(payload)).toContain('constructor');

    // `__proto__` NAO sobrevive ao round-trip do Prisma/Postgres: comprovado por
    // diagnostico isolado, a chave existe ao gravar e some ao ler. Por isso ela e
    // renomeada na escrita — a evidencia de que o campo veio nao pode sumir em
    // silencio de uma tabela de auditoria.
    expect(Object.keys(payload)).toContain('__proto__ [renomeado]');
  });
});
