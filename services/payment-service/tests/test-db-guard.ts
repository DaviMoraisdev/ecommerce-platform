/**
 * Guarda fail-closed para suites DESTRUTIVAS de integracao.
 *
 * Motivacao: os testes de integracao executam deleteMany(). Se o .env.test nao
 * for carregado, o DATABASE_URL herdado do ambiente (ou o .env de desenvolvimento)
 * assume, e a suite apaga o banco real. Em dominio financeiro isso e irreversivel.
 *
 * A guarda so deixa passar o que reconhece explicitamente. Qualquer duvida aborta.
 */

export const BANCO_DE_TESTE = 'payment_test_db';

const HOSTS_LOCAIS = new Set(['127.0.0.1', 'localhost', '::1']);

export class GuardaDeBancoError extends Error {
  constructor(message: string) {
    super(
      'Suite de integracao ABORTADA para proteger dados: ' +
        message +
        ' — nenhuma escrita destrutiva foi executada.',
    );
    this.name = 'GuardaDeBancoError';
  }
}

export function assertBancoDeTeste(env: NodeJS.ProcessEnv = process.env): void {
  const url = env.DATABASE_URL;

  if (!url || url.trim() === '') {
    throw new GuardaDeBancoError('DATABASE_URL ausente (o .env.test foi carregado?)');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Nao interpolamos a URL na mensagem: ela contem a senha.
    throw new GuardaDeBancoError('DATABASE_URL nao e uma URL valida');
  }

  const nomeDoBanco = parsed.pathname.replace(/^\//, '');
  if (nomeDoBanco !== BANCO_DE_TESTE) {
    throw new GuardaDeBancoError(
      `banco alvo e "${nomeDoBanco}", esperado "${BANCO_DE_TESTE}"`,
    );
  }

  // Mesmo criterio da suite e2e da Fase 4: destrutivo so contra localhost,
  // salvo opt-in explicito de quem sabe o que esta fazendo.
  const permiteRemoto = env.INTEGRATION_ALLOW_REMOTE === 'true';
  if (!HOSTS_LOCAIS.has(parsed.hostname) && !permiteRemoto) {
    throw new GuardaDeBancoError(
      `host "${parsed.hostname}" nao e local; defina INTEGRATION_ALLOW_REMOTE=true para permitir`,
    );
  }
}
