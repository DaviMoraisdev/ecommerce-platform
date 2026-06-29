module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  // Mongo em memoria sobe na primeira vez baixando binario; folga no timeout.
  testTimeout: 30000,
};
