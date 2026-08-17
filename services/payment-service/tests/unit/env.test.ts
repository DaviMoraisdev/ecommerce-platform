import { loadConfig, ConfigError } from '../../src/config/env';
import { configDeTeste, envDeTeste } from '../helpers/config';

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

const OBRIGATORIAS = [
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

  it('assume development quando NODE_ENV nao e informada', () => {
    expect(loadConfig(semAs('NODE_ENV')).nodeEnv).toBe('development');
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

  it.each(['production', 'staging', 'homolog', 'PRODUCTION'])(
    'RECUSA fake com NODE_ENV=%p',
    (nodeEnv) => {
      expect(() =>
        loadConfig({ ...base, NODE_ENV: nodeEnv, PAYMENT_PROVIDER: 'fake' }),
      ).toThrow(/proibido/);
    },
  );

  it.each(['development', 'test', 'production'])('aceita stripe em %s', (nodeEnv) => {
    expect(
      loadConfig({ ...base, NODE_ENV: nodeEnv, PAYMENT_PROVIDER: 'stripe' }).provider,
    ).toBe('stripe');
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
        loadConfig({
          ...base,
          NODE_ENV: 'production',
          PAYMENT_PROVIDER: 'stripe',
          [chave]: 'a'.repeat(32),
        }),
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
