// Validacao de ambiente em funcoes puras e testaveis (lancam em vez de
// process.exit — testavel sem matar o processo, e reutilizavel).
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET'];
// Valores publicados no repositorio ou genericos. Recusados em QUALQUER
// ambiente: segredo que esta no repositorio e segredo publico.
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

export function validateRequiredEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of REQUIRED_ENV) {
    const value = env[key];
    if (!value || value.trim() === '') {
      throw new Error('Variavel de ambiente obrigatoria ausente: ' + key);
    }
  }
  const secret = env.JWT_SECRET as string;
  const nodeEnv = env.NODE_ENV || 'development';

  // Placeholder: recusado em QUALQUER ambiente.
  if (JWT_PLACEHOLDERS.includes(secret.trim().toLowerCase())) {
    throw new Error(
      'JWT_SECRET e um placeholder conhecido, publicado no repositorio. ' +
        'Gere um segredo real: openssl rand -hex 32',
    );
  }

  // Tamanho: so em producao.
  if (nodeEnv === 'production' && secret.length < JWT_TAMANHO_MINIMO) {
    throw new Error(
      `JWT_SECRET tem menos de ${JWT_TAMANHO_MINIMO} caracteres — insuficiente em producao`,
    );
  }
}

export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ORDER_PORT || '3006';
  // Exige inteiro integral (rejeita "3006abc", "1.5"): so digitos.
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error('ORDER_PORT invalido: ' + raw);
  }
  const port = parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('ORDER_PORT invalido: ' + raw);
  }
  return port;
}
