import { encerrar, registrarEncerramento } from '../../src/shutdown';

function coletores() {
  const logs: string[] = [];
  const erros: string[] = [];
  return {
    logs,
    erros,
    log: (m: string) => logs.push(m),
    reportarErro: (m: string) => erros.push(m),
  };
}

describe('encerrar', () => {
  it('fecha o servidor ANTES de desconectar o banco', async () => {
    const ordem: string[] = [];
    const c = coletores();

    const codigo = await encerrar({
      pararReconciliacao: async () => undefined, pararRelay: async () => undefined,
      fecharPublisher: async () => undefined,
      fecharServidor: async () => void ordem.push('servidor'),
      desconectarBanco: async () => void ordem.push('banco'),
      ...c,
    });

    // Desconectar antes deixaria requisicoes em voo sem persistencia,
    // transformando um encerramento em erro 500 para o cliente.
    expect(ordem).toEqual(['servidor', 'banco']);
    expect(codigo).toBe(0);
  });

  it('devolve 1 quando o fechamento do servidor falha, MAS desconecta o banco', async () => {
    const ordem: string[] = [];
    const c = coletores();

    const codigo = await encerrar({
      pararReconciliacao: async () => undefined, pararRelay: async () => undefined,
      fecharPublisher: async () => undefined,
      fecharServidor: async () => {
        throw new Error('servidor travado');
      },
      desconectarBanco: async () => void ordem.push('banco'),
      ...c,
    });

    expect(codigo).toBe(1);
    // Best effort: uma falha anterior nao deve deixar a conexao pendurada.
    expect(ordem).toEqual(['banco']);
    expect(c.erros.join('\n')).toContain('servidor travado');
  });

  it('devolve 1 quando a desconexao do banco falha', async () => {
    const c = coletores();

    const codigo = await encerrar({
      pararReconciliacao: async () => undefined, pararRelay: async () => undefined,
      fecharPublisher: async () => undefined,
      fecharServidor: async () => undefined,
      desconectarBanco: async () => {
        throw new Error('banco fora');
      },
      ...c,
    });

    expect(codigo).toBe(1);
    expect(c.erros.join('\n')).toContain('banco fora');
  });

  it('devolve 1 e avisa quando o encerramento estoura o teto de tempo', async () => {
    const c = coletores();

    const codigo = await encerrar({
      pararReconciliacao: async () => undefined, pararRelay: async () => undefined,
      fecharPublisher: async () => undefined,
      // Nunca resolve: simula requisicao em voo que nao termina.
      fecharServidor: () => new Promise<void>(() => undefined),
      desconectarBanco: async () => undefined,
      timeoutMs: 20,
      ...c,
    });

    expect(codigo).toBe(1);
    expect(c.erros.join('\n')).toMatch(/excedeu 20ms/);
  });

  it('NUNCA lanca — quem chama esta a caminho de process.exit', async () => {
    const c = coletores();

    await expect(
      encerrar({
        pararReconciliacao: async () => undefined, pararRelay: async () => undefined,
        fecharPublisher: async () => undefined,
        fecharServidor: async () => {
          throw new Error('a');
        },
        desconectarBanco: async () => {
          throw new Error('b');
        },
        ...c,
      }),
    ).resolves.toBe(1);
  });
});

describe('registrarEncerramento', () => {
  function espionarSinais() {
    const handlers = new Map<string, () => void>();
    return {
      handlers,
      onSinal: (sinal: NodeJS.Signals, handler: () => void) => {
        handlers.set(sinal, handler);
      },
    };
  }

  it('registra os sinais informados', () => {
    const espiao = espionarSinais();

    registrarEncerramento({
      pararReconciliacao: async () => undefined, pararRelay: async () => undefined,
      fecharPublisher: async () => undefined,
      fecharServidor: async () => undefined,
      desconectarBanco: async () => undefined,
      sinais: ['SIGTERM', 'SIGINT'],
      onSinal: espiao.onSinal,
      sair: () => undefined,
    });

    expect([...espiao.handlers.keys()]).toEqual(['SIGTERM', 'SIGINT']);
  });

  it('IGNORA o segundo sinal — duas sequencias concorrentes se atropelariam', async () => {
    const espiao = espionarSinais();
    let fechamentos = 0;
    const codigos: number[] = [];

    registrarEncerramento({
      pararReconciliacao: async () => undefined, pararRelay: async () => undefined,
      fecharPublisher: async () => undefined,
      fecharServidor: async () => void (fechamentos += 1),
      desconectarBanco: async () => undefined,
      sinais: ['SIGINT'],
      onSinal: espiao.onSinal,
      sair: (codigo) => void codigos.push(codigo),
      log: () => undefined,
    });

    const handler = espiao.handlers.get('SIGINT') as () => void;
    handler();
    handler();
    handler();

    // Deixa as promessas pendentes resolverem.
    await new Promise((resolve) => setImmediate(resolve));

    expect(fechamentos).toBe(1);
    expect(codigos).toEqual([0]);
  });

  it('repassa ao sair o codigo devolvido por encerrar', async () => {
    const espiao = espionarSinais();
    const codigos: number[] = [];

    registrarEncerramento({
      pararReconciliacao: async () => undefined, pararRelay: async () => undefined,
      fecharPublisher: async () => undefined,
      fecharServidor: async () => {
        throw new Error('falhou');
      },
      desconectarBanco: async () => undefined,
      sinais: ['SIGTERM'],
      onSinal: espiao.onSinal,
      sair: (codigo) => void codigos.push(codigo),
      log: () => undefined,
      reportarErro: () => undefined,
    });

    (espiao.handlers.get('SIGTERM') as () => void)();
    await new Promise((resolve) => setImmediate(resolve));

    expect(codigos).toEqual([1]);
  });
});

describe('encerrar — relay e publisher', () => {
  it('para o relay ANTES de fechar o publisher, e o banco por ULTIMO', async () => {
    const ordem: string[] = [];
    const c = coletores();
    const codigo = await encerrar({
      fecharServidor: async () => void ordem.push('servidor'),
      pararReconciliacao: async () => undefined, pararRelay: async () => void ordem.push('relay'),
      fecharPublisher: async () => void ordem.push('publisher'),
      desconectarBanco: async () => void ordem.push('banco'),
      ...c,
    });
    // O tick usa o BANCO, entao o banco sai por ultimo. E o publisher sai
    // depois do relay parado: na ordem inversa, a conexao cairia no meio de
    // uma publicacao ja iniciada.
    expect(ordem).toEqual(['servidor', 'relay', 'publisher', 'banco']);
    expect(codigo).toBe(0);
  });
});
