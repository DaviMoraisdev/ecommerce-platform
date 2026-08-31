import { tickInbox } from '../../../src/jobs/inbox';

describe('tickInbox', () => {
  it('CASO N1: o limite e AGORA menos a idade configurada', async () => {
    // Limite invertido varreria eventos RECENTES e os quarentenaria — e a
    // quarentena e terminal, entao o erro nao seria recuperavel sozinho.
    const quarentenarOrfaos = jest.fn(async (_limite: Date, _lote: number) => 0);
    await tickInbox({
      quarentenarOrfaos,
      idadeMinutos: 60,
      agora: () => new Date('2026-08-30T12:00:00.000Z'),
    });

    const [limite] = quarentenarOrfaos.mock.calls[0];
    expect(limite).toEqual(new Date('2026-08-30T11:00:00.000Z'));
  });

  it('CASO N2: usa lote 100 por padrao e respeita a faixa', async () => {
    const quarentenarOrfaos = jest.fn(async (_limite: Date, _lote: number) => 0);
    await tickInbox({ quarentenarOrfaos, idadeMinutos: 60 });
    expect(quarentenarOrfaos.mock.calls[0][1]).toBe(100);

    await tickInbox({ quarentenarOrfaos, idadeMinutos: 60, lote: 7 });
    expect(quarentenarOrfaos.mock.calls[1][1]).toBe(7);

    // Fora da faixa cai no padrao, em vez de virar consulta sem limite.
    await tickInbox({ quarentenarOrfaos, idadeMinutos: 60, lote: 0 });
    expect(quarentenarOrfaos.mock.calls[2][1]).toBe(100);
  });

  it('CASO N3: o resumo conta o que foi quarentenado', async () => {
    const resumo = await tickInbox({
      quarentenarOrfaos: jest.fn(async () => 3),
      idadeMinutos: 60,
    });
    expect(resumo).toEqual({ quarentenadas: 3 });
  });
});
