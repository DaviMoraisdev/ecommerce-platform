import dotenv from 'dotenv';
import { assertBancoDeTeste } from './test-db-guard';

// dotenv.config NAO lanca quando o arquivo nao existe — ele devolve { error }.
// Ignorar esse retorno foi exatamente a falha apontada no review do Bloco 1.
const resultado = dotenv.config({ path: '.env.test', override: true, quiet: true });

if (resultado.error) {
  throw new Error(
    'Suite de integracao ABORTADA: .env.test nao pode ser lido. Sem ele, os testes ' +
      'destrutivos rodariam contra o banco herdado do ambiente. Causa: ' +
      resultado.error.message,
  );
}

// Roda ANTES de qualquer import de src/config/database, porque este arquivo
// esta em setupFilesAfterEach e o Prisma so e construido no import do teste.
assertBancoDeTeste(process.env);
