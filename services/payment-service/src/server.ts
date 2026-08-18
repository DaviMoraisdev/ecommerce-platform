import { bootstrap } from './bootstrap';
import { construirApp } from './composition';
import { loadConfig } from './config/env';
import { connectDatabase, disconnectDatabase } from './config/database';
import { registrarEncerramento } from './shutdown';

// Ponto de entrada: o UNICO lugar com process.exit e o unico que liga as pecas.
// Nenhum modulo importado aqui le o ambiente em tempo de import, entao qualquer
// falha de configuracao ou conexao chega ao catch abaixo.
bootstrap({ loadConfig, connectDatabase, createApp: construirApp })
  .then((server) => {
    registrarEncerramento({
      fecharServidor: () =>
        new Promise<void>((resolve, reject) => {
          server.close((erro) => (erro ? reject(erro) : resolve()));
        }),
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
