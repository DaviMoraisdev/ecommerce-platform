import {
  PaymentStatus,
  TransactionStatus,
  TransactionType,
  WebhookStatus,
  type Payment,
  type PaymentTransaction,
  type PrismaClient,
} from '@prisma/client';
import type { WebhookEventPayload } from '../../../src/providers/payment-provider.port';
import { WebhookService } from '../../../src/services/webhook.service';

/**
 * O que ESTE arquivo prova e a integracao NAO consegue provar.
 *
 * O CASO 22 da suite de integracao usa Promise.all e depende do escalonador:
 * se as duas requisicoes serializarem, a segunda le o estado ja atualizado e o
 * teste passa mesmo com o defeito presente. Verde por sorte nao e prova.
 *
 * Aqui o dublê forca `updateMany` a devolver `count: 0` — o CAS perdido —
 * de forma deterministica, e verifica o que o servico FAZ depois disso.
 */

const AGORA = new Date('2026-08-18T12:00:00.000Z');
const VALOR = 12990;

function pagamento(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay_1',
    orderId: 'ord_1',
    userId: 'usr_1',
    status: PaymentStatus.CAPTURED,
    amountCents: VALOR,
    capturedAmountCents: VALOR,
    refundedAmountCents: 0,
    currency: 'BRL',
    provider: 'fake',
    attemptCount: 1,
    expiresAt: new Date(AGORA.getTime() + 900_000),
    createdAt: AGORA,
    updatedAt: AGORA,
    ...overrides,
  } as Payment;
}

function autorizacao(): PaymentTransaction {
  return {
    id: 'tx_1',
    paymentId: 'pay_1',
    type: TransactionType.AUTHORIZE,
    status: TransactionStatus.SUCCEEDED,
    amountCents: VALOR,
    providerRef: 'ch_1',
    failureCode: null,
    failureMessage: null,
    createdAt: AGORA,
    updatedAt: AGORA,
  } as PaymentTransaction;
}

function eventoDeReembolso(total: number): WebhookEventPayload {
  return {
    providerEventId: 'evt_1',
    providerEventTypeBruto: 'refund.succeeded',
    providerCreatedAt: AGORA,
    raw: { id: 'evt_1' },
    eventType: 'refund.succeeded',
    providerRef: 'ch_1',
    state: 'SUCCEEDED',
    capturedAmountCents: VALOR,
    refundedAmountCents: total,
  } as unknown as WebhookEventPayload;
}

function eventoDeCaptura(): WebhookEventPayload {
  return {
    providerEventId: 'evt_2',
    providerEventTypeBruto: 'payment.succeeded',
    providerCreatedAt: AGORA,
    raw: { id: 'evt_2' },
    eventType: 'payment.succeeded',
    providerRef: 'ch_1',
    state: 'SUCCEEDED',
    capturedAmountCents: VALOR,
    refundedAmountCents: 0,
  } as unknown as WebhookEventPayload;
}

interface Criada {
  type?: TransactionType;
  amountCents?: number;
}

/**
 * `leituras` alimenta cada chamada de `payment.findUniqueOrThrow` em ordem: a
 * primeira e a leitura inicial, as seguintes sao as RELEITURAS apos CAS perdido.
 * `contagens` alimenta cada `updateMany` — e assim que se force a corrida.
 */
function montar(
  leituras: Payment[],
  contagens: number[],
  erroNaTransacao?: Error,
  transacao: PaymentTransaction | null = autorizacao(),
) {
  const criadas: Criada[] = [];
  const inbox: Record<string, unknown>[] = [];
  const filtros: Record<string, unknown>[] = [];
  // Dois espioes com o MESMO nome de operacao, em clientes diferentes: e a
  // unica forma de distinguir "gravou dentro da transacao" de "gravou fora".
  const outboxNoTx = jest.fn(async () => ({}));
  const outboxForaDaTx = jest.fn(async () => ({}));
  let iLeitura = 0;
  let iCas = 0;

  const tx = {
    payment: { updateMany: jest.fn(async () => ({ count: contagens[iCas++] ?? 0 })) },
    paymentTransaction: {
      create: jest.fn(async ({ data }: { data: Criada }) => { criadas.push(data); return data; }),
      update: jest.fn(async () => ({})),
    },
    webhookEvent: {
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => { inbox.push(data); return data; }),
    },
    outboxEvent: { create: outboxNoTx },
  };

  const prisma = {
    webhookEvent: {
      create: jest.fn(async () => ({ id: 'inbox_1' })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => { inbox.push(data); return data; }),
      updateMany: jest.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          filtros.push(where);
          inbox.push(data);
          return { count: 1 };
        },
      ),
      findUniqueOrThrow: jest.fn(),
    },
    paymentTransaction: { findFirst: jest.fn(async () => transacao) },
    outboxEvent: { create: outboxForaDaTx },
    payment: {
      findUniqueOrThrow: jest.fn(async () =>
        leituras[Math.min(iLeitura++, leituras.length - 1)],
      ),
    },
    $transaction: jest.fn(async (cb: (t: unknown) => Promise<unknown>) => {
      if (erroNaTransacao) throw erroNaTransacao;
      return cb(tx);
    }),
  } as unknown as PrismaClient;

  return { service: new WebhookService({ prisma }), criadas, inbox, filtros, tx, outboxNoTx, outboxForaDaTx };
}

describe('WebhookService — CAS perdido no reembolso (achado 4.1)', () => {
  it('recarrega o estado e aplica o delta correto em vez de descartar o evento', async () => {
    // Dois eventos concorrentes: 5000 vence o CAS, 7000 perde. Sem releitura,
    // o de 7000 vira IGNORED com 200 e o banco fica ABAIXO do reembolso real.
    const { service, criadas } = montar(
      [pagamento({ refundedAmountCents: 0 }), pagamento({ refundedAmountCents: 5000 })],
      [0, 1],
    );

    const resultado = await service.processar('fake', eventoDeReembolso(7000));

    expect(resultado.status).toBe(WebhookStatus.PROCESSED);
    const reembolsos = criadas.filter((c) => c.type === TransactionType.REFUND);
    expect(reembolsos).toHaveLength(1);
    // Delta sobre o estado RECARREGADO: 7000 - 5000. Reaplicar 7000 inteiro
    // duplicaria o valor na trilha.
    expect(reembolsos[0].amountCents).toBe(2000);
  });

  it('trata como replay quando a releitura ja reflete o total do evento', async () => {
    const { service, criadas } = montar(
      [pagamento({ refundedAmountCents: 0 }), pagamento({ refundedAmountCents: 7000 })],
      [0],
    );

    const resultado = await service.processar('fake', eventoDeReembolso(7000));

    expect(resultado.status).toBe(WebhookStatus.PROCESSED);
    // Delta zero: nada a mover, e nenhuma linha nova na trilha.
    expect(criadas.filter((c) => c.type === TransactionType.REFUND)).toHaveLength(0);
  });
});

describe('WebhookService — CAS perdido na transicao de status (achado 4.2)', () => {
  it('marca como RETENTAVEL quando a transicao continua permitida apos releitura', async () => {
    // Perder a corrida nao significa que o evento e obsoleto. Se depois da
    // releitura a transicao AINDA e permitida, encerrar como IGNORED com 200
    // descartaria um efeito financeiro que deveria acontecer.
    const emVoo = pagamento({ status: PaymentStatus.PROCESSING, capturedAmountCents: 0 });
    const { service } = montar([emVoo, emVoo], [0]);

    const resultado = await service.processar('fake', eventoDeCaptura());

    expect(resultado.retentavel).toBe(true);
    expect(resultado.status).toBe(WebhookStatus.RECEIVED);
  });
});

describe('WebhookService — falha durante a aplicacao (achado 6.4)', () => {
  it('marca FAILED com mensagem sanitizada, incrementa attempts e propaga o erro', async () => {
    // A rota traduz a excecao em 500, e o provedor retenta. O caminho de falha
    // nao tinha NENHUM teste: nada provava que a linha nao fica presa em
    // RECEIVED nem que a mensagem original do banco fica fora do inbox.
    const falha = new Error('relation "payments" does not exist at character 42');
    const { service, inbox, filtros } = montar(
      [pagamento({ status: PaymentStatus.PROCESSING, capturedAmountCents: 0 })],
      [],
      falha,
    );

    await expect(service.processar('fake', eventoDeCaptura())).rejects.toThrow(falha);

    const marcacao = inbox.find((d) => d.status === WebhookStatus.FAILED);
    expect(marcacao).toBeDefined();
    expect(marcacao?.attempts).toEqual({ increment: 1 });
    // Erro de Prisma carrega nome de tabela e coluna, e o inbox e lido em
    // triagem operacional. A mensagem original nunca pode chegar la.
    expect(JSON.stringify(marcacao)).not.toContain('relation');

    // Assercao ESTRUTURAL (nao comportamental): a marcacao de FAILED so pode
    // atingir linha ainda nao concluida. Provar isso por comportamento exigiria
    // simular a execucao concorrente, o que so faz sentido com o claim
    // exclusivo do Bloco 6.
    const filtro = filtros.find((f) => f.status !== undefined);
    expect(filtro).toMatchObject({
      id: 'inbox_1',
      status: { in: [WebhookStatus.RECEIVED, WebhookStatus.FAILED] },
    });
  });
});

describe('WebhookService — exaustao do laco de reavaliacao (achado 6.2)', () => {
  it('esgota o limite e devolve RETENTAVEL sem criar trilha nem encerrar o inbox', async () => {
    // Contencao continua: todo CAS falha. O evento NAO pode virar terminal —
    // sem efeito aplicado, encerrar aqui perderia o reembolso de vez.
    const { service, criadas, inbox } = montar(
      [pagamento({ refundedAmountCents: 0 })],
      [0, 0, 0, 0],
    );

    const resultado = await service.processar('fake', eventoDeReembolso(7000));

    expect(resultado.retentavel).toBe(true);
    expect(resultado.status).toBe(WebhookStatus.RECEIVED);
    expect(criadas.filter((c) => c.type === TransactionType.REFUND)).toHaveLength(0);
    expect(inbox.some((d) => d.status === WebhookStatus.PROCESSED)).toBe(false);
    expect(inbox.some((d) => d.status === WebhookStatus.IGNORED)).toBe(false);
  });
});

describe('WebhookService — guarda de concorrencia no caminho retentavel (achado 4.1)', () => {
  it('so grava lastError de providerRef desconhecido em linha nao concluida', async () => {
    // Sem a guarda, uma execucao atrasada escreve "providerRef ainda
    // desconhecido" numa linha que a concorrente ja concluiu como PROCESSED.
    const { service, filtros } = montar([pagamento()], [], undefined, null);

    const resultado = await service.processar('fake', eventoDeCaptura());

    expect(resultado.retentavel).toBe(true);
    const filtro = filtros[filtros.length - 1];
    expect(filtro).toMatchObject({
      id: 'inbox_1',
      status: { in: [WebhookStatus.RECEIVED, WebhookStatus.FAILED] },
    });
  });
});

describe('WebhookService — outbox na MESMA transacao (achado R6)', () => {
  it('grava o evento pelo cliente da TRANSACAO, nunca pelo cliente solto', async () => {
    const emVoo = pagamento({ status: PaymentStatus.PROCESSING, capturedAmountCents: 0 });
    const { service, outboxNoTx, outboxForaDaTx } = montar([emVoo], [1]);

    const resultado = await service.processar('fake', eventoDeCaptura());

    expect(resultado.status).toBe(WebhookStatus.PROCESSED);
    expect(outboxNoTx).toHaveBeenCalledTimes(1);
    // Pelo cliente solto, o evento COMMITA sozinho: um efeito que reverte
    // deixaria o order-service sabendo de um pagamento que nao aconteceu.
    // O CASO 30 prova a direcao oposta (evento falha -> efeito nao fica);
    // esta e a simetrica, e ate a sabotagem R6 ela nao tinha prova nenhuma.
    expect(outboxForaDaTx).not.toHaveBeenCalled();
  });
});
