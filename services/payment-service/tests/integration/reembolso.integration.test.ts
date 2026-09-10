import { randomUUID } from 'node:crypto';
import { PaymentStatus, TransactionStatus, TransactionType, type PrismaClient } from '@prisma/client';
import { connectDatabase, disconnectDatabase } from '../../src/config/database';
import { PaymentDomainError } from '../../src/domain/errors';
import { FakeProvider } from '../../src/providers/fake/fake.provider';
import { FAKE_TOKENS } from '../../src/providers/fake/fake.tokens';
import type { PaymentProvider } from '../../src/providers/payment-provider.port';
import { PaymentService } from '../../src/services/payment.service';
import { WebhookService } from '../../src/services/webhook.service';
import { assertTestDatabase } from '../helpers/testDbGuard';
import { SEGREDO_WEBHOOK } from '../helpers/config';
import { orderClientFalso, pedidoDeTeste } from '../helpers/prisma-fake';

/**
 * Reembolso INICIADO por nos (Bloco 7).
 *
 * O invariante e `soma dos reembolsos <= capturado`, com DUAS barreiras: o
 * provedor (serializa o DINHEIRO) e o nosso CAS (serializa a CONTABILIDADE).
 * A terceira defesa e a idempotencia: sem ela, um retry de rede vira reembolso
 * duplo.
 */

let prisma: PrismaClient;

beforeAll(async () => {
  assertTestDatabase(process.env);
  prisma = await connectDatabase(process.env.DATABASE_URL as string);
});

afterEach(async () => {
  await prisma.webhookEvent.deleteMany();
  await prisma.outboxEvent.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.paymentTransaction.deleteMany();
  await prisma.payment.deleteMany();
});

afterAll(async () => {
  await disconnectDatabase();
});

function cenario(token: string, provider?: PaymentProvider) {
  const userId = randomUUID();
  const orderId = randomUUID();
  const pedido = pedidoDeTeste({ id: orderId, userId });

  const service = new PaymentService({
    prisma,
    orderClient: orderClientFalso(jest.fn(async () => pedido)),
    provider: provider ?? new FakeProvider({ webhookSecret: SEGREDO_WEBHOOK }),
    currency: 'BRL',
    windowMinutes: 15,
  });

  return {
    service,
    userId,
    orderId,
    input: {
      userId,
      authorization: 'Bearer token.do.usuario',
      orderId,
      paymentMethodToken: token,
      idempotencyKey: randomUUID(),
    },
  };
}

/** Pagamento CAPTURED de verdade: captura automatica pelo caminho normal. */
async function pagamentoCapturado() {
  const ctx = cenario(FAKE_TOKENS.SUCCESS);
  await ctx.service.criarPagamento(ctx.input);

  const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: ctx.orderId } });
  expect(payment.status).toBe(PaymentStatus.CAPTURED);
  expect(payment.capturedAmountCents).toBeGreaterThan(0);
  expect(payment.refundedAmountCents).toBe(0);

  return { ...ctx, payment };
}

function pedidoDeReembolso(userId: string, paymentId: string, valorCents: number) {
  return { userId, idempotencyKey: randomUUID(), paymentId, valorCents };
}

async function linhasDeReembolso(paymentId: string) {
  return prisma.paymentTransaction.findMany({
    where: { paymentId, type: TransactionType.REFUND },
    orderBy: { createdAt: 'asc' },
  });
}

describe('reembolsar', () => {
  it('CASO R1: reembolso PARCIAL move o total e registra a movimentacao', async () => {
    const { service, userId, payment } = await pagamentoCapturado();
    const metade = Math.floor(payment.capturedAmountCents / 2);

    const r = await service.reembolsar(pedidoDeReembolso(userId, payment.id, metade));
    expect(r).toMatchObject({ tipo: 'aplicado', totalReembolsadoCents: metade });

    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.refundedAmountCents).toBe(metade);
    // O status NAO muda: reembolso e atributo do VALOR, nao transicao.
    expect(atual.status).toBe(PaymentStatus.CAPTURED);

    const linhas = await linhasDeReembolso(payment.id);
    expect(linhas).toHaveLength(1);
    expect(linhas[0].status).toBe(TransactionStatus.SUCCEEDED);
    // A trilha registra ESTA movimentacao; somar as linhas tem de dar o total.
    expect(linhas[0].amountCents).toBe(metade);
  });

  it('CASO R2: reembolsos parciais SEQUENCIAIS somam ate o capturado', async () => {
    const { service, userId, payment } = await pagamentoCapturado();
    const parte = Math.floor(payment.capturedAmountCents / 3);

    await service.reembolsar(pedidoDeReembolso(userId, payment.id, parte));
    await service.reembolsar(pedidoDeReembolso(userId, payment.id, parte));

    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.refundedAmountCents).toBe(parte * 2);
    expect((await linhasDeReembolso(payment.id)).map((x) => x.amountCents)).toEqual([parte, parte]);
  });

  it('CASO R3: valor acima do disponivel e recusado ANTES de mover dinheiro', async () => {
    const { service, userId, payment } = await pagamentoCapturado();

    const r = await service.reembolsar(
      pedidoDeReembolso(userId, payment.id, payment.capturedAmountCents + 1),
    );

    expect(r).toMatchObject({ tipo: 'excede-o-capturado' });
    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.refundedAmountCents).toBe(0);
    expect(await linhasDeReembolso(payment.id)).toHaveLength(0);
  });

  it('CASO R4: pagamento que NAO esta CAPTURED nao pode ser reembolsado', async () => {
    const { service, userId, payment } = await pagamentoCapturado();
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: PaymentStatus.FAILED },
    });

    expect(await service.reembolsar(pedidoDeReembolso(userId, payment.id, 100))).toMatchObject({
      tipo: 'estado-invalido',
    });
    expect(await linhasDeReembolso(payment.id)).toHaveLength(0);
  });

  it.each([0, -1, 1.5])('CASO R5: valor %p e recusado sem tocar em nada', async (valor) => {
    const { service, userId, payment } = await pagamentoCapturado();

    expect(await service.reembolsar(pedidoDeReembolso(userId, payment.id, valor))).toEqual({
      tipo: 'valor-invalido',
    });
    expect(await linhasDeReembolso(payment.id)).toHaveLength(0);
  });

  it('CASO R6: dois reembolsos CONCORRENTES nunca estouram o capturado', async () => {
    // O caso central do bloco. Cada um pede 60% do capturado: somados excedem.
    // Os dois passam na pre-checagem (leem refunded = 0) e so o PROVEDOR, que e
    // o ponto de serializacao do dinheiro, separa os dois.
    const { service, userId, payment } = await pagamentoCapturado();
    const parte = Math.ceil(payment.capturedAmountCents * 0.6);

    const [a, b] = await Promise.all([
      service.reembolsar(pedidoDeReembolso(userId, payment.id, parte)),
      service.reembolsar(pedidoDeReembolso(userId, payment.id, parte)),
    ]);

    expect([a.tipo, b.tipo].sort()).toEqual(['aplicado', 'excede-o-capturado']);

    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.refundedAmountCents).toBe(parte);
    expect(atual.refundedAmountCents).toBeLessThanOrEqual(atual.capturedAmountCents);
    expect(await linhasDeReembolso(payment.id)).toHaveLength(1);
  });

  it('CASO R7: aceite ASSINCRONO nao move o total — quem confirma e o webhook', async () => {
    const { payment } = await pagamentoCapturado();
    const provider = {
      refund: jest.fn(async () => ({
        providerRefundRef: 're_pendente',
        state: 'PROCESSING' as const,
        amountCents: 100,
      })),
    } as unknown as PaymentProvider;
    const ctx = cenario(FAKE_TOKENS.SUCCESS, provider);

    const r = await ctx.service.reembolsar(pedidoDeReembolso(ctx.userId, payment.id, 100));

    expect(r).toMatchObject({ tipo: 'pendente' });
    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.refundedAmountCents).toBe(0);

    const linhas = await linhasDeReembolso(payment.id);
    expect(linhas).toHaveLength(1);
    expect(linhas[0].status).toBe(TransactionStatus.PENDING);
  });

  it('CASO R8: recusa do provedor registra a tentativa e nao move o total', async () => {
    const { payment } = await pagamentoCapturado();
    const provider = {
      refund: jest.fn(async () => ({
        providerRefundRef: 're_recusado',
        state: 'DECLINED' as const,
        amountCents: 100,
        declineCode: 'refund_window_closed',
      })),
    } as unknown as PaymentProvider;
    const ctx = cenario(FAKE_TOKENS.SUCCESS, provider);

    const r = await ctx.service.reembolsar(pedidoDeReembolso(ctx.userId, payment.id, 100));

    expect(r).toMatchObject({ tipo: 'recusado', declineCode: 'refund_window_closed' });
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).refundedAmountCents,
    ).toBe(0);

    const linhas = await linhasDeReembolso(payment.id);
    expect(linhas).toHaveLength(1);
    expect(linhas[0].status).toBe(TransactionStatus.FAILED);
    expect(linhas[0].failureCode).toBe('refund_window_closed');
  });

  it('CASO R9: a MESMA chave devolve a resposta congelada, sem segundo reembolso', async () => {
    // Sem isto, um retry de rede vira reembolso duplo — o pior desfecho possivel
    // desta operacao.
    const { service, userId, payment } = await pagamentoCapturado();
    const metade = Math.floor(payment.capturedAmountCents / 2);
    const pedido = pedidoDeReembolso(userId, payment.id, metade);

    const primeira = await service.reembolsar(pedido);
    const segunda = await service.reembolsar(pedido);

    // Os campos que carregam DINHEIRO sao identicos; o que muda e a marca de
    // replay, que o cliente usa para distinguir 200 de 201 sem interpretar o
    // corpo. Afirmar igualdade total esconderia essa distincao.
    expect(primeira).not.toHaveProperty('replay');
    expect(segunda).toEqual({ ...primeira, replay: true });

    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.refundedAmountCents).toBe(metade);
    expect(await linhasDeReembolso(payment.id)).toHaveLength(1);
  });

  it('CASO R10: mesma chave com OUTRO valor e conflito, nao replay', async () => {
    // Mesmo achado 4.4 que o 6a corrigiu para o orderId: sem o valor no
    // fingerprint, reusar a chave pedindo outro montante devolveria em silencio
    // o reembolso anterior, e o operador acharia que reembolsou o novo valor.
    const { service, userId, payment } = await pagamentoCapturado();
    const pedido = pedidoDeReembolso(userId, payment.id, 100);

    await service.reembolsar(pedido);

    await expect(service.reembolsar({ ...pedido, valorCents: 200 })).rejects.toBeInstanceOf(
      PaymentDomainError,
    );

    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.refundedAmountCents).toBe(100);
    expect(await linhasDeReembolso(payment.id)).toHaveLength(1);
  });

  // CASO R11: a corrida do achado 4.2 do review, invertida DE PROPOSITO.
  //
  // O webhook do MESMO estorno e entregue ANTES de a transacao do endpoint
  // abrir. O endpoint perde o CAS, recarrega um total que JA inclui o proprio
  // estorno e, sem o indice unico parcial, somaria de novo — contabilidade
  // dobrada, em silencio, no caminho feliz.
  //
  // Deterministico por construcao: o Proxy entrega o webhook DENTRO da chamada
  // ao provedor, nao por timer. Sem isso a ordem dependeria de sorte.
  it('CASO R11: webhook do MESMO estorno vence o CAS e o endpoint NAO soma de novo', async () => {
    const webhook = new WebhookService({ prisma, tetoDeTentativas: 5, idadeMaximaMinutos: 60 });
    const real = new FakeProvider({ webhookSecret: SEGREDO_WEBHOOK });

    const provedor = new Proxy(real, {
      get(alvo, prop, receiver) {
        if (prop !== 'refund') {
          const valor = Reflect.get(alvo, prop, receiver);
          return typeof valor === 'function' ? valor.bind(alvo) : valor;
        }
        return async (entrada: Parameters<PaymentProvider['refund']>[0]) => {
          const resultado = await alvo.refund(entrada);
          // Sem override de valores: os defaults do fake leem a cobranca, que o
          // refund() acima ja atualizou. Corpo coerente sem repetir aritmetica.
          //
          // providerEventId EXPLICITO: o default e `evt_fake_<contador>` e o
          // contador reinicia a cada instancia do fake. Uma colisao no unique do
          // inbox faria o processar() devolver DUPLICATA sem aplicar nada, e o
          // caso passaria com o webhook nunca tendo tocado no banco.
          const requisicao = alvo.construirWebhook({
            providerRef: entrada.providerRef,
            eventType: 'refund.succeeded',
            refundRef: resultado.providerRefundRef,
            providerEventId: `evt_${randomUUID()}`,
          });
          await webhook.processar('fake', alvo.verifyWebhook(requisicao));
          return resultado;
        };
      },
    }) as PaymentProvider;

    const ctx = cenario(FAKE_TOKENS.SUCCESS, provedor);
    await ctx.service.criarPagamento(ctx.input);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: ctx.orderId } });
    expect(payment.status).toBe(PaymentStatus.CAPTURED);

    // Um TERCO do capturado: o dobro ainda cabe, entao a contabilizacao dupla
    // NAO seria barrada por `excede-o-capturado`. Sem essa folga o caso passaria
    // pelo motivo errado.
    const valor = Math.floor(payment.capturedAmountCents / 3);

    const r = await ctx.service.reembolsar(pedidoDeReembolso(ctx.userId, payment.id, valor));

    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.refundedAmountCents).toBe(valor);

    const sucedidas = (await linhasDeReembolso(payment.id)).filter(
      (l) => l.status === TransactionStatus.SUCCEEDED,
    );
    expect(sucedidas).toHaveLength(1);
    expect(r).toMatchObject({ tipo: 'aplicado', totalReembolsadoCents: valor });
  });

  // R12 e R13 cobrem o achado 3.1: a resposta do provedor era aceita sem
  // validacao. Sem estes casos, sabotar o fail-closed passaria VAZIO — o
  // mecanismo existiria sem prova nenhuma.
  it('CASO R12: valor devolvido diferente do pedido falha alto e nao contabiliza', async () => {
    const real = new FakeProvider({ webhookSecret: SEGREDO_WEBHOOK });
    const provedor = new Proxy(real, {
      get(alvo, prop, receiver) {
        if (prop !== 'refund') {
          const valor = Reflect.get(alvo, prop, receiver);
          return typeof valor === 'function' ? valor.bind(alvo) : valor;
        }
        return async (entrada: Parameters<PaymentProvider['refund']>[0]) => {
          const resultado = await alvo.refund(entrada);
          // O provedor afirma ter devolvido MENOS do que pedimos.
          return { ...resultado, amountCents: entrada.amountCents - 1 };
        };
      },
    }) as PaymentProvider;

    const ctx = cenario(FAKE_TOKENS.SUCCESS, provedor);
    await ctx.service.criarPagamento(ctx.input);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: ctx.orderId } });
    const valor = Math.floor(payment.capturedAmountCents / 3);

    await expect(
      ctx.service.reembolsar(pedidoDeReembolso(ctx.userId, payment.id, valor)),
    ).rejects.toBeInstanceOf(PaymentDomainError);

    // Nada contabilizado: registrar um numero que o dinheiro nao seguiu e pior
    // que falhar alto e deixar a divergencia visivel.
    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.refundedAmountCents).toBe(0);
  });

  it('CASO R13: estado desconhecido do provedor nao e tratado como sucesso', async () => {
    const real = new FakeProvider({ webhookSecret: SEGREDO_WEBHOOK });
    const provedor = new Proxy(real, {
      get(alvo, prop, receiver) {
        if (prop !== 'refund') {
          const valor = Reflect.get(alvo, prop, receiver);
          return typeof valor === 'function' ? valor.bind(alvo) : valor;
        }
        return async (entrada: Parameters<PaymentProvider['refund']>[0]) => {
          const resultado = await alvo.refund(entrada);
          // Estado fora do contrato: o tipo promete que nao acontece, mas o tipo
          // e promessa de compilacao e o adaptador real fala com a rede.
          return { ...resultado, state: 'ESTRANHO' } as unknown as typeof resultado;
        };
      },
    }) as PaymentProvider;

    const ctx = cenario(FAKE_TOKENS.SUCCESS, provedor);
    await ctx.service.criarPagamento(ctx.input);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: ctx.orderId } });
    const valor = Math.floor(payment.capturedAmountCents / 3);

    await expect(
      ctx.service.reembolsar(pedidoDeReembolso(ctx.userId, payment.id, valor)),
    ).rejects.toBeInstanceOf(PaymentDomainError);

    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.refundedAmountCents).toBe(0);
  });

  // R14/R15: a MESMA corrida do R11, em regimes onde o dobro do valor NAO
  // cabe no capturado. O R11 usa um terco, e so nesse regime a convergencia
  // por P2002 e alcancada: com valor acima de metade o CAS perde, o alvo
  // recalculado estoura o capturado e o endpoint devolve `divergencia` para um
  // estorno que DEU CERTO. Achado 4.1 da 2a rodada de review do PR #62.
  it.each([
    ['60% do capturado', 0.6],
    ['o total capturado', 1],
  ])('CASO R14/R15: webhook vence num reembolso de %s e o endpoint converge', async (_r, fracao) => {
    const webhook = new WebhookService({ prisma, tetoDeTentativas: 5, idadeMaximaMinutos: 60 });
    const real = new FakeProvider({ webhookSecret: SEGREDO_WEBHOOK });

    const provedor = new Proxy(real, {
      get(alvo, prop, receiver) {
        if (prop !== 'refund') {
          const valor = Reflect.get(alvo, prop, receiver);
          return typeof valor === 'function' ? valor.bind(alvo) : valor;
        }
        return async (entrada: Parameters<PaymentProvider['refund']>[0]) => {
          const resultado = await alvo.refund(entrada);
          const requisicao = alvo.construirWebhook({
            providerRef: entrada.providerRef,
            eventType: 'refund.succeeded',
            refundRef: resultado.providerRefundRef,
            providerEventId: `evt_${randomUUID()}`,
          });
          await webhook.processar('fake', alvo.verifyWebhook(requisicao));
          return resultado;
        };
      },
    }) as PaymentProvider;

    const ctx = cenario(FAKE_TOKENS.SUCCESS, provedor);
    await ctx.service.criarPagamento(ctx.input);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: ctx.orderId } });
    const valor = Math.floor(payment.capturedAmountCents * fracao);

    const r = await ctx.service.reembolsar(pedidoDeReembolso(ctx.userId, payment.id, valor));

    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.refundedAmountCents).toBe(valor);
    const sucedidas = (await linhasDeReembolso(payment.id)).filter(
      (l) => l.status === TransactionStatus.SUCCEEDED,
    );
    expect(sucedidas).toHaveLength(1);
    expect(r).toMatchObject({ tipo: 'aplicado', totalReembolsadoCents: valor });
  });

  // R16: o registro de idempotencia tem FK para Payment (onDelete: Restrict).
  // Gravar o paymentId no CLAIM — mudanca feita para atender o achado 4.1 —
  // faz um id inexistente estourar violacao de FK antes de a checagem de
  // existencia rodar, e o 404 fica inalcancavel. Achado 4.4 do revisor.
  it('CASO R16: pagamento inexistente e erro de dominio, nao falha de FK', async () => {
    const ctx = cenario(FAKE_TOKENS.SUCCESS);

    await expect(
      ctx.service.reembolsar(pedidoDeReembolso(ctx.userId, randomUUID(), 100)),
    ).rejects.toMatchObject({ code: 'PAGAMENTO_NAO_ENCONTRADO' });
  });

  // R17: referencia vazia colidiria no indice unico parcial e faria a
  // convergencia atribuir a linha de OUTRO estorno a este pedido.
  it('CASO R17: referencia de estorno vazia e recusada antes de qualquer ramo', async () => {
    const real = new FakeProvider({ webhookSecret: SEGREDO_WEBHOOK });
    const provedor = new Proxy(real, {
      get(alvo, prop, receiver) {
        if (prop !== 'refund') {
          const valor = Reflect.get(alvo, prop, receiver);
          return typeof valor === 'function' ? valor.bind(alvo) : valor;
        }
        return async (entrada: Parameters<PaymentProvider['refund']>[0]) => {
          const resultado = await alvo.refund(entrada);
          return { ...resultado, providerRefundRef: '   ' };
        };
      },
    }) as PaymentProvider;

    const ctx = cenario(FAKE_TOKENS.SUCCESS, provedor);
    await ctx.service.criarPagamento(ctx.input);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: ctx.orderId } });
    const valor = Math.floor(payment.capturedAmountCents / 3);

    await expect(
      ctx.service.reembolsar(pedidoDeReembolso(ctx.userId, payment.id, valor)),
    ).rejects.toBeInstanceOf(PaymentDomainError);

    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.refundedAmountCents).toBe(0);
    expect(await linhasDeReembolso(payment.id)).toHaveLength(0);
  });

  // R18: antes da 2a rodada a validacao vinha DEPOIS deste ramo, entao o
  // PROCESSING gravava uma tentativa com o valor que NOS pedimos, nunca
  // comparado com o que o provedor aceitou. Zero linhas e a prova.
  it('CASO R18: PROCESSING com valor divergente nao persiste tentativa', async () => {
    const real = new FakeProvider({ webhookSecret: SEGREDO_WEBHOOK });
    const provedor = new Proxy(real, {
      get(alvo, prop, receiver) {
        if (prop !== 'refund') {
          const valor = Reflect.get(alvo, prop, receiver);
          return typeof valor === 'function' ? valor.bind(alvo) : valor;
        }
        return async (entrada: Parameters<PaymentProvider['refund']>[0]) => {
          const resultado = await alvo.refund(entrada);
          return { ...resultado, state: 'PROCESSING', amountCents: entrada.amountCents - 1 } as typeof resultado;
        };
      },
    }) as PaymentProvider;

    const ctx = cenario(FAKE_TOKENS.SUCCESS, provedor);
    await ctx.service.criarPagamento(ctx.input);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: ctx.orderId } });
    const valor = Math.floor(payment.capturedAmountCents / 3);

    await expect(
      ctx.service.reembolsar(pedidoDeReembolso(ctx.userId, payment.id, valor)),
    ).rejects.toBeInstanceOf(PaymentDomainError);

    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.refundedAmountCents).toBe(0);
    expect(await linhasDeReembolso(payment.id)).toHaveLength(0);
  });

  // R19 existe porque a sonda X11 da bateria passou VAZIA: o `<= 0` do achado
  // 5.2 entrou sem prova. Um `aplicado` com total zero e impossivel — todo
  // reembolso aplicado moveu valor positivo.
  //
  // O caso faz um reembolso REAL antes de corromper o congelado. Montar o
  // registro a mao exigiria reproduzir a receita do fingerprint aqui, e um erro
  // nela faria o caso passar por IDEMPOTENCIA_CONFLITANTE — verde pelo motivo
  // errado, a mesma armadilha que o providerEventId explicito do R11 evita.
  it('CASO R19: snapshot com total ZERO nao volta como aplicado no replay', async () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { service, userId, payment } = await pagamentoCapturado();
    const pedido = pedidoDeReembolso(userId, payment.id, 1000);

    const primeira = await service.reembolsar(pedido);
    expect(primeira).toMatchObject({ tipo: 'aplicado' });

    const registro = await prisma.idempotencyRecord.findFirstOrThrow({
      where: { userId, key: pedido.idempotencyKey },
    });
    await prisma.idempotencyRecord.update({
      where: { id: registro.id },
      data: {
        completedResponse: {
          ...(registro.completedResponse as Record<string, unknown>),
          totalReembolsadoCents: 0,
        },
      },
    });

    await expect(service.reembolsar(pedido)).rejects.toMatchObject({
      code: 'DEPENDENCIA_INDISPONIVEL',
    });
    log.mockRestore();
  });

  // R20: dois estornos parciais do MESMO pagamento. Com eventId derivado do
  // paymentId, o segundo enqueue colidiria no @unique da outbox, a transacao
  // do efeito abortaria junto e o reembolso falharia. Este caso e a prova de
  // que a identidade escolhida (providerRefundRef) e a certa.
  it('CASO R20: cada estorno gera SEU proprio evento na outbox', async () => {
    const { service, userId, payment } = await pagamentoCapturado();
    const parte = Math.floor(payment.capturedAmountCents / 4);

    const a = await service.reembolsar(pedidoDeReembolso(userId, payment.id, parte));
    const b = await service.reembolsar(pedidoDeReembolso(userId, payment.id, parte));
    expect(a).toMatchObject({ tipo: 'aplicado' });
    expect(b).toMatchObject({ tipo: 'aplicado' });

    const eventos = await prisma.outboxEvent.findMany({
      where: { routingKey: 'payment.refunded' },
      orderBy: { createdAt: 'asc' },
    });
    expect(eventos).toHaveLength(2);
    expect(new Set(eventos.map((e) => e.eventId)).size).toBe(2);

    // Acumulado e delta sao numeros DIFERENTES, e o payload carrega os dois.
    // Se o produtor confundisse um com o outro, o segundo evento diria que o
    // pedido teve estornado `parte` no total, e nao `parte * 2`.
    const payloads = eventos.map((e) => e.payload as unknown as Record<string, number>);
    expect(payloads[0].refundAmountCents).toBe(parte);
    expect(payloads[0].refundedAmountCents).toBe(parte);
    expect(payloads[1].refundAmountCents).toBe(parte);
    expect(payloads[1].refundedAmountCents).toBe(parte * 2);
  });
});
