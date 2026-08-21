import type { OutboxEvent } from '@prisma/client';
import { tick, type RelayDeps } from '../../../src/events/outbox.relay';

function evento(id: string): OutboxEvent {
  return {
    id,
    eventId: 'payment.captured:' + id,
    routingKey: 'payment.captured',
    payload: {},
    status: 'PENDING',
    attempts: 0,
    lastError: null,
    createdAt: new Date('2026-08-20T12:00:00.000Z'),
    sentAt: null,
  } as unknown as OutboxEvent;
}

function deps(overrides: Partial<RelayDeps> = {}): RelayDeps {
  return {
    isPublisherReady: jest.fn(() => true),
    initEventPublisher: jest.fn(async () => undefined),
    publish: jest.fn(async () => true),
    fetchPending: jest.fn(async () => [evento('ev_1')]),
    markSent: jest.fn(async () => undefined),
    markRetry: jest.fn(async () => undefined),
    ...overrides,
  };
}

describe('outbox relay — um ciclo', () => {
  it('CASO A1: publish que falha mantem o evento PENDING (markRetry, nunca markSent)', async () => {
    // markSent antes do confirm quebraria o at-least-once: o evento sumiria da
    // fila de pendentes sem ter chegado ao broker.
    const d = deps({ publish: jest.fn(async () => false) });

    await tick(d);

    expect(d.markRetry).toHaveBeenCalledTimes(1);
    expect(d.markSent).not.toHaveBeenCalled();
  });

  it('CASO A2: broker fora NAO toca nos eventos', async () => {
    // Falha transitoria do broker nao pode penalizar attempts nem marcar nada:
    // isso empurraria eventos saudaveis para a quarentena do Bloco 6.
    const d = deps({
      isPublisherReady: jest.fn(() => false),
      initEventPublisher: jest.fn(async () => { throw new Error('broker fora'); }),
    });

    await expect(tick(d)).resolves.toBeUndefined();

    expect(d.fetchPending).not.toHaveBeenCalled();
    expect(d.markRetry).not.toHaveBeenCalled();
    expect(d.markSent).not.toHaveBeenCalled();
  });

  it('CASO A3: tick concorrente e no-op — nao publica o mesmo evento duas vezes', async () => {
    let liberar: ((v: OutboxEvent[]) => void) | null = null;
    const fetchPending = jest.fn(
      () => new Promise<OutboxEvent[]>((r) => { liberar = r; }),
    );
    const d = deps({ fetchPending });

    // .catch aqui NAO e complacencia com falha: e para o teste FALHAR em vez de
    // matar o runner. Sem ele, uma rejeicao nao tratada derruba o processo do
    // Node e leva junto os outros casos do arquivo.
    const primeiro = tick(d).catch(() => undefined);
    const segundo = tick(d).catch(() => undefined); // entra com o primeiro em voo
    if (liberar !== null) {
      (liberar as (v: OutboxEvent[]) => void)([evento('ev_1')]);
    }
    await Promise.all([primeiro, segundo]);

    expect(fetchPending).toHaveBeenCalledTimes(1);
  });
});
