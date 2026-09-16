// Sem import/export de valor o TypeScript trata o arquivo como SCRIPT e o
// escopo vira global — `carregar` colidiria com o de publisher.test.ts.
export {};

type Database = typeof import('../../src/config/database');

// O modulo guarda o cliente em estado de modulo (clienteAtivo). isolateModules
// da um registro limpo por caso, sem depender da ordem dos arquivos.
function carregar(): Database {
  let mod!: Database;
  jest.isolateModules(() => {
    mod = require('../../src/config/database') as Database;
  });
  return mod;
}

describe('database — ciclo de vida do cliente', () => {
  it('CASO D1: getPrisma sem connectDatabase lanca com instrucao explicita', () => {
    // Divida do Bloco 8: o caminho de erro existia com mensagem propria e nenhum
    // teste o exercitava. A mensagem e parte do contrato — e o que orienta quem
    // esqueceu o connectDatabase no ponto de entrada.
    const mod = carregar();
    expect(() => mod.getPrisma()).toThrow(
      'PrismaClient nao inicializado: connectDatabase() deve rodar no ponto de entrada.',
    );
  });

  it('CASO D2: disconnectDatabase sem cliente e no-op', async () => {
    // Shutdown antes de o boot ter conectado (falha de config, por exemplo) nao
    // pode lancar por cima do erro original.
    const mod = carregar();
    await expect(mod.disconnectDatabase()).resolves.toBeUndefined();
    expect(() => mod.getPrisma()).toThrow();
  });
});
