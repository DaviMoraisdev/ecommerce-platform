// Guard triplo antes de qualquer escrita destrutiva nos testes de integracao:
// nome EXATO do banco (via pathname, nao substring), NODE_ENV=test e opt-in.
export function assertTestDatabase(): void {
  const raw = process.env.DATABASE_URL || '';
  let dbName = '';
  try {
    dbName = new URL(raw).pathname.replace(/^\//, '');
  } catch {
    dbName = '';
  }
  const isTestEnv = process.env.NODE_ENV === 'test';
  const optIn = process.env.ALLOW_TEST_DB_RESET === 'true';
  if (dbName !== 'order_test_db' || !isTestEnv || !optIn) {
    throw new Error(
      'Guard: integracao exige DATABASE_URL=.../order_test_db, NODE_ENV=test e ALLOW_TEST_DB_RESET=true — abortado.'
    );
  }
}
