jest.mock('amqplib', () => ({
  connect: jest.fn(),
}));

// Knobs sao lidos no import: encurtar aqui evita esperar os defaults.
process.env.RABBITMQ_URL = 'amqp://localhost:5672';
process.env.PAYMENTS_RECONNECT_DELAY_MS = '100';
process.env.PAYMENTS_REQUEUE_DELAY_MS = '50';

type Runtime = typeof import('../src/events/payments.runtime');
type Handler = (...a: unknown[]) => unknown;

/**
 * O runtime guarda a sessao em estado de MODULO (divida registrada). Cada caso
 * precisa de um registro limpo, entao tudo e recarregado apos resetModules —
 * o que tambem recria o mock do amqplib, e por isso o connect vem daqui.
 */
function carregar(): { mod: Runtime; connect: jest.Mock } {
  jest.resetModules();
  const amqpMod = require('amqplib') as { connect: jest.Mock };
  amqpMod.connect.mockReset();
  const mod = require('../src/events/payments.runtime') as Runtime;
  return { mod, connect: amqpMod.connect };
}

function canalFalso(over: Record<string, unknown> = {}) {
  const handlers: Record<string, Handler> = {};
  return {
    handlers,
    assertExchange: jest.fn(async (_n: string, _t: string, _o: object) => undefined),
    assertQueue: jest.fn(async (_n: string, _o: object) => undefined),
    bindQueue: jest.fn(async (_f: string, _e: string, _c: string) => undefined),
    prefetch: jest.fn(async (_n: number) => undefined),
    consume: jest.fn(async (_fila: string, _cb: (m: unknown) => void) => ({ consumerTag: 't' })),
    close: jest.fn(async () => undefined),
    on: jest.fn((evento: string, h: Handler) => {
      handlers[evento] = h;
    }),
    ack: jest.fn(),
    nack: jest.fn(),
    ...over,
  };
}

function conexaoFalsa(canal: unknown, over: Record<string, unknown> = {}) {
  const handlers: Record<string, Handler> = {};
  return {
    handlers,
    createChannel: jest.fn(async () => canal),
    close: jest.fn(async () => undefined),
    on: jest.fn((evento: string, h: Handler) => {
      handlers[evento] = h;
    }),
    ...over,
  };
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('sessao do consumidor — perda e recuperacao', () => {
  it('CASO C25: close do CANAL invalida a sessao', async () => {
    // Ha listener de close so na conexao. Se o canal fechar sozinho, `canal`
    // continua nao-nulo, toda nova chamada de inicio retorna de imediato, e o
    // consumo fica permanentemente parado com o HTTP saudavel — parada
    // silenciosa, que e o pior modo de falha deste servico.
    const ch = canalFalso();
    const { mod, connect } = carregar();
    connect.mockResolvedValue(conexaoFalsa(ch));

    await mod.iniciarConsumidorPagamentos();
    expect(mod.estaConsumindo()).toBe(true);

    expect(ch.handlers['close']).toBeDefined();
    ch.handlers['close']?.();

    expect(mod.estaConsumindo()).toBe(false);
    await mod.pararConsumidorPagamentos();
  });

  it('CASO C26: cancelamento do consumer pelo broker invalida a sessao', async () => {
    // msg === null significa que o broker cancelou a assinatura. Apenas
    // retornar deixa a sessao "ativa" sem ninguem consumindo.
    const ch = canalFalso();
    const { mod, connect } = carregar();
    connect.mockResolvedValue(conexaoFalsa(ch));

    await mod.iniciarConsumidorPagamentos();
    expect(mod.estaConsumindo()).toBe(true);

    const callback = ch.consume.mock.calls[0][1] as (m: unknown) => void;
    callback(null);

    expect(mod.estaConsumindo()).toBe(false);
    await mod.pararConsumidorPagamentos();
  });
});

describe('sessao do consumidor — aquisicao e encerramento', () => {
  it('CASO C27: falha no meio do setup fecha o que ja foi adquirido', async () => {
    // Canal e conexao ja existem quando a topologia falha. Sem fechar, cada
    // ciclo de retry vaza uma conexao AMQP.
    const ch = canalFalso({
      assertQueue: jest.fn(async () => {
        throw new Error('topologia incompativel');
      }),
    });
    const cx = conexaoFalsa(ch);
    const { mod, connect } = carregar();
    connect.mockResolvedValue(cx);

    await mod.iniciarConsumidorPagamentos();

    expect(mod.estaConsumindo()).toBe(false);
    expect(ch.close).toHaveBeenCalled();
    expect(cx.close).toHaveBeenCalled();
    await mod.pararConsumidorPagamentos();
  });

  it('CASO C28: encerrar durante a conexao em voo nao deixa consumidor ativo', async () => {
    // Se o shutdown correr enquanto amqp.connect esta pendente, a conexao que
    // termina depois publicaria a sessao num processo ja encerrado.
    const ch = canalFalso();
    const cx = conexaoFalsa(ch);
    const { mod, connect } = carregar();
    let liberar = (_v: unknown): void => undefined;
    connect.mockImplementation(
      () => new Promise((r) => {
        liberar = r as (v: unknown) => void;
      }),
    );

    const emVoo = mod.iniciarConsumidorPagamentos().catch(() => undefined);
    await mod.pararConsumidorPagamentos();
    liberar(cx);
    await emVoo;

    expect(mod.estaConsumindo()).toBe(false);
    expect(cx.close).toHaveBeenCalled();
  });

  it('CASO C29: dois inicios concorrentes abrem UMA conexao', async () => {
    // Sem single-flight, uma reconexao agendada coincidindo com um inicio
    // manual abre duas conexoes e a referencia global fica com uma orfa.
    const ch = canalFalso();
    const { mod, connect } = carregar();
    connect.mockResolvedValue(conexaoFalsa(ch));

    await Promise.all([
      mod.iniciarConsumidorPagamentos(),
      mod.iniciarConsumidorPagamentos(),
    ]);

    expect(connect).toHaveBeenCalledTimes(1);
    await mod.pararConsumidorPagamentos();
  });
});
