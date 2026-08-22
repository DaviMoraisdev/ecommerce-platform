import type { Server } from 'node:http';
import type { AppConfig } from './config/env';

/**
 * Dependencias injetadas para que a ORDEM de inicializacao seja testavel sem
 * subir servidor nem banco. Item 6.2 da revisao do PR #47.
 */
export interface BootstrapDeps {
  loadConfig: () => AppConfig;
  connectDatabase: (databaseUrl: string) => Promise<unknown>;
  createApp: (config: AppConfig) => { listen(port: number, callback?: () => void): Server };
  /**
   * OBRIGATORIO de proposito. Opcional deixaria um ponto de composicao esquecer
   * de ligar o relay, e o servico subiria no ar publicando NADA, em silencio.
   * Quem decide se ha broker e o composition root, olhando config.rabbitmqUrl.
   */
  iniciarRelay: (config: AppConfig) => void;
}

/**
 * A ordem e o contrato: configuracao validada -> banco conectado -> porta aberta.
 * Qualquer falha nos dois primeiros passos impede o terceiro, e o servico nunca
 * anuncia disponibilidade sem persistencia utilizavel.
 */
export async function bootstrap(deps: BootstrapDeps): Promise<Server> {
  const config = deps.loadConfig();

  await deps.connectDatabase(config.databaseUrl);
  // DEPOIS do banco: o ciclo do relay le a outbox. ANTES da porta: o relay nao
  // depende de HTTP, e atrasar a saida de eventos nao traz beneficio nenhum.
  deps.iniciarRelay(config);

  // A config e passada adiante: o composition root precisa dela para montar
  // provedor, cliente do order e servico.
  const app = deps.createApp(config);

  return app.listen(config.port, () => {
    console.log(`[payment-service] ouvindo na porta ${config.port}`);
  });
}
