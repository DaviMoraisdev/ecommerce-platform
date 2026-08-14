import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Mesmo teto e mesma justificativa do jest.config.ts.
  maxWorkers: 1,
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.integration.test.ts'],
  clearMocks: true,
  setupFilesAfterEnv: ['<rootDir>/tests/setup.integration.ts'],
  // Fecha a conexao do Prisma apos todas as suites. So a integracao conecta.
  globalTeardown: '<rootDir>/tests/globalTeardown.ts',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json', diagnostics: false }],
  },
};

export default config;
