import { executarMigracao } from './migrate-test-db';

/**
 * RECRIA o banco de teste do zero, passando pela mesma guarda de destino do
 * script de migration.
 *
 * Necessario quando um arquivo de migration ja aplicado e reescrito: o Prisma
 * guarda o checksum e recusa seguir ate o banco ser reconstruido. Foi o caso da
 * migration do fingerprint, cuja primeira versao apagava registros com base numa
 * premissa sobre o ambiente e foi refeita apos o segundo review do PR #52.
 *
 * DESTRUTIVO por natureza — por isso reusa `validarAlvoDeMigracao`, que exige
 * nome exato do banco, NODE_ENV=test, ALLOW_TEST_DB_RESET=true e host local.
 */
function main(): void {
  process.exit(
    executarMigracao({
      base: process.env,
      argumentos: ['prisma', 'migrate', 'reset', '--force', '--skip-generate'],
    }),
  );
}

if (require.main === module) {
  main();
}
