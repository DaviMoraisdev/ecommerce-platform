import dotenv from 'dotenv';

// Suite UNITARIA: nao toca o banco. Carrega o .env.test apenas para o caso de
// algum teste ler variavel de ambiente; a guarda de banco vive em
// setup.integration.ts, onde existe o perigo.
dotenv.config({ path: '.env.test', override: true, quiet: true });
