import { bootstrap } from './bootstrap';
import { construirApp, montarNucleo, type NucleoDoServico } from './composition';
import { montarDepsDeReconciliacao } from './jobs/reconciliacao.deps';
import { criarVarredura } from './jobs/reconciliacao';
import { tickInbox } from './jobs/inbox';
import { quarentenarOrfaos } from './jobs/inbox.repository';
import { startJobs, stopJobs } from './jobs/runtime';
import type { AppConfig } from './config/env';
import { loadConfig, VARREDURAS_POR_CICLO } from './config/env';
import { connectDatabase, disconnectDatabase } from './config/database';
import { registrarEncerramento } from './shutdown';
import { startOutboxRelay, stopOutboxRelay } from './events/outbox.relay';
import { closeEventPublisher, initEventPublisher, isPublisherReady, publish } from './events/publisher';
import { fetchPending, markRetry, markSent } from './events/outbox.repository';

// Ponto de entrada: o UNICO lugar com process.exit e o unico que liga as pecas.
// Toda VALIDACAO de ambiente mora no loadConfig, entao falha de configuracao
// ou de conexao chega ao catch abaixo em vez de explodir durante o import.
// Ressalva: publisher.ts e outbox.relay.ts leem process.env em tempo de import
// para os knobs de tuning (faixa fechada, default seguro, nada que afete
// seguranca). E por isso que os testes deles precisam de jest.resetModules().
/**
 * O nucleo e montado UMA vez e compartilhado entre o HTTP e o job.
 *
 * Memoizado porque o bootstrap chama iniciarRelay, iniciarJobs e
 * createApp em momentos diferentes — todos DEPOIS do connectDatabase, entao o
 * getPrisma() la dentro encontra o cliente conectado. Duas instancias fariam o
 * job nao enxergar as cobrancas do caminho HTTP quando o provedor for o fake.
 */
let nucleo: NucleoDoServico | null = null;
function obterNucleo(config: AppConfig): NucleoDoServico {
  if (nucleo === null) nucleo = montarNucleo(config);
  return nucleo;
}

bootstrap({
  loadConfig,
  connectDatabase,
  createApp: (config) => construirApp(config, obterNucleo(config)),
  // Sem broker configurado (permitido fora de producao) o relay nao sobe.
  iniciarRelay: (config) => {
    if (config.rabbitmqUrl === null) {
      console.warn('[payment-service] RABBITMQ_URL ausente: relay da outbox desativado');
      return;
    }
    const url = config.rabbitmqUrl;
    startOutboxRelay({
      isPublisherReady,
      initEventPublisher: () => initEventPublisher(url),
      publish,
      fetchPending,
      markSent,
      markRetry,
    });
  },
  iniciarJobs: (config) => {
    const { provider, service } = obterNucleo(config);
    const varreduras = [
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

    // A constante do invariante temporal (env.ts) precisa refletir a lista
    // real. Divergencia silenciosa aqui deixaria o boot aceitar configuracao
    // que quarentena antes de o job ter chance.
    if (varreduras.length !== VARREDURAS_POR_CICLO) {
      throw new Error(
        `VARREDURAS_POR_CICLO (${VARREDURAS_POR_CICLO}) diverge das ${varreduras.length} ` +
          'varreduras registradas; ajuste a constante em config/env.ts',
      );
    }

    startJobs(varreduras, {
      pollIntervalMs: config.jobsPollIntervalMs,
      stopTimeoutMs: config.jobsStopTimeoutMs,
      varreduraTimeoutMs: config.jobsVarreduraTimeoutMs,
    });
  },
})
  .then((server) => {
    registrarEncerramento({
      fecharServidor: () =>
        new Promise<void>((resolve, reject) => {
          server.close((erro) => (erro ? reject(erro) : resolve()));
        }),
      pararJobs: stopJobs,
      pararRelay: stopOutboxRelay,
      fecharPublisher: closeEventPublisher,
      desconectarBanco: disconnectDatabase,
    });
  })
  .catch((error: unknown) => {
    console.error(
      '[payment-service] Falha na inicializacao:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
