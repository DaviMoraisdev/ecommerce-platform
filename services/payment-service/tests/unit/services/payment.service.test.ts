import { createHash } from 'node:crypto';

import { PaymentStatus, TransactionStatus, TransactionType } from '@prisma/client';

import { FakeProvider } from '../../../src/providers/fake/fake.provider';
import { FAKE_TOKENS } from '../../../src/providers/fake/fake.tokens';
import {
  PaymentService,
  type CriarPagamentoInput,
} from '../../../src/services/payment.service';
import {
  type PedidoDoOrder,
  OrderIndisponivelError,
  OrderNaoAutorizadoError,
  OrderNaoEncontradoError,
  OrderRespostaInvalidaError,
} from '../../../src/clients/order.client';
import { SEGREDO_WEBHOOK } from '../../helpers/config';
import { providerStub } from '../../helpers/provider-stub';
import {
  AGORA,
  chaveMarcadaFalhada,
  comoPrisma,
  erroP2002,
  orderClientFalso,
  paymentDeTeste,
  pedidoDeTeste,
  prismaFalso,
  type PrismaFalso,
} from '../../helpers/prisma-fake';

/**
 * O provedor NAO e duble: e o FakeProvider real.
 *
 * Ele ja cobre sucesso, processamento assincrono, recusa de negocio e as tres
 * falhas tecnicas, e e a mesma implementacao que a suite de contrato exercita.
 * Um duble de createCharge me deixaria inventar formas de resultado que o
 * provedor real nunca produz — que e como se escreve teste que passa contra o
 * duble e falha contra a Stripe.
 */
function montar(
  overrides: {
    pedido?: PedidoDoOrder;
    prisma?: PrismaFalso;
    buscarPedido?: jest.Mock;
  } = {},
) {
  const falso = overrides.prisma ?? prismaFalso();
  const buscarPedido =
    overrides.buscarPedido ?? jest.fn(async () => overrides.pedido ?? pedidoDeTeste());
  const provider = new FakeProvider({ webhookSecret: SEGREDO_WEBHOOK });
  const espiaoCharge = jest.spyOn(provider, 'createCharge');

  const service = new PaymentService({
    prisma: comoPrisma(falso),
    orderClient: orderClientFalso(buscarPedido),
    provider,
    currency: 'BRL',
    windowMinutes: 15,
    now: () => AGORA,
  });

  return { service, falso, buscarPedido, provider, espiaoCharge };
}

function entrada(overrides: Partial<CriarPagamentoInput> = {}): CriarPagamentoInput {
  return {
    userId: 'usr_1',
    authorization: 'Bearer token.do.usuario',
    orderId: 'ord_1',
    paymentMethodToken: FAKE_TOKENS.SUCCESS,
    idempotencyKey: 'idem_http_1',
    ...overrides,
  };
}

// ============================================================
// Ordem das operacoes — a decisao central do bloco
// ============================================================

describe('criarPagamento — ordem das operacoes', () => {
  it('reivindica a chave, busca o pedido e persiste o rastro ANTES de chamar o provedor', async () => {
    const { service, falso, buscarPedido, espiaoCharge } = montar();

    await service.criarPagamento(entrada());

    const ordemDe = (m: jest.Mock | jest.SpyInstance) => m.mock.invocationCallOrder[0];

    expect(ordemDe(falso.idempotencyRecord.create)).toBeLessThan(ordemDe(buscarPedido));
    expect(ordemDe(buscarPedido)).toBeLessThan(ordemDe(falso.paymentTransaction.create));
    // O CORACAO: rastro no banco antes de qualquer efeito externo. Invertido,
    // uma queda de processo produziria cobranca feita sem nada para reconciliar.
    expect(ordemDe(falso.paymentTransaction.create)).toBeLessThan(ordemDe(espiaoCharge));
  });

  it('repassa o cabecalho Authorization BRUTO ao order-service', async () => {
    const { service, buscarPedido } = montar();

    await service.criarPagamento(entrada());

    expect(buscarPedido).toHaveBeenCalledWith('ord_1', 'Bearer token.do.usuario');
  });

  it('NAO chama o provedor quando a busca do pedido falha', async () => {
    const { service, falso, espiaoCharge } = montar({
      buscarPedido: jest.fn(async () => {
        throw new OrderNaoEncontradoError();
      }),
    });

    await expect(service.criarPagamento(entrada())).rejects.toMatchObject({
      code: 'PEDIDO_NAO_ENCONTRADO',
    });

    expect(espiaoCharge).not.toHaveBeenCalled();
    expect(chaveMarcadaFalhada(falso)).toBe(true);
  });

  it('NAO chama o provedor quando o valor do pedido nao fecha', async () => {
    // subtotal 12990 mas total 9990: soma dos subtotais != total.
    const { service, falso, espiaoCharge } = montar({
      pedido: pedidoDeTeste({ totalCents: 9990 }),
    });

    await expect(service.criarPagamento(entrada())).rejects.toMatchObject({
      code: 'VALOR_DO_PEDIDO_INVALIDO',
    });

    expect(espiaoCharge).not.toHaveBeenCalled();
    expect(chaveMarcadaFalhada(falso)).toBe(true);
  });

  it('NAO chama o provedor quando o pedido nao esta PENDENTE', async () => {
    const { service, espiaoCharge } = montar({
      pedido: pedidoDeTeste({ status: 'CANCELADO' }),
    });

    await expect(service.criarPagamento(entrada())).rejects.toMatchObject({
      code: 'PEDIDO_NAO_COBRAVEL',
    });

    expect(espiaoCharge).not.toHaveBeenCalled();
  });
});

// ============================================================
// Checagem de posse
// ============================================================

describe('criarPagamento — posse do pedido', () => {
  it('recusa pedido de outro usuario com a MESMA mensagem de inexistente', async () => {
    const { service, falso, espiaoCharge } = montar({
      pedido: pedidoDeTeste({ userId: 'usr_outro' }),
    });

    // Um token ADMIN traz o pedido de qualquer um, porque o getOne do order
    // libera ADMIN. Sem esta checagem, um admin criaria cobranca no pedido de
    // terceiro. A mensagem e identica a de "nao encontrado" para nao revelar
    // que o pedido existe.
    await expect(service.criarPagamento(entrada())).rejects.toMatchObject({
      code: 'PEDIDO_NAO_ENCONTRADO',
      message: 'Pedido nao encontrado',
    });

    expect(espiaoCharge).not.toHaveBeenCalled();
    expect(chaveMarcadaFalhada(falso)).toBe(true);
  });
});

// ============================================================
// Idempotencia claim-first
// ============================================================

describe('criarPagamento — idempotencia', () => {
  /**
   * DUPLICA a receita do fingerprint de proposito.
   *
   * Mesma razao da tabela de status duplicada no teste do controller: se alguem
   * trocar o algoritmo em producao sem pensar, esta copia discorda e o teste
   * quebra. Importar a funcao do servico concordaria com qualquer mudanca.
   */
  function fingerprintDe(orderId: string): string {
    return createHash('sha256').update(`v1:${orderId}`).digest('hex');
  }

  function comColisao(registro: Record<string, unknown> | null) {
    const falso = prismaFalso();
    falso.idempotencyRecord.create.mockRejectedValue(erroP2002());
    // O registro existente precisa carregar o fingerprint da MESMA requisicao,
    // senao todo teste de colisao cairia no ramo de conflito.
    falso.idempotencyRecord.findUnique.mockResolvedValue(
      registro === null ? null : { requestFingerprint: fingerprintDe('ord_1'), ...registro },
    );
    return falso;
  }

  it('review 4.4 — recusa a MESMA chave usada para outro pedido', async () => {
    const falso = comColisao({
      id: 'rec_1',
      status: 'COMPLETED',
      paymentId: 'pay_1',
      requestFingerprint: fingerprintDe('ord_OUTRO'),
    });
    const { service, espiaoCharge } = montar({ prisma: falso });

    // Sem esta checagem o cliente recebia 200 com o pagamento do pedido ANTERIOR
    // — silenciosamente, sem nenhum sinal de que a chave estava sendo reusada.
    await expect(service.criarPagamento(entrada())).rejects.toMatchObject({
      code: 'IDEMPOTENCIA_CONFLITANTE',
      retryable: false,
    });
    expect(espiaoCharge).not.toHaveBeenCalled();
  });

  it('review 4.4 — o conflito e detectado ANTES do ramo de status', async () => {
    // Registro em PROCESSING daria IDEMPOTENCIA_EM_ANDAMENTO; com fingerprint
    // divergente, o conflito tem precedencia, porque a requisicao e outra.
    const falso = comColisao({
      id: 'rec_1',
      status: 'PROCESSING',
      paymentId: null,
      requestFingerprint: fingerprintDe('ord_OUTRO'),
    });
    const { service } = montar({ prisma: falso });

    await expect(service.criarPagamento(entrada())).rejects.toMatchObject({
      code: 'IDEMPOTENCIA_CONFLITANTE',
    });
  });

  it('devolve replay sem novo efeito quando a chave ja foi COMPLETED', async () => {
    // O congelado e DELIBERADAMENTE diferente do Payment vivo: se o codigo
    // voltar a ler o vivo, este teste cai. Com valores iguais ele passaria dos
    // dois jeitos e nao provaria nada.
    const falso = comColisao({
      id: 'rec_1',
      status: 'COMPLETED',
      paymentId: 'pay_1',
      completedResponse: {
        paymentId: 'pay_1',
        orderId: 'ord_1',
        status: PaymentStatus.FAILED,
        amountCents: 12990,
        capturedAmountCents: 0,
        currency: 'BRL',
        attemptCount: 1,
        declineCode: 'insufficient_funds',
      },
    });
    falso.payment.findUnique.mockResolvedValue({
      ...paymentDeTeste({ status: PaymentStatus.CAPTURED, capturedAmountCents: 12990 }),
      transactions: [{ failureCode: null }],
    });
    const { service, espiaoCharge } = montar({ prisma: falso });

    const resultado = await service.criarPagamento(entrada());

    expect(resultado.replay).toBe(true);
    expect(resultado.status).toBe(PaymentStatus.FAILED);
    expect(resultado.capturedAmountCents).toBe(0);
    expect(resultado.declineCode).toBe('insufficient_funds');
    // Caminho congelado nao precisa do Payment: nem consulta.
    expect(falso.payment.findUnique).not.toHaveBeenCalled();
    // O ponto da idempotencia: repetir a chave NAO cobra de novo.
    expect(espiaoCharge).not.toHaveBeenCalled();
  });

  it('recusa chave que ja foi usada numa requisicao FAILED, sem retentativa', async () => {
    const falso = comColisao({ id: 'rec_1', status: 'FAILED', paymentId: null });
    const { service, espiaoCharge } = montar({ prisma: falso });

    await expect(service.criarPagamento(entrada())).rejects.toMatchObject({
      code: 'IDEMPOTENCIA_JA_FALHOU',
      retryable: false,
    });
    expect(espiaoCharge).not.toHaveBeenCalled();
  });

  it('devolve erro RETENTAVEL quando outra requisicao com a chave esta em andamento', async () => {
    const falso = comColisao({ id: 'rec_1', status: 'PROCESSING', paymentId: null });
    const { service } = montar({ prisma: falso });

    await expect(service.criarPagamento(entrada())).rejects.toMatchObject({
      code: 'IDEMPOTENCIA_EM_ANDAMENTO',
      retryable: true,
    });
  });

  it('trata como retentavel a corrida em que o registro desaparece entre create e findUnique', async () => {
    const { service } = montar({ prisma: comColisao(null) });

    await expect(service.criarPagamento(entrada())).rejects.toMatchObject({
      code: 'IDEMPOTENCIA_EM_ANDAMENTO',
      retryable: true,
    });
  });

  it('falha de forma explicita quando a chave COMPLETED aponta para pagamento inexistente', async () => {
    // completedResponse null: registro anterior a migration do Bloco 6a, entao
    // o replay cai no ramo LEGADO que reconstroi a partir do Payment vivo.
    const falso = comColisao({
      id: 'rec_1',
      status: 'COMPLETED',
      paymentId: 'pay_sumiu',
      completedResponse: null,
    });
    falso.payment.findUnique.mockResolvedValue(null);
    const { service } = montar({ prisma: falso });

    // Estado impossivel pelo CHECK do banco. Se acontecer, e melhor falhar alto
    // do que cobrar de novo silenciosamente.
    await expect(service.criarPagamento(entrada())).rejects.toMatchObject({
      code: 'DEPENDENCIA_INDISPONIVEL',
    });
  });

  it('propaga erro de banco que NAO e violacao de unique', async () => {
    const falso = prismaFalso();
    falso.idempotencyRecord.create.mockRejectedValue(new Error('conexao caiu'));
    const { service } = montar({ prisma: falso });

    await expect(service.criarPagamento(entrada())).rejects.toThrow('conexao caiu');
  });
});

// ============================================================
// Chave de idempotencia do provedor
// ============================================================

describe('criarPagamento — chave enviada ao provedor', () => {
  it('deriva a chave de paymentId e numero da tentativa, NAO da chave HTTP', async () => {
    const { service, espiaoCharge } = montar();

    await service.criarPagamento(entrada({ idempotencyKey: 'idem_http_1' }));

    expect(espiaoCharge).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'pay_1:1' }),
    );
    // Reusar a chave HTTP devolveria a resposta da PRIMEIRA tentativa, e o
    // cliente nunca conseguiria trocar de cartao dentro da janela.
    expect(espiaoCharge).not.toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'idem_http_1' }),
    );
  });

  it('muda a chave do provedor na segunda tentativa do mesmo Payment', async () => {
    const falso = prismaFalso();
    falso.payment.findUnique.mockResolvedValue(
      paymentDeTeste({ status: PaymentStatus.FAILED, attemptCount: 1 }),
    );
    const { service, espiaoCharge } = montar({ prisma: falso });

    await service.criarPagamento(entrada());

    expect(espiaoCharge).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'pay_1:2' }),
    );
  });
});

// ============================================================
// Janela de retentativa
// ============================================================

describe('criarPagamento — nova tentativa sobre Payment existente', () => {
  function comPaymentExistente(overrides: Parameters<typeof paymentDeTeste>[0]) {
    const falso = prismaFalso();
    falso.payment.findUnique.mockResolvedValue(paymentDeTeste(overrides));
    return falso;
  }

  it('recusa quando o pedido ja foi pago', async () => {
    const { service } = montar({
      prisma: comPaymentExistente({ status: PaymentStatus.CAPTURED }),
    });

    await expect(service.criarPagamento(entrada())).rejects.toMatchObject({
      code: 'PEDIDO_JA_PAGO',
      retryable: false,
    });
  });

  it('recusa como RETENTAVEL quando ha tentativa em andamento', async () => {
    const { service } = montar({
      prisma: comPaymentExistente({ status: PaymentStatus.PROCESSING }),
    });

    await expect(service.criarPagamento(entrada())).rejects.toMatchObject({
      code: 'TENTATIVA_EM_ANDAMENTO',
      retryable: true,
    });
  });

  it.each([PaymentStatus.EXPIRED, PaymentStatus.CANCELED, PaymentStatus.AUTHORIZED])(
    'recusa nova tentativa quando o Payment esta em %s',
    async (status) => {
      const { service } = montar({ prisma: comPaymentExistente({ status }) });

      await expect(service.criarPagamento(entrada())).rejects.toMatchObject({
        code: 'JANELA_EXPIRADA',
      });
    },
  );

  it('recusa quando a janela expirou, mesmo com status que permitiria retentativa', async () => {
    const { service } = montar({
      prisma: comPaymentExistente({
        status: PaymentStatus.FAILED,
        expiresAt: new Date(AGORA.getTime() - 1000),
      }),
    });

    // Checagem defensiva: o job de expiracao do Bloco 6 pode nao ter rodado
    // ainda, e o status no banco continuaria FAILED.
    await expect(service.criarPagamento(entrada())).rejects.toMatchObject({
      code: 'JANELA_EXPIRADA',
    });
  });

  it('traduz colisao de orderId em erro de dominio, nao em erro cru do Prisma', async () => {
    const falso = prismaFalso();
    falso.payment.create.mockRejectedValue(erroP2002());
    const { service } = montar({ prisma: falso });

    // Duas requisicoes para o mesmo pedido com chaves DIFERENTES passam as duas
    // checagens de idempotencia e colidem no @unique de orderId. Sem traducao,
    // o Prisma subia cru e o cliente recebia 500.
    //
    // retryable TRUE desde a correcao do achado 4.5: nada financeiro aconteceu,
    // entao a claim e LIBERADA e repetir a mesma chave funciona de verdade.
    // Antes era `false` porque a chave era queimada — a decisao estava presa a
    // uma limitacao que deixou de existir.
    await expect(service.criarPagamento(entrada())).rejects.toMatchObject({
      code: 'TENTATIVA_EM_ANDAMENTO',
      retryable: true,
    });
    expect(chaveMarcadaFalhada(falso)).toBe(false);
    expect(falso.idempotencyRecord.delete).toHaveBeenCalled();
  });

  it('recusa como RETENTAVEL quando o compare-and-swap da tentativa PERDE', async () => {
    const falso = prismaFalso();
    falso.payment.findUnique.mockResolvedValue(
      paymentDeTeste({ status: PaymentStatus.FAILED, attemptCount: 1 }),
    );
    // count 0 = outra requisicao reivindicou a tentativa entre o nosso findUnique
    // e o nosso update. E o cenario do achado 4.1 visto de dentro.
    falso.payment.updateMany.mockResolvedValue({ count: 0 });
    const { service, espiaoCharge } = montar({ prisma: falso });

    await expect(service.criarPagamento(entrada())).rejects.toMatchObject({
      code: 'TENTATIVA_EM_ANDAMENTO',
      retryable: true,
    });

    // O provedor NAO pode ser chamado: e exatamente a segunda cobranca que o CAS
    // existe para impedir.
    expect(espiaoCharge).not.toHaveBeenCalled();
  });

  it('recusa quando o total do pedido mudou entre tentativas', async () => {
    const { service, espiaoCharge } = montar({
      prisma: comPaymentExistente({ status: PaymentStatus.FAILED, amountCents: 9990 }),
    });

    // Cobrar valor diferente do registrado seria silencioso e grave.
    await expect(service.criarPagamento(entrada())).rejects.toMatchObject({
      code: 'VALOR_DO_PEDIDO_INVALIDO',
    });
    expect(espiaoCharge).not.toHaveBeenCalled();
  });
});

// ============================================================
// Desfecho
// ============================================================

describe('criarPagamento — desfecho de sucesso', () => {
  it('captura, registra as DUAS transacoes e conclui a chave', async () => {
    const { service, falso } = montar();

    const resultado = await service.criarPagamento(entrada());

    expect(resultado).toMatchObject({
      status: PaymentStatus.CAPTURED,
      amountCents: 12990,
      capturedAmountCents: 12990,
      replay: false,
    });

    // Captura automatica: o provedor autoriza E captura na mesma chamada, entao
    // a trilha precisa das duas etapas. So o AUTHORIZE deixaria a auditoria
    // incompleta.
    expect(falso.paymentTransaction.create).toHaveBeenCalledTimes(2);
    expect(falso.paymentTransaction.create.mock.calls[0][0].data).toMatchObject({
      type: TransactionType.AUTHORIZE,
      status: TransactionStatus.PENDING,
    });
    expect(falso.paymentTransaction.create.mock.calls[1][0].data).toMatchObject({
      type: TransactionType.CAPTURE,
      status: TransactionStatus.SUCCEEDED,
      amountCents: 12990,
    });

    const chamadas = falso.idempotencyRecord.update.mock.calls;
    // toEqual ESTRITO de proposito: pega campo novo vazando para dentro da
    // resposta congelada. Ela vai para o banco e e devolvida ao cliente em todo
    // replay, entao o que entra ali precisa ser deliberado, nunca herdado.
    // Note a AUSENCIA de declineCode: no caminho de sucesso a chave nao existe,
    // porque JSON nao representa undefined e gravar null mudaria a forma do
    // objeto entre uma tentativa recusada e uma bem-sucedida.
    expect(chamadas[chamadas.length - 1][0].data).toEqual({
      status: 'COMPLETED',
      completedResponse: {
        paymentId: 'pay_1',
        orderId: 'ord_1',
        status: PaymentStatus.CAPTURED,
        amountCents: 12990,
        capturedAmountCents: 12990,
        currency: 'BRL',
        attemptCount: 1,
      },
    });
  });

  it('grava o provider e a moeda vindos das dependencias', async () => {
    const { service, falso } = montar();

    await service.criarPagamento(entrada());

    expect(falso.payment.create.mock.calls[0][0].data).toMatchObject({
      provider: 'fake',
      currency: 'BRL',
      attemptCount: 1,
    });
  });
});

describe('criarPagamento — recusa de negocio', () => {
  it('trata recusa como RESULTADO, nao como excecao, e expoe o declineCode', async () => {
    const { service, falso } = montar();

    const resultado = await service.criarPagamento(
      entrada({ paymentMethodToken: FAKE_TOKENS.DECLINED_INSUFFICIENT_FUNDS }),
    );

    // Recusa e resposta normal do negocio: o cliente precisa saber o motivo
    // para trocar de cartao. Excecao aqui perderia a informacao.
    expect(resultado.status).toBe(PaymentStatus.FAILED);
    expect(resultado.declineCode).toBe('insufficient_funds');
    expect(falso.paymentTransaction.update.mock.calls[0][0].data).toMatchObject({
      status: TransactionStatus.FAILED,
      failureCode: 'insufficient_funds',
    });
    // Sem transacao de CAPTURE: nada foi capturado.
    expect(falso.paymentTransaction.create).toHaveBeenCalledTimes(1);
  });
});

describe('criarPagamento — confirmacao assincrona', () => {
  it('deixa o pagamento em PROCESSING quando o provedor confirma so por webhook', async () => {
    const { service, falso } = montar();

    const resultado = await service.criarPagamento(
      entrada({ paymentMethodToken: FAKE_TOKENS.PROCESSING }),
    );

    expect(resultado.status).toBe(PaymentStatus.PROCESSING);
    expect(falso.paymentTransaction.update.mock.calls[0][0].data).toMatchObject({
      status: TransactionStatus.PENDING,
    });
    expect(falso.paymentTransaction.create).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// Falha do provedor — o ponto de cobranca dupla
// ============================================================

describe('criarPagamento — falha TRANSIENTE do provedor', () => {
  it('NAO marca nada como falhado, para nao abrir caminho a segunda cobranca', async () => {
    const { service, falso } = montar();

    await expect(
      service.criarPagamento(entrada({ paymentMethodToken: FAKE_TOKENS.ERROR_UNAVAILABLE })),
    ).rejects.toMatchObject({ code: 'DEPENDENCIA_INDISPONIVEL', retryable: true });

    // ESTE e o teste mais importante do arquivo.
    //
    // Timeout ou 5xx significa "a RESPOSTA se perdeu", nao "o efeito nao
    // aconteceu": o dinheiro pode ter saido. Marcar a transacao e a chave como
    // FAILED liberaria nova tentativa, com attemptCount + 1 e portanto chave de
    // provedor NOVA — o provedor trataria como cobranca DIFERENTE e cobraria de
    // novo.
    //
    // Deixando PENDING sem providerRef, o job do Bloco 6 encontra o rastro e
    // reconcilia repetindo createCharge com a MESMA chave derivada.
    expect(falso.paymentTransaction.update).not.toHaveBeenCalled();
    expect(chaveMarcadaFalhada(falso)).toBe(false);
  });
});

describe('criarPagamento — falha DETERMINISTICA do provedor', () => {
  it('marca transacao e chave como FAILED quando a requisicao e invalida', async () => {
    const { service, falso } = montar();

    await expect(
      service.criarPagamento(entrada({ paymentMethodToken: FAKE_TOKENS.ERROR_INVALID })),
    ).rejects.toMatchObject({ code: 'REQUISICAO_INVALIDA', retryable: false });

    // O provedor recusou ANTES de mover dinheiro. Marcar FAILED e seguro e
    // libera o cliente para corrigir.
    expect(falso.paymentTransaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: TransactionStatus.FAILED }),
      }),
    );
    expect(chaveMarcadaFalhada(falso)).toBe(true);

    // O CAS deixou o Payment em PROCESSING antes da chamada. Sem devolve-lo a
    // FAILED, uma chave nova encontra PROCESSING e recebe TENTATIVA_EM_ANDAMENTO
    // para sempre — o pedido fica impagavel ate a reconciliacao do Bloco 6.
    expect(falso.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: PaymentStatus.FAILED }),
      }),
    );
  });

  it('marca FAILED quando a credencial do provedor e invalida', async () => {
    const { service, falso } = montar();

    await expect(
      service.criarPagamento(
        entrada({ paymentMethodToken: FAKE_TOKENS.ERROR_AUTHENTICATION }),
      ),
    ).rejects.toMatchObject({ code: 'DEPENDENCIA_INDISPONIVEL', retryable: false });

    // Retryable FALSE de proposito: repetir com a mesma credencial errada nunca
    // vai funcionar. E problema nosso de configuracao, nao do cliente.
    expect(chaveMarcadaFalhada(falso)).toBe(true);
  });
});

// ============================================================
// REGRESSOES DOS ACHADOS DO REVIEW DO PR #52
//
// Cada um destes testes falhou antes da correcao correspondente e foi validado
// por sabotagem depois dela. Nao descrevem defeito presente: descrevem defeito
// que nao pode voltar.
// ============================================================

describe('review 4.2 — erro DESCONHECIDO do provedor deve ser AMBIGUO', () => {
  it('NAO marca nada como falhado quando o erro nao e classificado', async () => {
    const falso = prismaFalso();
    const service = new PaymentService({
      prisma: comoPrisma(falso),
      orderClient: orderClientFalso(jest.fn(async () => pedidoDeTeste())),
      // Error generico: pode ter sido lancado DEPOIS de o provedor receber a
      // cobranca (bug no adapter, falha ao desserializar a resposta). O dinheiro
      // pode ter se movido.
      provider: providerStub(async () => {
        throw new Error('falha inesperada no adapter');
      }),
      currency: 'BRL',
      windowMinutes: 15,
      now: () => AGORA,
    });

    await expect(service.criarPagamento(entrada())).rejects.toThrow(
      'falha inesperada no adapter',
    );

    // Fail-closed exige ALLOWLIST: so classes comprovadamente anteriores ao
    // efeito financeiro liberam nova tentativa. Hoje o codigo usa denylist
    // (so retryable e ambiguo), entao desconhecido vira FAILED e abre caminho
    // para SEGUNDA COBRANCA.
    expect(falso.paymentTransaction.update).not.toHaveBeenCalled();
    expect(chaveMarcadaFalhada(falso)).toBe(false);
  });
});

describe('review 4.3 — valor capturado precisa casar com o autorizado', () => {
  it('NAO conclui a chave quando o provedor captura valor diferente do cobrado', async () => {
    const falso = prismaFalso();
    const service = new PaymentService({
      prisma: comoPrisma(falso),
      orderClient: orderClientFalso(jest.fn(async () => pedidoDeTeste())),
      provider: providerStub(async () => ({
        state: 'SUCCEEDED',
        providerRef: 'ch_stub_1',
        capturedAmountCents: 9990, // pedido vale 12990
        refundedAmountCents: 0,
      }) as never),
      currency: 'BRL',
      windowMinutes: 15,
      now: () => AGORA,
    });

    // O CHECK payment_captured_dentro_do_total barra captura ACIMA do total.
    // Captura PARCIAL passa pelo banco: o pagamento viraria CAPTURED com menos
    // dinheiro do que o pedido, silenciosamente.
    await expect(service.criarPagamento(entrada())).rejects.toBeDefined();

    const concluiuAChave = falso.idempotencyRecord.update.mock.calls.some(
      ([arg]) => (arg as { data?: { status?: string } })?.data?.status === 'COMPLETED',
    );
    expect(concluiuAChave).toBe(false);
  });
});

describe('review 5.1 — a causa da falha do order chega ao LOG, nao ao cliente', () => {
  it('registra orderId e motivo no servidor, sem vazar nada na excecao', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { service } = montar({
      buscarPedido: jest.fn(async () => {
        throw new OrderIndisponivelError('ECONNREFUSED');
      }),
    });

    const erro = await service.criarPagamento(entrada()).catch((e) => e);

    // Para o operador: causa e pedido, para a investigacao comecar em algum
    // lugar. O campo `motivo` era calculado e nunca consumido.
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('order-service indisponivel'),
      { orderId: 'ord_1', motivo: 'ECONNREFUSED' },
    );

    // Para o cliente: nem a causa, nem o nome do servico interno.
    expect(erro.message).not.toContain('ECONNREFUSED');
    expect(erro.message).not.toContain('order-service');

    // E o log NAO pode carregar o token do usuario.
    const tudoQueFoiLogado = JSON.stringify(spy.mock.calls);
    expect(tudoQueFoiLogado).not.toContain('Bearer');
    expect(tudoQueFoiLogado).not.toContain('token.do.usuario');

    spy.mockRestore();
  });
});

describe('review 4.5 — falha RETENTAVEL do order nao pode queimar a chave', () => {
  it('libera a claim em vez de marcar FAILED quando o order esta indisponivel', async () => {
    const { service, falso } = montar({
      buscarPedido: jest.fn(async () => {
        throw new OrderIndisponivelError('HTTP 503');
      }),
    });

    await expect(service.criarPagamento(entrada())).rejects.toMatchObject({
      code: 'DEPENDENCIA_INDISPONIVEL',
      retryable: true,
    });

    // Contradicao de contrato: o controller manda Retry-After, mas repetir a
    // MESMA chave encontra FAILED e devolve IDEMPOTENCIA_JA_FALHOU. Nada
    // financeiro aconteceu, entao a claim deve ser LIBERADA.
    expect(chaveMarcadaFalhada(falso)).toBe(false);
    expect(falso.idempotencyRecord.delete).toHaveBeenCalledWith({
      where: { id: 'rec_1' },
    });
  });

  it('CONTINUA queimando a chave quando a falha do order e definitiva', async () => {
    const { service, falso } = montar({
      buscarPedido: jest.fn(async () => {
        throw new OrderNaoEncontradoError();
      }),
    });

    await expect(service.criarPagamento(entrada())).rejects.toMatchObject({
      code: 'PEDIDO_NAO_ENCONTRADO',
    });

    // Repetir a mesma requisicao nunca vai funcionar: queimar e correto.
    expect(chaveMarcadaFalhada(falso)).toBe(true);
  });
});

// ============================================================
// Traducao dos erros do order-service
// ============================================================

describe('criarPagamento — traducao de erro do order', () => {
  // Rotulo, codigo e retryable ANTES do erro: os %s do titulo consomem os
  // argumentos em ordem, e com o Error no meio o titulo sai ilegivel.
  // O destino da claim passou a depender da CLASSE da falha (achado 4.5):
  // retentavel libera, definitiva queima. A tabela precisa expressar isso, senao
  // volta a afirmar comportamento uniforme que nao existe mais.
  const CASOS: Array<[string, string, boolean, 'liberada' | 'queimada', Error]> = [
    ['nao encontrado', 'PEDIDO_NAO_ENCONTRADO', false, 'queimada', new OrderNaoEncontradoError()],
    ['nao autorizado', 'NAO_AUTORIZADO', false, 'queimada', new OrderNaoAutorizadoError()],
    ['indisponivel', 'DEPENDENCIA_INDISPONIVEL', true, 'liberada', new OrderIndisponivelError('HTTP 503')],
    [
      'resposta invalida',
      'DEPENDENCIA_INDISPONIVEL',
      false,
      'queimada',
      new OrderRespostaInvalidaError('corpo nao e JSON valido'),
    ],
  ];

  it.each(CASOS)(
    '%s -> %s (retryable=%s, claim %s)',
    async (_rotulo, code, retryable, destinoDaClaim, erroDoOrder) => {
      const { service, falso } = montar({
        buscarPedido: jest.fn(async () => {
          throw erroDoOrder;
        }),
      });

      await expect(service.criarPagamento(entrada())).rejects.toMatchObject({
        code,
        retryable,
      });

      if (destinoDaClaim === 'liberada') {
        expect(falso.idempotencyRecord.delete).toHaveBeenCalled();
        expect(chaveMarcadaFalhada(falso)).toBe(false);
      } else {
        expect(chaveMarcadaFalhada(falso)).toBe(true);
        expect(falso.idempotencyRecord.delete).not.toHaveBeenCalled();
      }
    },
  );
});

describe('criarPagamento — evento de captura na outbox', () => {
  it('enfileira payment.captured na MESMA transacao do desfecho', async () => {
    // Sem esta assercao, os seis casos acima voltariam ao verde so por o duble
    // ter ganhado a propriedade — nenhum deles afirma que o evento foi
    // enfileirado. Verde por preenchimento de duble nao e cobertura.
    const { service, falso } = montar({});

    await service.criarPagamento(entrada());

    expect(falso.outboxEvent.create).toHaveBeenCalledTimes(1);
    const args = falso.outboxEvent.create.mock.calls[0][0] as {
      data: { eventId: string; routingKey: string; payload: Record<string, unknown> };
    };
    expect(args.data.routingKey).toBe('payment.captured');
    expect(args.data.eventId).toBe('payment.captured:' + String(args.data.payload.paymentId));
  });
});
