import { PaymentStatus } from '@prisma/client';

import type { PagamentoCriado } from '../../src/services/payment.service';

/**
 * Fonte UNICA da forma de PagamentoCriado nos testes.
 *
 * Mesma motivacao do configDeTeste: campo novo na resposta toca UM lugar em vez
 * de N arquivos de teste.
 */
export function pagamentoCriadoDeTeste(
  overrides: Partial<PagamentoCriado> = {},
): PagamentoCriado {
  return {
    paymentId: 'pay_1',
    orderId: 'ord_1',
    status: PaymentStatus.CAPTURED,
    amountCents: 12990,
    capturedAmountCents: 12990,
    currency: 'BRL',
    attemptCount: 1,
    replay: false,
    ...overrides,
  };
}
