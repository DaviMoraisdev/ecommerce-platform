import dotenv from 'dotenv';
import { assertTestDatabase } from './helpers/testDbGuard';

// dotenv.config NAO lanca quando o arquivo nao existe — devolve { error }.
// Ignorar esse retorno deixaria o DATABASE_URL herdado do ambiente assumir.
const resultado = dotenv.config({ path: '.env.test', override: true, quiet: true });

if (resultado.error) {
  throw new Error(
    'Suite ABORTADA: .env.test nao pode ser lido. Sem ele, os testes destrutivos ' +
      'rodariam contra o banco herdado do ambiente. Causa: ' + resultado.error.message,
  );
}

// Roda ANTES de qualquer import de config/database nos arquivos de teste.
// Aplicacao ESTRUTURAL: arquivo de integracao novo ja nasce protegido, sem
// depender de alguem lembrar de importar a guarda.
assertTestDatabase(process.env);
