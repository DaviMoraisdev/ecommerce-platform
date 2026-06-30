module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  // Mongo em memoria: roda as suites EM SERIE (uma instancia por vez).
  // Em paralelo, varias instancias do MongoMemoryServer competem e estouram
  // o timeout de start — causa de falhas intermitentes ao rodar a suite toda.
  maxWorkers: 1,
  // Folga para o start da instancia, sobretudo na primeira execucao.
  testTimeout: 30000,
};
