import type { Server } from 'node:http';
import type { AppConfig } from './config/env';

/**
 * Dependencias injetadas para que a ORDEM de inicializacao seja testavel sem
 * subir servidor nem banco. Item 6.2 da revisao do PR #47.
 */
export interface BootstrapDeps {
  loadConfig: () => AppConfig;
  connectDatabase: (databaseUrl: string) => Promise<unknown>;
  createApp: () => { listen(port: number, callback?: () => void): Server };
}

/**
 * A ordem e o contrato: configuracao validada -> banco conectado -> porta aberta.
 * Qualquer falha nos dois primeiros passos impede o terceiro, e o servico nunca
 * anuncia disponibilidade sem persistencia utilizavel.
 */
export async function bootstrap(deps: BootstrapDeps): Promise<Server> {
  const config = deps.loadConfig();

  await deps.connectDatabase(config.databaseUrl);

  const app = deps.createApp();

  return app.listen(config.port, () => {
    console.log(`[payment-service] ouvindo na porta ${config.port}`);
  });
}
