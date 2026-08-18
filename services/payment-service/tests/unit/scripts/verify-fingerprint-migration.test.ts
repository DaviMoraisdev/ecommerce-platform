import { createHash } from 'node:crypto';

import {
  argumentosPsql,
  assertIdentificadorSeguro,
  fingerprintEsperado,
  nomeDescartavel,
  VerificacaoFalhou,
} from '../../../scripts/verify-fingerprint-migration';

describe('nome do banco descartavel', () => {
  it('usa prefixo proprio e sufixo do gerador', () => {
    expect(nomeDescartavel(() => 'abc123')).toBe('payment_migration_check_abc123');
  });

  it('muda a cada execucao, para nao colidir com banco alheio', () => {
    // Nome fixo com DROP DATABASE IF EXISTS apagaria um banco preexistente de
    // mesmo nome — achado 4.2 do terceiro review do PR #52.
    expect(nomeDescartavel()).not.toBe(nomeDescartavel());
  });

  it.each([
    ['ponto e virgula', 'banco; DROP DATABASE producao'],
    ['aspas', 'banco"x'],
    ['maiuscula inicial', 'Banco'],
    ['hifen', 'payment-check'],
    ['vazio', ''],
    ['comeca com numero', '1banco'],
    ['longo demais', 'a'.repeat(64)],
  ])('recusa identificador com %s', (_rotulo, nome) => {
    // CREATE DATABASE nao aceita parametro vinculado: o nome entra no texto do
    // SQL, entao o charset e validado e nao se confia no gerador.
    expect(() => assertIdentificadorSeguro(nome)).toThrow(VerificacaoFalhou);
  });

  it('recusa nome gerado invalido mesmo vindo do proprio gerador', () => {
    expect(() => nomeDescartavel(() => 'x; DROP')).toThrow(VerificacaoFalhou);
  });
});

describe('argumentos do psql', () => {
  const SENHA = 'senha_secreta_do_postgres';

  it('NAO carrega a senha em nenhum argumento', () => {
    const args = argumentosPsql('usuario', 'banco');

    // Achado 3.2: com a senha no argv ela fica visivel em `ps`. Ela viaja no env
    // do processo filho, e o docker recebe o NOME da variavel, nao o valor.
    expect(args.join(' ')).not.toContain(SENHA);
    expect(args.join(' ')).not.toContain('PGPASSWORD=');
  });

  it('encaminha PGPASSWORD pelo ambiente, como argumentos separados', () => {
    const args = argumentosPsql('usuario', 'banco');
    const i = args.indexOf('-e');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('PGPASSWORD');
  });

  it('mantem cada valor como argumento proprio, sem interpolacao de shell', () => {
    const args = argumentosPsql('usuario', 'banco', ['-1']);
    expect(args).toContain('usuario');
    expect(args).toContain('banco');
    expect(args).toContain('-1');
    // Nenhum argumento pode conter espaco: sinal de string montada a mao.
    expect(args.filter((a) => a.includes(' ') && !a.endsWith('.yml'))).toEqual([]);
  });
});

describe('receita do fingerprint', () => {
  it('e a mesma do servico', () => {
    expect(fingerprintEsperado('ord-alpha')).toBe(
      createHash('sha256').update('v1:ord-alpha').digest('hex'),
    );
  });
});
