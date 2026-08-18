import type {
  ChargeResult,
  CreateChargeInput,
  PaymentProvider,
} from '../../src/providers/payment-provider.port';

/**
 * Provedor stub, para cenarios que o FakeProvider por definicao NAO produz.
 *
 * O FakeProvider e bem comportado: nunca devolve SUCCEEDED com valor capturado
 * diferente do cobrado, nem lanca Error generico. Justamente por isso ele nao
 * serve para testar como NOS reagimos a um adapter defeituoso — e o adapter da
 * Stripe do Bloco 9 e codigo que ainda nao existe.
 */
export function providerStub(
  createCharge: (input: CreateChargeInput) => Promise<ChargeResult>,
): PaymentProvider {
  return {
    name: 'stub',
    createCharge: jest.fn(createCharge),
    getCharge: jest.fn(),
    cancelCharge: jest.fn(),
    refund: jest.fn(),
    verifyWebhook: jest.fn(),
  } as unknown as PaymentProvider;
}
