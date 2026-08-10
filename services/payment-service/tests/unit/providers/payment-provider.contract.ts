import { randomUUID } from 'node:crypto';

import {
  ChargeNotFoundError,
  PaymentProviderError,
  ProviderInvalidRequestError,
  type CreateChargeInput,
  type PaymentProvider,
  type WebhookRequest,
} from '../../../src/providers/payment-provider.port';

/**
 * SUITE DE CONTRATO da porta PaymentProvider.
 *
 * Escrita contra a INTERFACE, nunca contra uma implementacao. Roda hoje contra
 * o FakeProvider e vai rodar no Bloco 9 contra a Stripe. Se ambos passarem, a
 * logica de negocio dos Blocos 3 a 8 nao precisa saber qual provedor esta ativo.
 *
 * Por isso nada aqui inspeciona estado interno nem assume formato de
 * providerRef: so o comportamento observavel pela porta.
 *
 * Este arquivo NAO termina em .test.ts de proposito — ele e importado e
 * invocado por quem tem um kit, nao coletado direto pelo Jest.
 */

export interface KitDeContrato {
  nome: string;

  /** Instancia limpa por teste. */
  criar(): PaymentProvider;

  tokens: {
    sucesso: string;
    processando: string;
    recusado: string;
    desconhecido: string;
    /** Opcional: token que provoca falha TECNICA transiente. */
    erroTransiente?: string;
  };

  /**
   * Opcional: como o provedor fabrica um webhook assinado valido.
   * Nao faz parte da porta (nao e capacidade de runtime), mas sem isso o
   * contrato nao pode exercitar verifyWebhook.
   */
  assinarWebhook?: (
    provider: PaymentProvider,
    input: { providerRef: string; eventType: string },
  ) => WebhookRequest;
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
        reference: { paymentId: randomUUID(), orderId: randomUUID() },
        ...overrides,
      };
    }

    describe('createCharge', () => {
      it('captura na propria chamada com o token de sucesso', async () => {
        const r = await provider.createCharge(entrada());

        expect(r.state).toBe('SUCCEEDED');
        expect(r.capturedAmountCents).toBe(12990);
        expect(typeof r.providerRef).toBe('string');
        expect(r.providerRef.length).toBeGreaterThan(0);
        expect(r.declineCode).toBeUndefined();
      });

      it('devolve PROCESSING quando a confirmacao vem so por webhook', async () => {
        const r = await provider.createCharge(
          entrada({ paymentMethodToken: kit.tokens.processando }),
        );

        expect(r.state).toBe('PROCESSING');
        expect(r.capturedAmountCents).toBe(0);
      });

      it('RECUSA e resultado de negocio, nao excecao', async () => {
        const r = await provider.createCharge(
          entrada({ paymentMethodToken: kit.tokens.recusado }),
        );

        expect(r.state).toBe('DECLINED');
        expect(r.capturedAmountCents).toBe(0);
        expect(typeof r.declineCode).toBe('string');
      });

      it('rejeita token desconhecido em vez de suceder silenciosamente', async () => {
        await expect(
          provider.createCharge(entrada({ paymentMethodToken: kit.tokens.desconhecido })),
        ).rejects.toBeInstanceOf(ProviderInvalidRequestError);
      });

      it('IDEMPOTENCIA: mesma chave e mesmos parametros devolvem a mesma cobranca', async () => {
        const idempotencyKey = randomUUID();
        const base = entrada({ idempotencyKey });

        const primeira = await provider.createCharge(base);
        const segunda = await provider.createCharge({ ...base });

        expect(segunda.providerRef).toBe(primeira.providerRef);
        expect(segunda.state).toBe(primeira.state);
      });

      it('IDEMPOTENCIA: mesma chave com parametros DIFERENTES e erro', async () => {
        const idempotencyKey = randomUUID();
        await provider.createCharge(entrada({ idempotencyKey }));

        await expect(
          provider.createCharge(entrada({ idempotencyKey, amountCents: 999 })),
        ).rejects.toBeInstanceOf(ProviderInvalidRequestError);
      });

      it('chaves diferentes criam cobrancas diferentes', async () => {
        const a = await provider.createCharge(entrada());
        const b = await provider.createCharge(entrada());

        expect(b.providerRef).not.toBe(a.providerRef);
      });

      it.each([0, -1])('rejeita valor invalido (%i)', async (amountCents) => {
        await expect(
          provider.createCharge(entrada({ amountCents })),
        ).rejects.toBeInstanceOf(ProviderInvalidRequestError);
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
      it('cancela cobranca em PROCESSING', async () => {
        const criada = await provider.createCharge(
          entrada({ paymentMethodToken: kit.tokens.processando }),
        );

        const snapshot = await provider.cancelCharge({
          providerRef: criada.providerRef,
          idempotencyKey: randomUUID(),
        });

        expect(snapshot.state).toBe('CANCELED');
      });

      it('cancelar duas vezes e no-op idempotente', async () => {
        const criada = await provider.createCharge(
          entrada({ paymentMethodToken: kit.tokens.processando }),
        );
        const ref = criada.providerRef;

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
        ).rejects.toBeInstanceOf(ProviderInvalidRequestError);
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

        await provider.refund({
          providerRef: ref,
          amountCents: 5000,
          idempotencyKey: randomUUID(),
        });
        await provider.refund({
          providerRef: ref,
          amountCents: 7990,
          idempotencyKey: randomUUID(),
        });

        const snapshot = await provider.getCharge(ref);
        expect(snapshot.refundedAmountCents).toBe(12990);
      });

      it('recusa reembolso acima do disponivel', async () => {
        const criada = await provider.createCharge(entrada());
        const ref = criada.providerRef;

        await provider.refund({
          providerRef: ref,
          amountCents: 12000,
          idempotencyKey: randomUUID(),
        });

        await expect(
          provider.refund({ providerRef: ref, amountCents: 991, idempotencyKey: randomUUID() }),
        ).rejects.toBeInstanceOf(ProviderInvalidRequestError);
      });

      it('IDEMPOTENCIA: mesma chave nao reembolsa duas vezes', async () => {
        const criada = await provider.createCharge(entrada());
        const ref = criada.providerRef;
        const idempotencyKey = randomUUID();

        await provider.refund({ providerRef: ref, amountCents: 5000, idempotencyKey });
        const segunda = await provider.refund({
          providerRef: ref,
          amountCents: 5000,
          idempotencyKey,
        });

        expect(segunda.amountCents).toBe(5000);

        const snapshot = await provider.getCharge(ref);
        expect(snapshot.refundedAmountCents).toBe(5000);
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
      const temTokenTransiente = Boolean(kit.tokens.erroTransiente);

      (temTokenTransiente ? it : it.skip)(
        'falha transiente vem marcada como retryable',
        async () => {
          try {
            await provider.createCharge(
              entrada({ paymentMethodToken: kit.tokens.erroTransiente as string }),
            );
            throw new Error('esperava falha tecnica');
          } catch (erro) {
            expect(erro).toBeInstanceOf(PaymentProviderError);
            expect((erro as PaymentProviderError).retryable).toBe(true);
          }
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

    // describe.skip em vez de omitir: o output mostra que os casos existem e
    // estao pulados, em vez de eles simplesmente nao aparecerem.
    (kit.assinarWebhook ? describe : describe.skip)('verifyWebhook', () => {
      const assinar = kit.assinarWebhook as NonNullable<KitDeContrato['assinarWebhook']>;

      it('verifica e traduz um webhook valido', async () => {
        const criada = await provider.createCharge(entrada());
        const request = assinar(provider, {
          providerRef: criada.providerRef,
          eventType: 'payment.succeeded',
        });

        const evento = provider.verifyWebhook(request);

        expect(evento.eventType).toBe('payment.succeeded');
        expect(evento.providerRef).toBe(criada.providerRef);
        expect(typeof evento.providerEventId).toBe('string');
      });

      it('recusa quando o corpo foi alterado apos a assinatura', async () => {
        const criada = await provider.createCharge(entrada());
        const request = assinar(provider, {
          providerRef: criada.providerRef,
          eventType: 'payment.succeeded',
        });

        const adulterado = {
          ...request,
          rawBody: Buffer.concat([request.rawBody, Buffer.from(' ')]),
        };

        expect(() => provider.verifyWebhook(adulterado)).toThrow();
      });

      it('recusa quando nao ha cabecalho de assinatura', async () => {
        const criada = await provider.createCharge(entrada());
        const request = assinar(provider, {
          providerRef: criada.providerRef,
          eventType: 'payment.succeeded',
        });

        expect(() => provider.verifyWebhook({ ...request, headers: {} })).toThrow();
      });
    });
  });
}
