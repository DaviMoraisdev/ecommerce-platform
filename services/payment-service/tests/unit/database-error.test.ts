import { sanitizeConnectionError } from '../../src/config/database-error';

const NOMES_CONHECIDOS = [
  'PrismaClientInitializationError',
  'PrismaClientKnownRequestError',
  'PrismaClientUnknownRequestError',
  'PrismaClientRustPanicError',
  'PrismaClientValidationError',
];

function erroComNome(nome: string, mensagem = 'detalhe interno'): Error {
  const erro = new Error(mensagem);
  erro.name = nome;
  return erro;
}

describe('sanitizeConnectionError', () => {
  it.each(NOMES_CONHECIDOS)('preserva o nome conhecido %s', (nome) => {
    expect(sanitizeConnectionError(erroComNome(nome))).toBe(
      `Falha ao conectar ao banco de dados: ${nome}`,
    );
  });

  it.each([
    ['nome desconhecido', erroComNome('NomeQualquerInventado')],
    ['string solta', 'algo deu errado'],
    ['null', null],
    ['undefined', undefined],
    ['objeto simples', { name: 'PrismaClientInitializationError' }],
  ])('cai na categoria generica para %s', (_rotulo, entrada) => {
    expect(sanitizeConnectionError(entrada)).toBe(
      'Falha ao conectar ao banco de dados: DatabaseConnectionError',
    );
  });

  it('NUNCA repassa a mensagem original — e onde a senha vazaria', () => {
    const vazamento = erroComNome(
      'PrismaClientInitializationError',
      'auth failed for postgresql://admin:SenhaSuperSecreta@db:5432/payment_db',
    );
    const saida = sanitizeConnectionError(vazamento);

    expect(saida).not.toContain('SenhaSuperSecreta');
    expect(saida).not.toContain('postgresql://');
    expect(saida).not.toContain('admin');
  });
});
