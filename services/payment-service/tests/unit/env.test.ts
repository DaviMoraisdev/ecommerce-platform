import { loadConfig, ConfigError } from '../../src/config/env';
import { configDeTeste, envDeProducao, envDeTeste } from '../helpers/config';

/**
 * Segredo de 48 caracteres: passa o minimo de 32 e nao esta na lista de
 * placeholders. Usado como linha de base valida.
 */
const base: NodeJS.ProcessEnv = envDeTeste();

/** Remove chaves da linha de base sem mutar o objeto compartilhado. */
function semAs(...chaves: string[]): NodeJS.ProcessEnv {
  const copia = { ...base };
  for (const chave of chaves) delete copia[chave];
  return copia;
}

/**
 * Ambiente valido para um NODE_ENV especifico.
 *
 * Em producao a URL do order vira https: desde o achado 3.3, http em producao
 * exige ORDER_SERVICE_ALLOW_INSECURE. Fixture de producao que usa http estava
 * testando duas coisas ao mesmo tempo sem dizer.
 */
function ambiente(nodeEnv: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...base,
    NODE_ENV: nodeEnv,
    ...(nodeEnv === 'production' ? { ORDER_SERVICE_URL: 'https://order.interno' } : {}),
    ...overrides,
  };
}

const OBRIGATORIAS = [
  'NODE_ENV',
  'PAYMENT_PORT',
  'DATABASE_URL',
  'PAYMENT_PROVIDER',
  'PAYMENT_WEBHOOK_SECRET',
  'JWT_SECRET',
  'ORDER_SERVICE_URL',
] as const;

describe('loadConfig — caminho valido', () => {
  it('monta a config a partir de um ambiente valido', () => {
    // Compara contra o builder compartilhado, nao contra um literal: era a
    // TERCEIRA copia da forma do AppConfig nos testes. E como os segredos de
    // webhook e JWT sao DIFERENTES no builder, uma troca entre os dois campos
    // dentro do loadConfig faria este teste falhar.
    expect(loadConfig(envDeTeste())).toEqual(configDeTeste());
  });

  it('assume BRL quando DEFAULT_CURRENCY nao e informada', () => {
    expect(loadConfig(semAs('DEFAULT_CURRENCY')).defaultCurrency).toBe('BRL');
  });

  it('RECUSA ambiente ausente em vez de assumir development', () => {
    // Este teste era o oposto ate o review do PR #52: ele FIXAVA o default
    // inseguro. Com PAYMENT_PROVIDER=fake no .env.example, assumir development
    // fazia uma implantacao sem NODE_ENV aprovar pagamentos sem mover dinheiro.
    expect(() => loadConfig(semAs('NODE_ENV'))).toThrow(/NODE_ENV e obrigatorio/);
  });

  it.each(['prod', 'PRODUCTION', 'staging', 'homolog', 'dev'])(
    'RECUSA ambiente fora da lista fechada: %p',
    (valor) => {
      // 'prod' era o pior caso: nao e dev/test, entao fake era recusado, mas
      // assertSegredoForte compara com 'production' EXATO — a exigencia de 32
      // caracteres era pulada e o segredo fraco passava em producao.
      expect(() => loadConfig({ ...base, NODE_ENV: valor })).toThrow(/NODE_ENV invalido/);
    },
  );

  it('um typo em NODE_ENV nao pode liberar segredo fraco', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'prod', JWT_SECRET: 'curto_mas_proprio' }),
    ).toThrow(/NODE_ENV invalido/);
  });

  it('remove espacos ao redor dos valores', () => {
    expect(loadConfig({ ...base, PAYMENT_PORT: '  3007  ' }).port).toBe(3007);
  });

  it.each(['1', '65535'])('aceita a porta limite %s', (porta) => {
    expect(loadConfig({ ...base, PAYMENT_PORT: porta }).port).toBe(Number(porta));
  });
});

/**
 * As asercoes citam o NOME da variavel, nao apenas a classe do erro.
 *
 * Motivo concreto: quando PAYMENT_PROVIDER, PAYMENT_WEBHOOK_SECRET e JWT_SECRET
 * passaram a ser obrigatorias, os casos que assertavam apenas
 * `toThrow(ConfigError)` continuaram VERDES — lancando por causa da variavel
 * nova, nao pela condicao que diziam testar. Falso verde nao aparece na
 * contagem de falhas.
 */
describe('loadConfig — variaveis obrigatorias', () => {
  it.each(OBRIGATORIAS)('lanca citando %s quando ela esta ausente', (chave) => {
    expect(() => loadConfig(semAs(chave))).toThrow(new RegExp(chave));
  });

  it.each(OBRIGATORIAS)('lanca citando %s quando ela e so espacos', (chave) => {
    expect(() => loadConfig({ ...base, [chave]: '   ' })).toThrow(new RegExp(chave));
  });

  it('o erro e sempre ConfigError', () => {
    expect(() => loadConfig(semAs('DATABASE_URL'))).toThrow(ConfigError);
  });
});

describe('loadConfig — porta e moeda', () => {
  it.each(['0', '65536', '-1', 'abc', '3007.5'])(
    'lanca para PAYMENT_PORT invalida %p',
    (porta) => {
      expect(() => loadConfig({ ...base, PAYMENT_PORT: porta })).toThrow(
        /PAYMENT_PORT invalida/,
      );
    },
  );

  it('lanca para moeda nao suportada', () => {
    expect(() => loadConfig({ ...base, DEFAULT_CURRENCY: 'USD' })).toThrow(
      /DEFAULT_CURRENCY/,
    );
  });
});

/**
 * FAIL-CLOSED. PAYMENT_PROVIDER=fake em producao significaria que qualquer
 * token magico aprova uma cobranca: pagamento sempre bem-sucedido, sem dinheiro
 * nenhum. E controle de seguranca, nao configuracao de conveniencia.
 */
describe('loadConfig — fabrica de provedor', () => {
  it.each(['development', 'test'])('aceita fake em %s', (nodeEnv) => {
    expect(loadConfig({ ...base, NODE_ENV: nodeEnv, PAYMENT_PROVIDER: 'fake' }).provider).toBe(
      'fake',
    );
  });

  it('RECUSA fake em producao', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', PAYMENT_PROVIDER: 'fake' }),
    ).toThrow(/proibido/);
  });

  it.each(['development', 'test', 'production'])('aceita stripe em %s', (nodeEnv) => {
    expect(loadConfig(ambiente(nodeEnv, { PAYMENT_PROVIDER: 'stripe' })).provider).toBe(
      'stripe',
    );
  });

  it.each(['Fake', 'FAKE', 'mock', 'paypal', ''])(
    'lanca para PAYMENT_PROVIDER invalido %p',
    (valor) => {
      expect(() => loadConfig({ ...base, PAYMENT_PROVIDER: valor })).toThrow(
        /PAYMENT_PROVIDER/,
      );
    },
  );

  it.each(['fake ', ' fake', '  fake  '])(
    'TOLERA espaco ao redor em %p — requireEnv normaliza antes',
    (valor) => {
      // Espaco no fim de uma linha de .env e acidente de edicao, invisivel no
      // editor. Recusar produziria a mensagem mais confusa possivel:
      // 'PAYMENT_PROVIDER invalido: "fake "', identica a um valor valido.
      // Caixa, ao contrario, NAO e normalizada: 'Fake' e recusado, e a
      // diferenca ali e visivel para quem le.
      expect(loadConfig({ ...base, PAYMENT_PROVIDER: valor }).provider).toBe('fake');
    },
  );
});

/**
 * Mesma regra dos outros quatro servicos: placeholder recusado em qualquer
 * ambiente (o cenario de risco e copiar o .env.example e subir localmente);
 * tamanho minimo so em producao.
 */
describe.each(['PAYMENT_WEBHOOK_SECRET', 'JWT_SECRET'] as const)(
  'loadConfig — forca de %s',
  (chave) => {
    it.each([
      'troque_este_segredo',
      'dev_jwt_secret_troque_em_producao',
      'changeme',
      'secret',
      'segredo',
    ])('recusa o placeholder %p em desenvolvimento', (placeholder) => {
      expect(() =>
        loadConfig({ ...base, NODE_ENV: 'development', [chave]: placeholder }),
      ).toThrow(/placeholder/i);
    });

    it('recusa placeholder ignorando caixa e espacos', () => {
      expect(() =>
        loadConfig({ ...base, NODE_ENV: 'development', [chave]: '  TROQUE_ESTE_SEGREDO  ' }),
      ).toThrow(/placeholder/i);
    });

    it('em DESENVOLVIMENTO aceita segredo curto que nao e placeholder', () => {
      expect(() =>
        loadConfig({ ...base, NODE_ENV: 'development', [chave]: 'curto_mas_proprio' }),
      ).not.toThrow();
    });

    it('em PRODUCAO recusa segredo com menos de 32 caracteres', () => {
      expect(() =>
        loadConfig({
          ...base,
          NODE_ENV: 'production',
          PAYMENT_PROVIDER: 'stripe',
          [chave]: 'curto_mas_proprio',
        }),
      ).toThrow(/32 caracteres/);
    });

    it('em PRODUCAO aceita exatamente 32 caracteres', () => {
      expect(() =>
        loadConfig(
          ambiente('production', { PAYMENT_PROVIDER: 'stripe', [chave]: 'a'.repeat(32) }),
        ),
      ).not.toThrow();
    });

    it('a mensagem cita a variavel, para o operador saber qual corrigir', () => {
      expect(() =>
        loadConfig({ ...base, NODE_ENV: 'development', [chave]: 'changeme' }),
      ).toThrow(new RegExp(chave));
    });
  },
);

describe('loadConfig — ORDER_SERVICE_URL', () => {
  it('nao tem fallback para localhost, ao contrario do INVENTORY_SERVICE_URL', () => {
    const { ORDER_SERVICE_URL, ...semUrl } = base;
    expect(() => loadConfig(semUrl)).toThrow(/ORDER_SERVICE_URL/);
  });

  it.each(['nao-e-url', 'localhost:3006', '://x', ' '])(
    'recusa URL invalida %p',
    (url) => {
      expect(() => loadConfig({ ...base, ORDER_SERVICE_URL: url })).toThrow(
        /ORDER_SERVICE_URL/,
      );
    },
  );

  it.each(['ftp://order:3006', 'file:///tmp/order', 'ws://order:3006'])(
    'recusa protocolo %p',
    (url) => {
      expect(() => loadConfig({ ...base, ORDER_SERVICE_URL: url })).toThrow(/http ou https/);
    },
  );

  it.each([
    'https://order.interno?cluster=a',
    'https://order.interno#frag',
    'https://usuario:senha@order.interno',
    'http://usuario@order.interno',
  ])('recusa base com credencial, query ou fragmento: %p', (url) => {
    // O cliente concatena `${base}/orders/:id`. Com query na base, o caminho cai
    // DENTRO da query e a falha so aparece na primeira cobranca.
    expect(() => loadConfig({ ...base, ORDER_SERVICE_URL: url })).toThrow(
      /credenciais|query|fragmento/,
    );
  });

  describe('transporte do token em producao (achado 3.3)', () => {
    const producao = { ...base, NODE_ENV: 'production', PAYMENT_PROVIDER: 'stripe' };

    it('RECUSA http em producao sem declaracao explicita', () => {
      expect(() =>
        loadConfig({ ...producao, ORDER_SERVICE_URL: 'http://order:3006' }),
      ).toThrow(/usa http em producao/);
    });

    it('aceita http em producao quando o transporte protegido e DECLARADO', () => {
      // A excecao vira configuracao explicita e auditavel, em vez de uma linha
      // de documentacao que ninguem executa.
      expect(
        loadConfig({
          ...producao,
          ORDER_SERVICE_URL: 'http://order:3006',
          ORDER_SERVICE_ALLOW_INSECURE: 'true',
        }).orderServiceUrl,
      ).toBe('http://order:3006');
    });

    it('aceita https em producao sem declaracao nenhuma', () => {
      expect(
        loadConfig({ ...producao, ORDER_SERVICE_URL: 'https://order.interno' }).orderServiceUrl,
      ).toBe('https://order.interno');
    });

    it.each(['development', 'test'])('permite http em %s', (nodeEnv) => {
      expect(
        loadConfig({ ...base, NODE_ENV: nodeEnv, ORDER_SERVICE_URL: 'http://order:3006' })
          .orderServiceUrl,
      ).toBe('http://order:3006');
    });

    it.each(['sim', '1', 'TRUE', 'yes'])('recusa valor ambiguo na flag: %p', (valor) => {
      expect(() =>
        loadConfig({ ...producao, ORDER_SERVICE_ALLOW_INSECURE: valor }),
      ).toThrow(/ORDER_SERVICE_ALLOW_INSECURE/);
    });
  });

  it.each(['http://order:3006', 'https://order.interno'])('aceita %p', (url) => {
    expect(loadConfig({ ...base, ORDER_SERVICE_URL: url }).orderServiceUrl).toBe(url);
  });

  it.each([
    ['http://order:3006/', 'http://order:3006'],
    ['http://order:3006///', 'http://order:3006'],
  ])('normaliza a barra final de %p', (entrada, esperado) => {
    // O cliente monta `${base}/orders/:id`; sem normalizar, viraria "//orders".
    expect(loadConfig({ ...base, ORDER_SERVICE_URL: entrada }).orderServiceUrl).toBe(esperado);
  });
});

describe('loadConfig — ORDER_SERVICE_TIMEOUT_MS', () => {
  it('usa 5000 quando ausente', () => {
    expect(loadConfig(base).orderServiceTimeoutMs).toBe(5000);
  });

  it('usa 5000 quando vazia', () => {
    expect(loadConfig({ ...base, ORDER_SERVICE_TIMEOUT_MS: '  ' }).orderServiceTimeoutMs).toBe(
      5000,
    );
  });

  it.each(['0', '-1', 'abc', '1.5', '60001'])('recusa %p', (valor) => {
    expect(() => loadConfig({ ...base, ORDER_SERVICE_TIMEOUT_MS: valor })).toThrow(
      /ORDER_SERVICE_TIMEOUT_MS/,
    );
  });

  it.each(['1', '3000', '60000'])('aceita o limite %p', (valor) => {
    expect(loadConfig({ ...base, ORDER_SERVICE_TIMEOUT_MS: valor }).orderServiceTimeoutMs).toBe(
      Number(valor),
    );
  });
});

describe('loadConfig — PAYMENT_WINDOW_MINUTES', () => {
  it('usa 15 quando ausente', () => {
    expect(loadConfig(base).paymentWindowMinutes).toBe(15);
  });

  it('usa 15 quando vazia', () => {
    expect(loadConfig({ ...base, PAYMENT_WINDOW_MINUTES: '  ' }).paymentWindowMinutes).toBe(15);
  });

  it.each(['0', '-1', 'abc', '1.5', '1441', '15,5'])('recusa %p', (valor) => {
    expect(() => loadConfig({ ...base, PAYMENT_WINDOW_MINUTES: valor })).toThrow(
      /PAYMENT_WINDOW_MINUTES/,
    );
  });

  it.each(['1', '15', '30', '1440'])('aceita o limite %p', (valor) => {
    // WEBHOOK_QUARANTINE_MINUTES vai junto por causa da validacao cruzada do
    // Bloco 6c: a quarentena tem de ser MAIOR que a janela, e o default de 60
    // nao serve para uma janela de 1440.
    const config = loadConfig({
      ...base,
      PAYMENT_WINDOW_MINUTES: valor,
      WEBHOOK_QUARANTINE_MINUTES: '10080',
    });
    expect(config.paymentWindowMinutes).toBe(Number(valor));
  });

  it('tolera espaco ao redor', () => {
    expect(loadConfig({ ...base, PAYMENT_WINDOW_MINUTES: '  30  ' }).paymentWindowMinutes).toBe(
      30,
    );
  });

  it.each([
    ['0x10', 16],
    ['1e3', 1000],
  ])('TOLERA a notacao %p como %i — comportamento do Number()', (valor, esperado) => {
    // Documentado, nao desejado. Number() aceita hexadecimal e exponencial, e
    // parseTimeout tem a MESMA tolerancia. Nao vale endurecer: hex num arquivo
    // .env nao e acidente plausivel, e um parser proprio so para isso seria
    // codigo a mais para manter. Se um dia recusarmos, e nos dois juntos.
    const config = loadConfig({
      ...base,
      PAYMENT_WINDOW_MINUTES: valor,
      WEBHOOK_QUARANTINE_MINUTES: '10080',
    });
    expect(config.paymentWindowMinutes).toBe(esperado);
  });

  it('o teto de 1440 existe porque a janela prende estoque reservado', () => {
    expect(() => loadConfig({ ...base, PAYMENT_WINDOW_MINUTES: '10080' })).toThrow(
      /entre 1 e 1440/,
    );
  });
});

describe('loadConfig — RABBITMQ_URL', () => {
  it('FAIL-CLOSED: ausente em producao lanca', () => {
    const env = envDeProducao({ RABBITMQ_URL: undefined });
    // Sem broker, a captura e gravada e o pedido nunca fica sabendo:
    // inconsistencia silenciosa entre servicos.
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/RABBITMQ_URL e obrigatoria/);
  });

  it.each(['development', 'test'])('ausente em %s apenas desliga o relay', (ambiente) => {
    const config = loadConfig(
      envDeTeste({ NODE_ENV: ambiente, RABBITMQ_URL: undefined }),
    );
    expect(config.rabbitmqUrl).toBeNull();
  });

  it('recusa amqp:// em producao sem declaracao de transporte protegido', () => {
    const env = envDeProducao({ RABBITMQ_URL: 'amqp://usuario:senha@broker:5672' });
    // A credencial viaja DENTRO da URL: quem estiver na rede captura.
    expect(() => loadConfig(env)).toThrow(/texto claro/);
  });

  it('aceita amqp:// em producao quando o transporte protegido e DECLARADO', () => {
    const config = loadConfig(
      envDeProducao({
        RABBITMQ_URL: 'amqp://usuario:senha@broker:5672',
        RABBITMQ_ALLOW_INSECURE: 'true',
      }),
    );
    expect(config.rabbitmqUrl).toBe('amqp://usuario:senha@broker:5672');
  });

  it('recusa URL com protocolo valido mas SEM host', () => {
    // Passaria o fail-closed da config e falharia so no relay assincrono,
    // depois de o servico ja ter anunciado disponibilidade.
    expect(() =>
      loadConfig(envDeTeste({ RABBITMQ_URL: 'amqp:broker' })),
    ).toThrow(/sem host/);
  });

  it('recusa protocolo que nao e amqp nem amqps', () => {
    expect(() =>
      loadConfig(envDeTeste({ RABBITMQ_URL: 'http://broker:5672' })),
    ).toThrow(/protocolo nao suportado/);
  });

  it('URL invalida: recusa SEM vazar a credencial na mensagem', () => {
    // `amqp:` e esquema NAO-ESPECIAL, e o URL do WHATWG e permissivo com esses:
    // 'amqp:// usuario:...' parseia sem erro e o espaco vira percent-encoding.
    // Caractere invalido no ESQUEMA e o que derruba o parser de verdade.
    const env = envDeTeste({ RABBITMQ_URL: 'ht!tp://usuario:senha_supersecreta@broker' });
    let capturado: unknown;
    try {
      loadConfig(env);
    } catch (erro) {
      capturado = erro;
    }
    expect(capturado).toBeInstanceOf(ConfigError);
    // Mesma regra do testDbGuard: a URL contem a senha, entao nunca vai para
    // a mensagem de erro, que acaba em log.
    expect((capturado as Error).message).not.toContain('senha_supersecreta');
  });
});

describe('loadConfig — WEBHOOK_QUARANTINE_MINUTES (Bloco 6c)', () => {
  it('usa 60 quando ausente', () => {
    expect(loadConfig(base).webhookQuarantineMinutes).toBe(60);
  });

  it.each(['0', '-1', 'abc', '1.5', '10081'])('recusa %p', (valor) => {
    expect(() => loadConfig({ ...base, WEBHOOK_QUARANTINE_MINUTES: valor })).toThrow(
      /WEBHOOK_QUARANTINE_MINUTES/,
    );
  });

  it('RECUSA valor menor ou igual a janela de pagamento', () => {
    // Quem destrava um evento inaplicavel e o job de reconciliacao do Bloco 6b,
    // que so age sobre tentativas mais velhas que a janela. Quarentenar antes
    // disso descarta eventos que seriam resolvidos — e a quarentena e terminal.
    expect(() =>
      loadConfig({ ...base, PAYMENT_WINDOW_MINUTES: '60', WEBHOOK_QUARANTINE_MINUTES: '60' }),
    ).toThrow(/deve ser MAIOR/);
  });

  it('aceita um minuto acima da janela MAIS o intervalo do job', () => {
    // Com o poll default de 60_000ms, o minimo e janela + 1. O achado 4.2 da 2a
    // rodada mostrou que exigir so "acima da janela" deixava passar quarentena
    // que dispara antes de o job ter qualquer chance de agir.
    const config = loadConfig({
      ...base,
      PAYMENT_WINDOW_MINUTES: '60',
      WEBHOOK_QUARANTINE_MINUTES: '62',
    });
    expect(config.webhookQuarantineMinutes).toBe(62);
  });

  it('RECUSA quando a folga cobre a janela mas nao o intervalo do job', () => {
    // Janela 60 + poll de 10 minutos: quarentenar em 65 e quarentenar antes do
    // proximo ciclo da reconciliacao. Passava no boot antes da correcao.
    expect(() =>
      loadConfig({
        ...base,
        PAYMENT_WINDOW_MINUTES: '60',
        WEBHOOK_QUARANTINE_MINUTES: '65',
        RECONCILIACAO_POLL_INTERVAL_MS: '600000',
      }),
    ).toThrow(/intervalo do job/);
  });

  it('o intervalo do job entra na conta arredondando PARA CIMA', () => {
    // 90_000ms nao sao "1 minuto e meio" para efeito de garantia: um ciclo pode
    // demorar os 90s inteiros, entao o minimo seguro usa 2 minutos.
    expect(() =>
      loadConfig({
        ...base,
        PAYMENT_WINDOW_MINUTES: '10',
        WEBHOOK_QUARANTINE_MINUTES: '12',
        RECONCILIACAO_POLL_INTERVAL_MS: '90000',
      }),
    ).toThrow(/intervalo do job/);
  });

  it('o teto e MAIOR que o da janela — senao uma janela de 1440 travaria o boot', () => {
    // Sem teto maior, nao existiria valor de quarentena valido para a janela
    // maxima, e a validacao cruzada recusaria QUALQUER configuracao.
    const config = loadConfig({
      ...base,
      PAYMENT_WINDOW_MINUTES: '1440',
      WEBHOOK_QUARANTINE_MINUTES: '2880',
    });
    expect(config.webhookQuarantineMinutes).toBe(2880);
  });
});

describe('loadConfig — WEBHOOK_MAX_ATTEMPTS (Bloco 6c)', () => {
  // Achado 6.4 da 2a rodada: `parseTentativas` nasceu sem teste nenhum.
  it('usa 5 quando ausente', () => {
    expect(loadConfig(base).webhookMaxAttempts).toBe(5);
  });

  it('usa 5 quando vazia', () => {
    expect(loadConfig({ ...base, WEBHOOK_MAX_ATTEMPTS: '   ' }).webhookMaxAttempts).toBe(5);
  });

  it.each(['1', '5', '100'])('aceita o limite %p', (valor) => {
    expect(loadConfig({ ...base, WEBHOOK_MAX_ATTEMPTS: valor }).webhookMaxAttempts).toBe(
      Number(valor),
    );
  });

  it.each(['0', '-1', '101', '1.5', 'abc', '5,5'])('recusa %p', (valor) => {
    expect(() => loadConfig({ ...base, WEBHOOK_MAX_ATTEMPTS: valor })).toThrow(
      /WEBHOOK_MAX_ATTEMPTS/,
    );
  });

  it('TOLERA hexadecimal, como os parsers irmaos', () => {
    // Documentado, nao desejado — e a mesma tolerancia de parseTimeout e
    // parseMinutos. A divida diz que os quatro endurecem juntos ou nenhum.
    expect(loadConfig({ ...base, WEBHOOK_MAX_ATTEMPTS: '0x10' }).webhookMaxAttempts).toBe(16);
  });
});

describe('loadConfig — knobs do runtime de jobs (Bloco 6c)', () => {
  it('usa os defaults quando ausentes', () => {
    const config = loadConfig(base);
    expect(config.jobsPollIntervalMs).toBe(60_000);
    expect(config.jobsStopTimeoutMs).toBe(5_000);
    expect(config.jobsVarreduraTimeoutMs).toBe(120_000);
  });

  it('recusa poll fora da faixa', () => {
    expect(() => loadConfig({ ...base, RECONCILIACAO_POLL_INTERVAL_MS: '999' })).toThrow(
      /RECONCILIACAO_POLL_INTERVAL_MS/,
    );
  });

  it('recusa prazo de varredura fora da faixa', () => {
    expect(() => loadConfig({ ...base, JOBS_VARREDURA_TIMEOUT_MS: '600001' })).toThrow(
      /JOBS_VARREDURA_TIMEOUT_MS/,
    );
  });
});
