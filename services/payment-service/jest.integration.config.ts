import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  clearMocks: true,
  setupFilesAfterEnv: ['<rootDir>/tests/setup.integration.ts'],
  testMatch: ['**/*.integration.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  // Os arquivos de integracao compartilham o MESMO payment_test_db. Em paralelo,
  // o afterEach (deleteMany) de um arquivo apaga os dados de outro em pleno voo.
  // Serie garante isolamento entre arquivos.
  maxWorkers: 1,
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json', diagnostics: false }],
  },
};

export default config;
