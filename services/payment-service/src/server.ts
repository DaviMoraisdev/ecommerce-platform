import { createApp } from './app';
import { loadConfig } from './config/env';

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error('[payment-service] Falha ao carregar configuracao:', (error as Error).message);
    process.exit(1);
  }

  const app = createApp();

  app.listen(config.port, () => {
    console.log(`[payment-service] ouvindo na porta ${config.port}`);
  });
}

main();
