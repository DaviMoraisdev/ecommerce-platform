import { montarVarreduras } from '../../../src/jobs/varreduras';
import { configDeTeste } from '../../helpers/config';
import type { PaymentProvider } from '../../../src/providers/payment-provider.port';
import type { PaymentService } from '../../../src/services/payment.service';

const provider = {} as PaymentProvider;
const service = {} as PaymentService;

describe('montarVarreduras', () => {
  it('CASO V1: flag DESLIGADA registra apenas reconciliacao e inbox', () => {
    const config = configDeTeste({ expiracaoHabilitada: false, varredurasPorCiclo: 2 });
    expect(montarVarreduras(provider, service, config).map((v) => v.nome)).toEqual([
      'reconciliacao',
      'inbox',
    ]);
  });

  it('CASO V2: flag LIGADA registra a expiracao, exatamente UMA vez', () => {
    const config = configDeTeste({ expiracaoHabilitada: true, varredurasPorCiclo: 3 });
    const nomes = montarVarreduras(provider, service, config).map((v) => v.nome);
    expect(nomes).toEqual(['reconciliacao', 'inbox', 'expiracao']);
  });

  it('CASO V3: lista MAIOR que o previsto quebra o boot', () => {
    // A margem temporal da quarentena foi calculada para um numero exato de
    // varreduras. Mais que isso invalida a folga e quarentena evento que seria
    // resolvido — e a quarentena e terminal.
    const config = configDeTeste({ expiracaoHabilitada: true, varredurasPorCiclo: 2 });
    expect(() => montarVarreduras(provider, service, config)).toThrow(/diverge/);
  });

  it('CASO V4: lista MENOR que o previsto TAMBEM quebra o boot', () => {
    // A versao anterior usava `>` e deixava este caso passar calado, com margem
    // maior que a necessaria. Nao e perigoso, mas indica que config e codigo
    // divergiram — e divergencia silenciosa foi o que criou o achado 4.1.
    const config = configDeTeste({ expiracaoHabilitada: false, varredurasPorCiclo: 3 });
    expect(() => montarVarreduras(provider, service, config)).toThrow(/diverge/);
  });
});
