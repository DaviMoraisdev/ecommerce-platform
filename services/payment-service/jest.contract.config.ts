import type { Config } from 'jest';

/**
 * Suite de CONTRATO contra a Stripe real (sandbox). Fora do verify e do CI de
 * proposito: chama rede, exige credencial e nao e deterministica como unitario.
 *
 * Sem `import base from './jest.config'`, de proposito. O Jest 30 carrega config
 * .ts com import() nativo quando o Node remove tipos sozinho (Node 22.18+), e no
 * ESM import relativo exige extensao — './jest.config' falha com
 * ERR_MODULE_NOT_FOUND. Escrever './jest.config.ts' passaria no runtime e seria
 * recusado pelo tsc. Entao os campos abaixo REPETEM os de jest.config.ts. Se a
 * base mudar o transform, esta config nao acompanha sozinha: preco declarado.
 *
 * Sem o setup dos unitarios: este arquivo nao precisa dele, e qualquer duble de
 * rede que o setup instale anularia o proposito da suite.
 */
const config: Config = {
  // --- repetido de jest.config.ts ---
  preset: 'ts-jest',
  testEnvironment: 'node',
  maxWorkers: 1,
  clearMocks: true,
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json', diagnostics: false }],
  },
  // --- proprio da suite de contrato ---
  roots: ['<rootDir>/tests/contract'],
  testMatch: ['**/*.test.ts'],
  // Cada caso faz varias chamadas reais; o padrao de 5s nao cobre isso.
  testTimeout: 30_000,
};

export default config;
