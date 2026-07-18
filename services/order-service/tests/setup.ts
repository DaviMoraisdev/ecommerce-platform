import dotenv from 'dotenv';

// Aponta os testes para o banco ISOLADO antes de qualquer import do database.ts.
// override:true garante que o .env.test vence; o dotenv.config() do database.ts
// (sem override) nao sobrescreve o que ja esta setado.
dotenv.config({ path: '.env.test', override: true });
