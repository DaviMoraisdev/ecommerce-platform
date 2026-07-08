import dotenv from 'dotenv';
dotenv.config();

import app from './app';
import { loadConfig } from './config/env';

// process.exit fica AQUI, no entrypoint. loadConfig lanca excecao;
// aqui traduzimos para saida limpa com codigo de erro.
let config;
try {
  config = loadConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

app.listen(config.port, () => {
  console.log(`Cart service rodando na porta ${config.port}`);
});
