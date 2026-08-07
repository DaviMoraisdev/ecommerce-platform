/**
 * Guarda fail-closed para suites que executam escrita destrutiva (deleteMany).
 *
 * Motivacao: se o .env.test nao for carregado ou estiver mal configurado, o
 * DATABASE_URL herdado do ambiente assume e a suite apaga o banco de trabalho.
 * Em dominio financeiro/transacional isso e irreversivel.
 *
 * Sao QUATRO barreiras independentes, todas obrigatorias:
 *   1. nome EXATO do banco, lido do pathname da URL (nao substring: "test" no
 *      meio do nome ou dentro da senha nao vale)
 *   2. NODE_ENV=test
 *   3. ALLOW_TEST_DB_RESET=true — consentimento POSITIVO de quem configurou o
 *      ambiente. Nome de banco correto por acidente nao basta.
 *   4. host local, salvo ALLOW_REMOTE_TEST_DB=true
 *
 * Recebe o ambiente como parametro para ser testavel sem mutar process.env.
 */

export const BANCO_DE_TESTE = 'inventory_test_db';

// URL.hostname devolve endereco IPv6 ENTRE COLCHETES ("[::1]"). Sem a forma
// com colchetes, o allowlist ANUNCIARIA ::1 e o rejeitaria na pratica — bug
// encontrado ao escrever o teste de host IPv6 local.
const HOSTS_LOCAIS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export class GuardaDeBancoError extends Error {
  constructor(message: string) {
    super(
      'Suite de teste ABORTADA para proteger dados: ' +
        message +
        ' — nenhuma escrita destrutiva foi executada.',
    );
    this.name = 'GuardaDeBancoError';
  }
}

export function assertTestDatabase(env: NodeJS.ProcessEnv = process.env): void {
  const url = env.DATABASE_URL;

  if (!url || url.trim() === '') {
    throw new GuardaDeBancoError('DATABASE_URL ausente (o .env.test foi carregado?)');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Nunca interpolamos a URL na mensagem: ela contem a senha.
    throw new GuardaDeBancoError('DATABASE_URL nao e uma URL valida');
  }

  const nomeDoBanco = parsed.pathname.startsWith('/')
    ? parsed.pathname.slice(1)
    : parsed.pathname;

  if (nomeDoBanco !== BANCO_DE_TESTE) {
    throw new GuardaDeBancoError(
      `banco alvo e "${nomeDoBanco}", esperado "${BANCO_DE_TESTE}"`,
    );
  }

  if (env.NODE_ENV !== 'test') {
    throw new GuardaDeBancoError(
      `NODE_ENV e "${env.NODE_ENV ?? '(ausente)'}", esperado "test"`,
    );
  }

  if (env.ALLOW_TEST_DB_RESET !== 'true') {
    throw new GuardaDeBancoError(
      'ALLOW_TEST_DB_RESET nao e "true" — apagar dados exige consentimento explicito no .env.test',
    );
  }

  if (!HOSTS_LOCAIS.has(parsed.hostname) && env.ALLOW_REMOTE_TEST_DB !== 'true') {
    throw new GuardaDeBancoError(
      `host "${parsed.hostname}" nao e local; defina ALLOW_REMOTE_TEST_DB=true para permitir`,
    );
  }
}
