import type { OutboxEvent } from '@prisma/client';
import {
  startOutboxRelay,
  stopOutboxRelay,
  tick,
  type RelayDeps,
} from '../../../src/events/outbox.relay';

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

    // Sem .catch: o tick nao pode rejeitar (ele trata internamente), e engolir a
    // rejeicao esconderia justamente a regressao que faria isso mudar.
    // `fetchPending` e chamado sincronamente ate o primeiro await, entao
    // `liberar` ja esta preenchido aqui.
    const primeiro = tick(d);
    const segundo = tick(d); // entra com o primeiro ainda em voo
    (liberar as unknown as (v: OutboxEvent[]) => void)([evento('ev_1')]);
    await Promise.all([primeiro, segundo]);

    expect(fetchPending).toHaveBeenCalledTimes(1);
  });
});

describe('outbox relay — tamanho do lote', () => {
  it('CASO A6: usa o lote injetado', async () => {
    const d = deps({ lote: 7 });
    await tick(d);
    expect(d.fetchPending).toHaveBeenCalledWith(7);
  });

  it('CASO A7: OUTBOX_BATCH da env realmente afeta o lote padrao', async () => {
    // O knob estava documentado no .env.example e nunca era lido: o operador
    // configurava e o lote continuava 20 (apontado no review do PR #54).
    const anterior = process.env.OUTBOX_BATCH;
    process.env.OUTBOX_BATCH = '3';
    try {
      jest.resetModules();
      const modulo = await import('../../../src/events/outbox.relay');
      const d = deps();
      await modulo.tick(d as unknown as Parameters<typeof modulo.tick>[0]);
      expect(d.fetchPending).toHaveBeenCalledWith(3);
    } finally {
      if (anterior === undefined) delete process.env.OUTBOX_BATCH;
      else process.env.OUTBOX_BATCH = anterior;
      jest.resetModules();
    }
  });
});

describe('outbox relay — caminho de SUCESSO', () => {
  it('CASO A8: publish confirmado marca SENT e nao registra retry', async () => {
    // Sem este caso, remover o markSent nao derrubaria nada: os outros so
    // cobrem falha, broker fora e reentrada.
    const d = deps();
    await tick(d);
    expect(d.markSent).toHaveBeenCalledWith('ev_1');
    expect(d.markRetry).not.toHaveBeenCalled();
  });
});

describe('outbox relay — ciclo de vida', () => {
  afterEach(async () => {
    await stopOutboxRelay();
    jest.useRealTimers();
  });

  it('CASO A9: start roda um ciclo e AGENDA o proximo', async () => {
    jest.useFakeTimers();
    const d = deps({ fetchPending: jest.fn(async () => []) });

    startOutboxRelay(d);
    await jest.advanceTimersByTimeAsync(0);
    expect(d.fetchPending).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1000);
    expect(d.fetchPending).toHaveBeenCalledTimes(2);
  });

  it('CASO A10: stop impede que novos ciclos sejam agendados', async () => {
    jest.useFakeTimers();
    const d = deps({ fetchPending: jest.fn(async () => []) });

    startOutboxRelay(d);
    await jest.advanceTimersByTimeAsync(0);
    await stopOutboxRelay();

    const antes = (d.fetchPending as jest.Mock).mock.calls.length;
    await jest.advanceTimersByTimeAsync(5000);
    expect((d.fetchPending as jest.Mock).mock.calls.length).toBe(antes);
  });

  it('CASO A11: dois start seguidos criam UM laco, nao dois', async () => {
    // Uma reconexao agendada coincidindo com um start manual chamaria start
    // duas vezes. Sem a guarda `iniciado`, cada chamada agenda o proprio timer e
    // o relay passa a rodar dois ciclos por intervalo — cada um publicando o
    // mesmo lote (o tick concorrente e no-op, mas so dentro do MESMO ciclo).
    jest.useFakeTimers();
    const d = deps({ fetchPending: jest.fn(async () => []) });

    startOutboxRelay(d);
    startOutboxRelay(d);
    await jest.advanceTimersByTimeAsync(0);
    expect(d.fetchPending).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1000);
    expect(d.fetchPending).toHaveBeenCalledTimes(2);
  });

  it('CASO A12: stop AGUARDA o ciclo em voo terminar antes de resolver', async () => {
    // Encerrar no meio de uma publicacao deixaria o evento SENT sem confirm
    // (ou confirmado sem marca). O stop precisa esperar o tick que ja comecou.
    jest.useFakeTimers();
    let liberar!: (ok: boolean) => void;
    const d = deps({
      publish: jest.fn(() => new Promise<boolean>((r) => { liberar = r; })),
    });

    startOutboxRelay(d);
    await jest.advanceTimersByTimeAsync(0); // tick em voo, parado no publish

    let parou = false;
    const parada = stopOutboxRelay().then(() => { parou = true; });
    await jest.advanceTimersByTimeAsync(1000); // abaixo do teto de 5000
    expect(parou).toBe(false);
    expect(d.markSent).not.toHaveBeenCalled();

    liberar(true);
    await parada;
    expect(parou).toBe(true);
    expect(d.markSent).toHaveBeenCalledTimes(1);
  });

  it('CASO A13: tick PENDURADO nao segura o shutdown alem do teto — evento fica PENDING', async () => {
    // Politica declarada no stop: broker travado nao pode pendurar o
    // encerramento; o evento fica PENDING e sai no proximo boot (at-least-once).
    jest.useFakeTimers();
    const aviso = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let liberar!: (ok: boolean) => void;
    const d = deps({
      publish: jest.fn(() => new Promise<boolean>((r) => { liberar = r; })),
    });

    startOutboxRelay(d);
    await jest.advanceTimersByTimeAsync(0);

    let parou = false;
    const parada = stopOutboxRelay().then(() => { parou = true; });
    await jest.advanceTimersByTimeAsync(4999);
    expect(parou).toBe(false);
    await jest.advanceTimersByTimeAsync(1); // STOP_TIMEOUT_MS = 5000 (default, lido no import)
    await parada;

    expect(parou).toBe(true);
    expect(aviso).toHaveBeenCalledWith(expect.stringContaining('nao terminou em 5000ms'));
    // Nenhuma marca: o evento segue PENDING para o proximo boot.
    expect(d.markSent).not.toHaveBeenCalled();
    expect(d.markRetry).not.toHaveBeenCalled();

    // Libera o tick pendurado para o afterEach nao esperar um teto que os fake
    // timers nunca avancariam. Depois do stop, o tick que termina nao reagenda.
    liberar(true);
    await jest.advanceTimersByTimeAsync(0);
    aviso.mockRestore();
  });
});
