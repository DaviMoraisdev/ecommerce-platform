module.exports = {
  preset: 'ts-jest',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: false }],
  },
  testEnvironment: 'node',
  // Teto EXPLICITO de workers. Medido no payment-service (239 testes) em WSL2
  // com 3,7 GiB de RAM e 8 CPUs, onde o padrao do Jest cria 7 workers:
  //   1 worker  -> 2,3s   |  2 -> 3,2s  |  3 -> 4,7s  |  7 -> derruba a sessao
  // Cada worker carrega ts-jest e, nas suites com banco, o Prisma Client
  // (~270 MB cada). Para suites deste tamanho o custo de subir processo supera
  // qualquer ganho de paralelismo — serie e mais rapido E previsivel em memoria.
  // Maquina com folga pode sobrepor com `npx jest --maxWorkers=N`.
  maxWorkers: 1,
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
};
