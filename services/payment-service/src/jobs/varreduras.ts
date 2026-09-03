import type { AppConfig } from '../config/env';
import type { PaymentProvider } from '../providers/payment-provider.port';
import type { PaymentService } from '../services/payment.service';
import { criarVarredura } from './reconciliacao';
import { montarDepsDeReconciliacao } from './reconciliacao.deps';
import { criarVarreduraDeExpiracao } from './expiracao';
import { montarDepsDeExpiracao } from './expiracao.deps';
import { quarentenarOrfaos } from './inbox.repository';
import { tickInbox } from './inbox';
import type { Varredura } from './runtime';

/**
 * Monta a lista de varreduras do ciclo.
 *
 * Extraida do `server.ts` no Bloco 6e (achados 4.1 e testes 3-4 da 2a rodada).
 * Enquanto vivia la dentro, a lista nao tinha teste: o `bootstrap.test.ts`
 * injeta as deps e nunca alcanca esta fiacao — o MESMO buraco do achado Q-4 do
 * Bloco 6b, que fez `montarDepsDeReconciliacao` existir.
 */
export function montarVarreduras(
  provider: PaymentProvider,
  service: PaymentService,
  config: AppConfig,
): Varredura[] {
  const varreduras: Varredura[] = [
    {
      nome: 'reconciliacao',
      executar: criarVarredura(
        montarDepsDeReconciliacao(provider, service, config.paymentWindowMinutes),
      ),
    },
    {
      nome: 'inbox',
      executar: () =>
        tickInbox({
          quarentenarOrfaos,
          idadeMinutos: config.webhookQuarantineMinutes,
        }),
    },
  ];

  // A varredura produz EXPIRED e a saga ainda nao recebe esse desfecho. Ligada
  // antes do 6f, cada expiracao vira registro sem evento de outbox — passivo
  // historico que acrescentar o produtor depois NAO recupera.
  if (config.expiracaoHabilitada) {
    varreduras.push({
      nome: 'expiracao',
      executar: criarVarreduraDeExpiracao(
        montarDepsDeExpiracao(provider, service, config.paymentWindowMinutes),
      ),
    });
  } else {
    // INFO e nao WARN (achado 5.2 da 2a rodada): este e o caminho ESPERADO ate
    // o 6f. WARN em todo boot normal treina o operador a ignorar WARN.
    console.info(
      '[payment-service] varredura de EXPIRACAO desativada (PAYMENT_EXPIRATION_ENABLED != true). ' +
        'Ative apenas depois que payment.expired tiver produtor e consumidor (Bloco 6f).',
    );
  }

  // Igualdade ESTRITA contra o valor derivado da flag. A margem temporal do boot
  // foi calculada para exatamente este numero de varreduras: mais invalida a
  // folga, menos indica que a config e o codigo divergiram.
  if (varreduras.length !== config.varredurasPorCiclo) {
    throw new Error(
      `varredurasPorCiclo (${config.varredurasPorCiclo}) diverge das ` +
        `${varreduras.length} varreduras registradas. O invariante temporal do boot ` +
        'foi calculado com esse numero; divergencia invalida a margem da quarentena.',
    );
  }

  return varreduras;
}
