import { randomUUID } from 'node:crypto';

import {
  ChargeNotCancelableError,
  ChargeNotFoundError,
  PaymentProviderError,
  ProviderInvalidRequestError,
  WebhookSignatureError,
  type ChargeResult,
  type CreateChargeInput,
  type PaymentProvider,
  type WebhookEventPayload,
  type WebhookRequest,
} from '../../../src/providers/payment-provider.port';

/**
 * SUITE DE CONTRATO da porta PaymentProvider.
 *
 * Escrita contra a INTERFACE, nunca contra uma implementacao. Roda hoje contra
 * o FakeProvider e vai rodar no Bloco 9 contra a Stripe. Se ambos passarem, a
 * logica de negocio dos Blocos 3 a 8 nao precisa saber qual provedor esta ativo.
 *
 * Nada aqui inspeciona estado interno nem assume formato de providerRef: so o
 * comportamento observavel pela porta.
 *
 * Este arquivo NAO termina em .test.ts de proposito — e importado e invocado por
 * quem tem um kit, nao coletado direto pelo Jest.
 */

/**
 * Estreita um ChargeResult para a variante do estado esperado.
 * Necessario porque ChargeResult e uniao discriminada: declineCode so existe em
 * DECLINED, e o compilador exige o estreitamento antes do acesso — que e
 * exatamente a garantia que a uniao fornece.
 */
function exigirEstado<E extends ChargeResult['state']>(
  resultado: ChargeResult,
  estado: E,
): Extract<ChargeResult, { state: E }> {
  expect(resultado.state).toBe(estado);
  return resultado as Extract<ChargeResult, { state: E }>;
}

/**
 * Estreita um WebhookEventPayload para a variante do tipo esperado.
 * Exportado porque os testes especificos de cada adapter precisam do mesmo
 * estreitamento — providerRef e state so existem nas variantes suportadas.
 */
export function exigirEvento<E extends WebhookEventPayload['eventType']>(
  evento: WebhookEventPayload,
  tipo: E,
): Extract<WebhookEventPayload, { eventType: E }> {
  expect(evento.eventType).toBe(tipo);
  return evento as Extract<WebhookEventPayload, { eventType: E }>;
}

export interface KitDeContrato {
  nome: string;

  /** Instancia limpa por teste. */
  criar(): PaymentProvider;

  tokens: {
    sucesso: string;
    processando: string;
    recusado: string;
    desconhecido: string;
    /** Exigido quando capacidades.falhaTransiente e true. */
    erroTransiente?: string;
    /**
     * Exigido quando capacidades.falhaAmbigua e true.
     *
     * Token que CRIA a cobranca no provedor e SO ENTAO falha, simulando a
     * resposta perdida. E o unico cenario que o job de reconciliacao existe
     * para resolver, e um duble que nunca cria a cobranca nao consegue
     * representa-lo.
     */
    timeoutAposCobranca?: string;
  };

  /**
   * OBRIGATORIO. verifyWebhook e obrigatorio na porta, entao o contrato tem de
   * poder exercita-lo — antes isso era opcional e um adapter podia passar a
   * suite inteira sem nenhum teste de webhook.
   */
  assinarWebhook(
    provider: PaymentProvider,
    input: { providerRef: string; eventType: string },
  ): WebhookRequest;

  /**
   * Declaracao EXPLICITA do que este provedor nao consegue simular. Existe para
   * que um gap de cobertura seja decisao visivel em code review, e nao ausencia
   * silenciosa de teste. Ha um teste que confere se a declaracao bate com os
   * hooks entregues.
   */
  capacidades: {
    /** false quando nao ha como provocar falha transiente de forma deterministica. */
    falhaTransiente: boolean;
    /** false quando nao ha como avancar PROCESSING -> SUCCEEDED sob controle. */
    transicaoAssincrona: boolean;
    /**
     * false quando nao ha como simular "cobranca criada e resposta perdida".
     * Provedor real pode nao oferecer gatilho deterministico para isso.
     */
    falhaAmbigua: boolean;
  };

  /** Exigido quando capacidades.transicaoAssincrona e true. */
  simularSucesso?(provider: PaymentProvider, providerRef: string): WebhookRequest;
}

export function rodarContratoDeProvedor(kit: KitDeContrato): void {
  describe(`contrato de PaymentProvider — ${kit.nome}`, () => {
    let provider: PaymentProvider;

    beforeEach(() => {
      provider = kit.criar();
    });

    function entrada(overrides: Partial<CreateChargeInput> = {}): CreateChargeInput {
      return {
        amountCents: 12990,
        currency: 'BRL',
        paymentMethodToken: kit.tokens.sucesso,
        idempotencyKey: randomUUID(),
        reference: { paymentId: randomUUID(), orderId: randomUUID(), attemptCount: 1 },
        ...overrides,
      };
    }

    it('o kit declara capacidades coerentes com os hooks que forneceu', () => {
      expect(typeof kit.assinarWebhook).toBe('function');

      if (kit.capacidades.falhaTransiente) {
        expect(typeof kit.tokens.erroTransiente).toBe('string');
      }
      if (kit.capacidades.transicaoAssincrona) {
        expect(typeof kit.simularSucesso).toBe('function');
      }
      if (kit.capacidades.falhaAmbigua) {
        expect(typeof kit.tokens.timeoutAposCobranca).toBe('string');
      }
    });

    describe('buscarCobrancaPorTentativa', () => {
      it('devolve null quando o provedor nunca recebeu a cobranca', async () => {
        // null NAO e erro. E a informacao que autoriza o job a liberar a chave:
        // a chamada nunca chegou, entao refazer a tentativa nao duplica dinheiro.
        await expect(
          provider.buscarCobrancaPorTentativa(randomUUID(), 1),
        ).resolves.toBeNull();
      });

      it('encontra a cobranca criada, pela correlacao enviada no createCharge', async () => {
        const paymentId = randomUUID();
        const criada = await provider.createCharge(
          entrada({ reference: { paymentId, orderId: randomUUID(), attemptCount: 1 } }),
        );

        const achada = await provider.buscarCobrancaPorTentativa(paymentId, 1);

        expect(achada).not.toBeNull();
        expect(achada?.providerRef).toBe(criada.providerRef);
      });

      it('distingue TENTATIVAS diferentes do mesmo pagamento', async () => {
        // A janela de retentativa faz o MESMO Payment cobrar varias vezes. Uma
        // busca so por paymentId devolveria varias e obrigaria o job a escolher
        // qual e a dele — decisao que ninguem quer tomar com dinheiro no meio.
        const paymentId = randomUUID();
        const orderId = randomUUID();
        const primeira = await provider.createCharge(
          entrada({ reference: { paymentId, orderId, attemptCount: 1 } }),
        );
        const segunda = await provider.createCharge(
          entrada({ reference: { paymentId, orderId, attemptCount: 2 } }),
        );

        expect(primeira.providerRef).not.toBe(segunda.providerRef);
        expect((await provider.buscarCobrancaPorTentativa(paymentId, 1))?.providerRef).toBe(
          primeira.providerRef,
        );
        expect((await provider.buscarCobrancaPorTentativa(paymentId, 2))?.providerRef).toBe(
          segunda.providerRef,
        );
      });

      it('encontra a cobranca mesmo quando a RESPOSTA se perdeu', async () => {
        // O caso que justifica o job inteiro: o provedor cobrou, a resposta nao
        // voltou, e do nosso lado ficou uma tentativa PENDING sem providerRef.
        // Se a busca nao encontrasse aqui, o job nao teria como distinguir
        // "cobrou" de "nao cobrou" — e liberar a chave nesse estado e a receita
        // da segunda cobranca.
        if (!kit.capacidades.falhaAmbigua) return;
        const paymentId = randomUUID();

        await expect(
          provider.createCharge(
            entrada({
              paymentMethodToken: kit.tokens.timeoutAposCobranca as string,
              reference: { paymentId, orderId: randomUUID(), attemptCount: 1 },
            }),
          ),
        ).rejects.toBeInstanceOf(PaymentProviderError);

        const achada = await provider.buscarCobrancaPorTentativa(paymentId, 1);
        expect(achada).not.toBeNull();
      });
    });

    describe('createCharge', () => {
      it('captura na propria chamada com o token de sucesso', async () => {
        const r = exigirEstado(await provider.createCharge(entrada()), 'SUCCEEDED');

        expect(r.capturedAmountCents).toBe(12990);
        expect(typeof r.providerRef).toBe('string');
        expect(r.providerRef.length).toBeGreaterThan(0);
      });

      it('devolve PROCESSING quando a confirmacao vem so por webhook', async () => {
        const r = exigirEstado(
          await provider.createCharge(entrada({ paymentMethodToken: kit.tokens.processando })),
          'PROCESSING',
        );

        expect(r.capturedAmountCents).toBe(0);
      });

      it('RECUSA e resultado de negocio, nao excecao, e sempre traz declineCode', async () => {
        const r = exigirEstado(
          await provider.createCharge(entrada({ paymentMethodToken: kit.tokens.recusado })),
          'DECLINED',
        );

        expect(r.capturedAmountCents).toBe(0);
        expect(typeof r.declineCode).toBe('string');
        expect(r.declineCode.length).toBeGreaterThan(0);
      });

      it('rejeita token desconhecido em vez de suceder silenciosamente', async () => {
        await expect(
          provider.createCharge(entrada({ paymentMethodToken: kit.tokens.desconhecido })),
        ).rejects.toBeInstanceOf(ProviderInvalidRequestError);
      });

      it('IDEMPOTENCIA: mesma chave e mesmos parametros devolvem a mesma cobranca', async () => {
        const base = entrada();

        const primeira = await provider.createCharge(base);
        const segunda = await provider.createCharge({ ...base });

        expect(segunda).toEqual(primeira);
      });

      it('IDEMPOTENCIA: mesma chave com parametros DIFERENTES e erro', async () => {
        const idempotencyKey = randomUUID();
        await provider.createCharge(entrada({ idempotencyKey }));

        await expect(
          provider.createCharge(entrada({ idempotencyKey, amountCents: 999 })),
        ).rejects.toBeInstanceOf(ProviderInvalidRequestError);
      });

      it('IDEMPOTENCIA: replay tardio devolve o resultado ORIGINAL, mesmo apos mudanca de estado', async () => {
        const base = entrada({ paymentMethodToken: kit.tokens.processando });
        const primeira = await provider.createCharge(base);

        await provider.cancelCharge({
          providerRef: primeira.providerRef,
          idempotencyKey: randomUUID(),
        });

        // Reconstruir a resposta do estado ATUAL faria isto virar excecao ou
        // devolver CANCELED. Replay tem de ser estavel.
        const replay = await provider.createCharge({ ...base });
        expect(replay).toEqual(primeira);
      });

      it.each([
        ['amountCents', { amountCents: 999 }],
        ['paymentMethodToken', { paymentMethodToken: 'tok_outro_qualquer' }],
      ])(
        'IDEMPOTENCIA: divergencia em %s com a mesma chave e erro',
        async (_campo, override) => {
          const idempotencyKey = randomUUID();
          const base = entrada({ idempotencyKey });
          await provider.createCharge(base);

          await expect(
            provider.createCharge({ ...base, ...override }),
          ).rejects.toBeInstanceOf(ProviderInvalidRequestError);
        },
      );

      it.each(['paymentId', 'orderId'] as const)(
        'IDEMPOTENCIA: divergencia em reference.%s com a mesma chave e erro',
        async (campo) => {
          const idempotencyKey = randomUUID();
          const base = entrada({ idempotencyKey });
          await provider.createCharge(base);

          await expect(
            provider.createCharge({
              ...base,
              reference: { ...base.reference, [campo]: randomUUID() },
            }),
          ).rejects.toBeInstanceOf(ProviderInvalidRequestError);
        },
      );

      it('SO a chave diferente cria cobranca diferente — resto do input identico', async () => {
        const base = entrada();

        const a = await provider.createCharge({ ...base, idempotencyKey: randomUUID() });
        const b = await provider.createCharge({ ...base, idempotencyKey: randomUUID() });

        expect(b.providerRef).not.toBe(a.providerRef);
      });

      it.each([0, -1])('rejeita valor invalido (%i)', async (amountCents) => {
        await expect(provider.createCharge(entrada({ amountCents }))).rejects.toBeInstanceOf(
          ProviderInvalidRequestError,
        );
      });

      it('exige idempotencyKey', async () => {
        await expect(
          provider.createCharge(entrada({ idempotencyKey: '' })),
        ).rejects.toBeInstanceOf(ProviderInvalidRequestError);
      });
    });

    describe('getCharge', () => {
      it('devolve o retrato da cobranca criada', async () => {
        const criada = await provider.createCharge(entrada());
        const snapshot = await provider.getCharge(criada.providerRef);

        expect(snapshot.providerRef).toBe(criada.providerRef);
        expect(snapshot.state).toBe('SUCCEEDED');
        expect(snapshot.amountCents).toBe(12990);
        expect(snapshot.capturedAmountCents).toBe(12990);
        expect(snapshot.refundedAmountCents).toBe(0);
      });

      it('lanca ChargeNotFoundError para referencia inexistente', async () => {
        await expect(provider.getCharge('ref_que_nao_existe')).rejects.toBeInstanceOf(
          ChargeNotFoundError,
        );
      });
    });

    describe('cancelCharge', () => {
      async function emProcessamento(): Promise<string> {
        const r = await provider.createCharge(
          entrada({ paymentMethodToken: kit.tokens.processando }),
        );
        return r.providerRef;
      }

      it('cancela cobranca em PROCESSING', async () => {
        const ref = await emProcessamento();

        const snapshot = await provider.cancelCharge({
          providerRef: ref,
          idempotencyKey: randomUUID(),
        });

        expect(snapshot.state).toBe('CANCELED');
      });

      it('IDEMPOTENCIA: mesma chave devolve exatamente o mesmo resultado', async () => {
        const ref = await emProcessamento();
        const idempotencyKey = randomUUID();

        const primeira = await provider.cancelCharge({ providerRef: ref, idempotencyKey });
        const segunda = await provider.cancelCharge({ providerRef: ref, idempotencyKey });

        expect(segunda).toEqual(primeira);
      });

      it('IDEMPOTENCIA: mesma chave para OUTRA cobranca e erro', async () => {
        const primeiroRef = await emProcessamento();
        const segundoRef = await emProcessamento();
        const idempotencyKey = randomUUID();

        await provider.cancelCharge({ providerRef: primeiroRef, idempotencyKey });

        await expect(
          provider.cancelCharge({ providerRef: segundoRef, idempotencyKey }),
        ).rejects.toBeInstanceOf(ProviderInvalidRequestError);
      });

      it('cancelar de novo com chave NOVA tambem e no-op — idempotencia por estado', async () => {
        const ref = await emProcessamento();

        await provider.cancelCharge({ providerRef: ref, idempotencyKey: randomUUID() });
        const segunda = await provider.cancelCharge({
          providerRef: ref,
          idempotencyKey: randomUUID(),
        });

        expect(segunda.state).toBe('CANCELED');
      });

      it('recusa cancelar cobranca capturada — dinheiro se move por refund', async () => {
        const criada = await provider.createCharge(entrada());

        await expect(
          provider.cancelCharge({
            providerRef: criada.providerRef,
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toBeInstanceOf(ChargeNotCancelableError);
      });

      it('lanca ChargeNotFoundError para referencia inexistente', async () => {
        await expect(
          provider.cancelCharge({
            providerRef: 'ref_que_nao_existe',
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toBeInstanceOf(ChargeNotFoundError);
      });
    });

    describe('refund', () => {
      it('reembolsa o valor total', async () => {
        const criada = await provider.createCharge(entrada());

        const r = await provider.refund({
          providerRef: criada.providerRef,
          amountCents: 12990,
          idempotencyKey: randomUUID(),
        });

        expect(r.state).toBe('SUCCEEDED');
        expect(r.amountCents).toBe(12990);
        expect(typeof r.providerRefundRef).toBe('string');

        const snapshot = await provider.getCharge(criada.providerRef);
        expect(snapshot.refundedAmountCents).toBe(12990);
      });

      it('acumula reembolsos parciais ate o valor capturado', async () => {
        const criada = await provider.createCharge(entrada());
        const ref = criada.providerRef;

        await provider.refund({ providerRef: ref, amountCents: 5000, idempotencyKey: randomUUID() });
        await provider.refund({ providerRef: ref, amountCents: 7990, idempotencyKey: randomUUID() });

        const snapshot = await provider.getCharge(ref);
        expect(snapshot.refundedAmountCents).toBe(12990);
      });

      it('recusa reembolso acima do disponivel', async () => {
        const criada = await provider.createCharge(entrada());
        const ref = criada.providerRef;

        await provider.refund({ providerRef: ref, amountCents: 12000, idempotencyKey: randomUUID() });

        await expect(
          provider.refund({ providerRef: ref, amountCents: 991, idempotencyKey: randomUUID() }),
        ).rejects.toBeInstanceOf(ProviderInvalidRequestError);
      });

      it('IDEMPOTENCIA: mesma chave nao reembolsa duas vezes', async () => {
        const criada = await provider.createCharge(entrada());
        const ref = criada.providerRef;
        const idempotencyKey = randomUUID();

        const primeira = await provider.refund({ providerRef: ref, amountCents: 5000, idempotencyKey });
        const segunda = await provider.refund({ providerRef: ref, amountCents: 5000, idempotencyKey });

        expect(segunda).toEqual(primeira);

        const snapshot = await provider.getCharge(ref);
        expect(snapshot.refundedAmountCents).toBe(5000);
      });

      it('IDEMPOTENCIA: mesma chave com VALOR diferente e erro', async () => {
        const criada = await provider.createCharge(entrada());
        const ref = criada.providerRef;
        const idempotencyKey = randomUUID();

        await provider.refund({ providerRef: ref, amountCents: 5000, idempotencyKey });

        await expect(
          provider.refund({ providerRef: ref, amountCents: 1000, idempotencyKey }),
        ).rejects.toBeInstanceOf(ProviderInvalidRequestError);
      });

      it('recusa reembolsar cobranca que nao foi capturada', async () => {
        const criada = await provider.createCharge(
          entrada({ paymentMethodToken: kit.tokens.processando }),
        );

        await expect(
          provider.refund({
            providerRef: criada.providerRef,
            amountCents: 100,
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toBeInstanceOf(ProviderInvalidRequestError);
      });

      it('lanca ChargeNotFoundError para referencia inexistente', async () => {
        await expect(
          provider.refund({
            providerRef: 'ref_que_nao_existe',
            amountCents: 100,
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toBeInstanceOf(ChargeNotFoundError);
      });
    });

    describe('taxonomia de erro', () => {
      (kit.capacidades.falhaTransiente ? it : it.skip)(
        'falha transiente vem marcada como retryable',
        async () => {
          let capturado: unknown;

          try {
            await provider.createCharge(
              entrada({ paymentMethodToken: kit.tokens.erroTransiente as string }),
            );
          } catch (erro) {
            capturado = erro;
          }

          expect(capturado).toBeInstanceOf(PaymentProviderError);
          expect((capturado as PaymentProviderError).retryable).toBe(true);
        },
      );

      it('falha por requisicao invalida NAO e retryable', async () => {
        let capturado: unknown;

        try {
          await provider.createCharge(entrada({ amountCents: -1 }));
        } catch (erro) {
          capturado = erro;
        }

        expect(capturado).toBeInstanceOf(ProviderInvalidRequestError);
        expect((capturado as PaymentProviderError).retryable).toBe(false);
      });
    });

    describe('verifyWebhook', () => {
      it('verifica e traduz um webhook valido', async () => {
        const criada = await provider.createCharge(entrada());
        const request = kit.assinarWebhook(provider, {
          providerRef: criada.providerRef,
          eventType: 'payment.succeeded',
        });

        const evento = exigirEvento(provider.verifyWebhook(request), 'payment.succeeded');

        expect(evento.providerRef).toBe(criada.providerRef);
        expect(typeof evento.providerEventId).toBe('string');
        expect(evento.providerEventId.length).toBeGreaterThan(0);
        // O tipo BRUTO tem de sobreviver: e ele que vai para a coluna eventType
        // do inbox, e gravar o nosso rotulo perderia informacao de triagem.
        expect(evento.providerEventTypeBruto).toBe('payment.succeeded');
      });

      it('recusa quando o corpo foi alterado apos a assinatura', async () => {
        const criada = await provider.createCharge(entrada());
        const request = kit.assinarWebhook(provider, {
          providerRef: criada.providerRef,
          eventType: 'payment.succeeded',
        });

        // Classe ESPECIFICA, nao toThrow() generico: um adapter que parseasse o
        // corpo antes de verificar a assinatura lancaria outro erro e ainda
        // passaria no teste generico.
        expect(() =>
          provider.verifyWebhook({
            ...request,
            rawBody: Buffer.concat([request.rawBody, Buffer.from(' ')]),
          }),
        ).toThrow(WebhookSignatureError);
      });

      it('recusa quando nao ha cabecalho de assinatura', async () => {
        const criada = await provider.createCharge(entrada());
        const request = kit.assinarWebhook(provider, {
          providerRef: criada.providerRef,
          eventType: 'payment.succeeded',
        });

        expect(() => provider.verifyWebhook({ ...request, headers: {} })).toThrow(
          WebhookSignatureError,
        );
      });
    });

    (kit.capacidades.transicaoAssincrona ? describe : describe.skip)(
      'transicao assincrona PROCESSING -> SUCCEEDED',
      () => {
        it('o webhook e o snapshot ficam coerentes depois da confirmacao', async () => {
          const criada = exigirEstado(
            await provider.createCharge(entrada({ paymentMethodToken: kit.tokens.processando })),
            'PROCESSING',
          );

          const antes = await provider.getCharge(criada.providerRef);
          expect(antes.state).toBe('PROCESSING');
          expect(antes.capturedAmountCents).toBe(0);

          const simular = kit.simularSucesso as NonNullable<KitDeContrato['simularSucesso']>;
          const request = simular(provider, criada.providerRef);

          const evento = exigirEvento(provider.verifyWebhook(request), 'payment.succeeded');
          expect(evento.providerRef).toBe(criada.providerRef);

          // A confirmacao tem de aparecer TAMBEM na fonte da verdade — senao o
          // provedor teria duas versoes do mesmo fato.
          const depois = await provider.getCharge(criada.providerRef);
          expect(depois.state).toBe('SUCCEEDED');
          expect(depois.capturedAmountCents).toBe(12990);
        });
      },
    );
  });
}
