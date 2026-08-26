jest.mock('amqplib', () => ({
  connect: jest.fn(),
}));

// Knobs sao lidos no import: encurtar aqui evita esperar os defaults.
process.env.RABBITMQ_URL = 'amqp://localhost:5672';
process.env.PAYMENTS_CONSUMER_ENABLED = 'true';
process.env.PAYMENTS_RECONNECT_DELAY_MS = '100';
process.env.PAYMENTS_REQUEUE_DELAY_MS = '50';
// Curto para o C35: a abertura pendurada precisa terminar DENTRO do teste,
// senao o log do deadline sai depois que o jest ja fechou o caso.
process.env.PAYMENTS_OPEN_TIMEOUT_MS = '200';

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

describe('ativacao', () => {
  it('CASO C40: consumidor fica DESLIGADO por padrao', async () => {
    // Superficie que altera estado financeiro a partir de mensagem nao
    // autenticada nao pode subir por omissao.
    // NAO usa `delete`. Apagar a variavel cria a condicao que autoriza o
    // dotenv.config() do database.ts — importado em cadeia pelo runtime — a
    // preencher a partir do .env da maquina, porque sem `override` o dotenv so
    // define o que AINDA NAO existe. O delete, que parecia neutro, era o que
    // reintroduzia PAYMENTS_CONSUMER_ENABLED=true e ligava o consumidor.
    // Atribuir vazio testa a mesma coisa e nao depende do .env de ninguem.
    process.env.PAYMENTS_CONSUMER_ENABLED = '';
    const { mod, connect } = carregar();
    connect.mockResolvedValue(conexaoFalsa(canalFalso()));

    await mod.iniciarConsumidorPagamentos();

    expect(connect).not.toHaveBeenCalled();
    expect(mod.estaConsumindo()).toBe(false);
    await mod.pararConsumidorPagamentos();
    process.env.PAYMENTS_CONSUMER_ENABLED = 'true';
  });

  it('CASO C41: so a string exata "true" liga', async () => {
    // '1', 'yes' ou 'TRUE' nao ligam: aceitar variantes transforma erro de
    // digitacao em ativacao acidental de superficie financeira.
    for (const valor of ['1', 'yes', 'TRUE', 'false', '']) {
      process.env.PAYMENTS_CONSUMER_ENABLED = valor;
      const { mod, connect } = carregar();
      connect.mockResolvedValue(conexaoFalsa(canalFalso()));
      await mod.iniciarConsumidorPagamentos();
      expect(connect).not.toHaveBeenCalled();
      await mod.pararConsumidorPagamentos();
    }
    process.env.PAYMENTS_CONSUMER_ENABLED = 'true';
  });
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

describe('handler — nenhuma rejeicao sem observador', () => {
  it('CASO C33: falha ao dispor PROPAGA para quem chama invalidar', async () => {
    // Este ramo estava fora do try/catch. Com o canal ja morto, o nack rejeita,
    // a promise do handler nao tem observador e vira unhandledRejection — que
    // pode derrubar o processo HTTP, o oposto do isolamento que o consumidor
    // existe para dar.
    const ch = canalFalso({
      nack: jest.fn(() => {
        throw new Error('canal ja fechado');
      }),
    });
    const { mod } = carregar();

    const grande = {
      content: Buffer.alloc(70 * 1024),
      fields: { routingKey: 'payment.captured' },
    };

    // A versao anterior deste teste afirmava que tratarMensagem RESOLVE quando o
    // nack falha. Ausencia de rejeicao nao e destino: a mensagem ficava unacked
    // e travava o prefetch(1) inteiro. Agora ela PROPAGA, e quem observa
    // (o callback do broker) invalida a sessao — fechar o canal devolve as nao
    // confirmadas para a fila, que e o unico destino possivel quando o proprio
    // canal e que falhou. O C39 prova o efeito ponta a ponta.
    await expect(mod.tratarMensagem(ch as never, grande)).rejects.toThrow();
  });
});

describe('sessao do consumidor — resultado tardio e disposicao', () => {
  it('CASO C38: conexao que chega DEPOIS do deadline nao vira sessao orfa', async () => {
    // comDeadline rejeita a promise observada, mas nao cancela o trabalho: sem
    // marcar a aquisicao como abandonada, a execucao antiga segue criando canal,
    // topologia e ate um consume — um consumidor sem referencia global, com
    // listeners na mesma geracao da sessao nova.
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
    await new Promise((r) => setTimeout(r, 300)); // deixa o deadline de 200ms vencer
    liberar(cx);
    await emVoo;
    await new Promise((r) => setTimeout(r, 20));

    expect(cx.createChannel).not.toHaveBeenCalled();
    expect(cx.close).toHaveBeenCalled();
    expect(mod.estaConsumindo()).toBe(false);
  }, 5_000);

  it('CASO C39: falha ao dispor da mensagem invalida a sessao', async () => {
    // Com prefetch(1), uma mensagem unacked bloqueia TODAS as seguintes. Apenas
    // logar deixa o consumidor travado parecendo saudavel. Fechar o canal
    // devolve as nao confirmadas para a fila, que e o desfecho correto.
    const ch = canalFalso({
      nack: jest.fn(() => {
        throw new Error('canal ja fechado');
      }),
      ack: jest.fn(() => {
        throw new Error('canal ja fechado');
      }),
    });
    const { mod, connect } = carregar();
    connect.mockResolvedValue(conexaoFalsa(ch));

    await mod.iniciarConsumidorPagamentos();
    expect(mod.estaConsumindo()).toBe(true);

    const callback = ch.consume.mock.calls[0][1] as (m: unknown) => void;
    callback({
      content: Buffer.from('{ nao e json'),
      fields: { routingKey: 'payment.captured' },
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(mod.estaConsumindo()).toBe(false);
    await mod.pararConsumidorPagamentos();
  }, 5_000);
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

  it('CASO C30: apos o encerramento, a abertura PARA em vez de criar canal', async () => {
    // A sabotagem T16 mostrou que o C28 sozinho nao cobre isto: com
    // createChannel mock resolvendo na hora, o descarte acontece no ponto de
    // checagem seguinte e o teste passa. No mundo real encerra-se PORQUE algo
    // esta ruim, entao o createChannel pendura — e a conexao vaza enquanto o
    // shutdown trava esperando. Mesmo erro cometido no publisher do payment.
    const ch = canalFalso({
      // nunca resolve
    });
    const cx = conexaoFalsa(ch, {
      createChannel: jest.fn(() => new Promise(() => undefined)),
    });
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

    expect(cx.createChannel).not.toHaveBeenCalled();
    expect(cx.close).toHaveBeenCalled();
    expect(mod.estaConsumindo()).toBe(false);
  }, 5_000);

  it('CASO C35: shutdown fecha conexao ja adquirida com o canal pendurado', async () => {
    // O caso que o C30 NAO cobre: ali o connect nem tinha resolvido. Aqui a
    // conexao ja existe e o createChannel pendura — o abortarSePreciso seguinte
    // nunca roda, entao quem tem de fechar e o encerramento. Antes, `ref` era
    // local a abrirSessao e o shutdown nao alcancava nada.
    const ch = canalFalso();
    const cx = conexaoFalsa(ch, {
      createChannel: jest.fn(() => new Promise(() => undefined)),
    });
    const { mod, connect } = carregar();
    connect.mockResolvedValue(cx);

    const emVoo = mod.iniciarConsumidorPagamentos().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 10)); // deixa o connect resolver
    await mod.pararConsumidorPagamentos();

    expect(cx.close).toHaveBeenCalled();
    expect(mod.estaConsumindo()).toBe(false);

    // Espera o deadline da abertura estourar: sem isso o log da falha sai
    // depois do fim do teste e o jest reclama de log tardio.
    await emVoo;
  }, 5_000);

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
