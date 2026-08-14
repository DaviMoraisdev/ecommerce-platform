// Validacao de ambiente em funcoes puras e testaveis: lancam em vez de chamar
// process.exit, o que permite testar sem matar o processo de teste. O exit fica
// no ponto de entrada (server.ts).
const REQUIRED_ENV = ['MONGO_URI', 'JWT_SECRET'];

/**
 * Valores publicados em arquivos de exemplo do repositorio, ou genericos o
 * bastante para serem chutados. Recusados em QUALQUER ambiente: um segredo que
 * esta no repositorio e um segredo publico, e aceita-lo em desenvolvimento e o
 * cenario que permite forjar token com papel arbitrario.
 */
const JWT_PLACEHOLDERS = [
  'troque_este_segredo',
  'dev_jwt_secret_troque_em_producao',
  'sua_chave_secreta_aqui',
  'um_segredo_de_teste',
  'coloque-um-segredo-de-teste-aqui',
  'changeme',
  'change_me',
  'secret',
  'segredo',
  'test',
  'teste',
];

/** 32 caracteres. Recomendado: `openssl rand -hex 32` (64 caracteres). */
const JWT_TAMANHO_MINIMO = 32;

/**
 * Presenca e validada pelo chamador. Aqui:
 *   - placeholder conhecido -> recusa em qualquer ambiente;
 *   - tamanho minimo -> so em producao, para nao criar atrito em dev com um
 *     segredo curto ESCOLHIDO pelo operador (que nao e publico).
 */
export function assertJwtSecretForte(secret: string, nodeEnv: string): void {
  if (JWT_PLACEHOLDERS.includes(secret.trim().toLowerCase())) {
    throw new Error(
      'JWT_SECRET e um placeholder conhecido, publicado no repositorio. ' +
        'Gere um segredo real: openssl rand -hex 32',
    );
  }

  if (nodeEnv === 'production' && secret.length < JWT_TAMANHO_MINIMO) {
    throw new Error(
      `JWT_SECRET tem menos de ${JWT_TAMANHO_MINIMO} caracteres — insuficiente em producao`,
    );
  }
}

export function validateRequiredEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of REQUIRED_ENV) {
    const valor = env[key];
    if (!valor || valor.trim() === '') {
      throw new Error(`Variavel de ambiente obrigatoria ausente: ${key}`);
    }
  }

  assertJwtSecretForte(env.JWT_SECRET as string, env.NODE_ENV ?? 'development');
}
