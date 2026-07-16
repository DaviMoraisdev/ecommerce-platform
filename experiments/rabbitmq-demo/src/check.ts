import dotenv from 'dotenv';
dotenv.config();

import { connect } from './connection';

async function main() {
  const conn = await connect();
  console.log('Conectado ao RabbitMQ com sucesso');
  await conn.close();
  console.log('Conexao fechada');
}

main().catch((err) => {
  console.error('Falha ao conectar:', err instanceof Error ? err.message : err);
  process.exit(1);
});
