import { bootstrap } from './bootstrap';
import { createApp } from './app';
import { loadConfig } from './config/env';
import { connectDatabase } from './config/database';

// Ponto de entrada: o UNICO lugar com process.exit e o unico que liga as pecas.
// Nenhum modulo importado aqui le o ambiente em tempo de import, entao qualquer
// falha de configuracao ou conexao chega a este catch.
bootstrap({ loadConfig, connectDatabase, createApp }).catch((error: unknown) => {
  console.error(
    '[payment-service] Falha na inicializacao:',
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
