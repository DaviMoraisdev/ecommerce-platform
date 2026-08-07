import { createApp } from './app';
import { loadConfig } from './config/env';
import { connectDatabase } from './config/database';

async function main(): Promise<void> {
  const config = loadConfig();

  // Conectar ANTES de escutar: sem isso o servico anuncia /health 200 sem ter
  // persistencia utilizavel, e a falha so apareceria durante um pagamento real.
  await connectDatabase();

  const app = createApp();

  app.listen(config.port, () => {
    console.log(`[payment-service] ouvindo na porta ${config.port}`);
  });
}

// Ponto de entrada e o UNICO lugar com process.exit. ConfigError e falha de
// conexao chegam aqui ja sanitizados e derrubam o processo de forma controlada.
main().catch((error: unknown) => {
  console.error(
    '[payment-service] Falha na inicializacao:',
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
