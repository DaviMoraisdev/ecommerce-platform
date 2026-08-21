import { bootstrap } from './bootstrap';
import { construirApp } from './composition';
import { loadConfig } from './config/env';
import { connectDatabase, disconnectDatabase } from './config/database';
import { registrarEncerramento } from './shutdown';
import { startOutboxRelay, stopOutboxRelay } from './events/outbox.relay';
import { closeEventPublisher, initEventPublisher, isPublisherReady, publish } from './events/publisher';
import { fetchPending, markRetry, markSent } from './events/outbox.repository';

// Ponto de entrada: o UNICO lugar com process.exit e o unico que liga as pecas.
// Nenhum modulo importado aqui le o ambiente em tempo de import, entao qualquer
// falha de configuracao ou conexao chega ao catch abaixo.
bootstrap({
  loadConfig,
  connectDatabase,
  createApp: construirApp,
  // Sem broker configurado (permitido fora de producao) o relay nao sobe.
  iniciarRelay: (config) => {
    if (config.rabbitmqUrl === null) {
      console.warn('[payment-service] RABBITMQ_URL ausente: relay da outbox desativado');
      return;
    }
    const url = config.rabbitmqUrl;
    startOutboxRelay({
      isPublisherReady,
      initEventPublisher: () => initEventPublisher(url),
      publish,
      fetchPending,
      markSent,
      markRetry,
    });
  },
})
  .then((server) => {
    registrarEncerramento({
      fecharServidor: () =>
        new Promise<void>((resolve, reject) => {
          server.close((erro) => (erro ? reject(erro) : resolve()));
        }),
      pararRelay: stopOutboxRelay,
      fecharPublisher: closeEventPublisher,
      desconectarBanco: disconnectDatabase,
    });
  })
  .catch((error: unknown) => {
    console.error(
      '[payment-service] Falha na inicializacao:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
