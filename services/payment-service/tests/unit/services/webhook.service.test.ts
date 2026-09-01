import {
  PaymentStatus,
  TransactionStatus,
  TransactionType,
  WebhookStatus,
  type Payment,
  type PaymentTransaction,
  type PrismaClient,
} from '@prisma/client';
import type { WebhookEventPayload } from '../../../src/providers/payment-provider.port';
import { WebhookService } from '../../../src/services/webhook.service';

/**
 * O que ESTE arquivo prova e a integracao NAO consegue provar.
 *
 * O CASO 22 da suite de integracao usa Promise.all e depende do escalonador:
 * se as duas requisicoes serializarem, a segunda le o estado ja atualizado e o
 * teste passa mesmo com o defeito presente. Verde por sorte nao e prova.
 *
 * Aqui o dublê forca `updateMany` a devolver `count: 0` — o CAS perdido —
 * de forma deterministica, e verifica o que o servico FAZ depois disso.
 */

const AGORA = new Date('2026-08-18T12:00:00.000Z');
const VALOR = 12990;

function pagamento(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay_1',
    orderId: 'ord_1',
    userId: 'usr_1',
    status: PaymentStatus.CAPTURED,
    amountCents: VALOR,
    capturedAmountCents: VALOR,
    refundedAmountCents: 0,
    currency: 'BRL',
    provider: 'fake',
    attemptCount: 1,
    expiresAt: new Date(AGORA.getTime() + 900_000),
    // O `as Payment` abaixo aceita objeto INCOMPLETO, e foi assim que o campo
    // novo chegou como `undefined` a um caminho que esperava `null`. Duble que
    // mente sobre a forma esconde defeito ate ele virar 500 em producao.
    lastProviderEventAt: null,
    createdAt: AGORA,
    updatedAt: AGORA,
    ...overrides,
  } as Payment;
}

function autorizacao(): PaymentTransaction {
  return {
    id: 'tx_1',
    paymentId: 'pay_1',
    type: TransactionType.AUTHORIZE,
    status: TransactionStatus.SUCCEEDED,
    amountCents: VALOR,
    providerRef: 'ch_1',
    failureCode: null,
    failureMessage: null,
    createdAt: AGORA,
    updatedAt: AGORA,
  } as PaymentTransaction;
}

function eventoDeReembolso(total: number): WebhookEventPayload {
  return {
    providerEventId: 'evt_1',
    providerEventTypeBruto: 'refund.succeeded',
    providerCreatedAt: AGORA,
    raw: { id: 'evt_1' },
    eventType: 'refund.succeeded',
    providerRef: 'ch_1',
    state: 'SUCCEEDED',
    capturedAmountCents: VALOR,
    refundedAmountCents: total,
  } as unknown as WebhookEventPayload;
}

function eventoDeCaptura(overrides: Partial<WebhookEventPayload> = {}): WebhookEventPayload {
  return {
    providerEventId: 'evt_2',
    providerEventTypeBruto: 'payment.succeeded',
    providerCreatedAt: AGORA,
    raw: { id: 'evt_2' },
    eventType: 'payment.succeeded',
    providerRef: 'ch_1',
    state: 'SUCCEEDED',
    capturedAmountCents: VALOR,
    refundedAmountCents: 0,
    ...overrides,
  } as unknown as WebhookEventPayload;
}

interface Criada {
  type?: TransactionType;
  amountCents?: number;
}

/**
 * `leituras` alimenta cada chamada de `payment.findUniqueOrThrow` em ordem: a
 * primeira e a leitura inicial, as seguintes sao as RELEITURAS apos CAS perdido.
 * `contagens` alimenta cada `updateMany` — e assim que se force a corrida.
 */
function montar(
  leituras: Payment[],
  contagens: number[],
  erroNaTransacao?: Error,
  transacao: PaymentTransaction | null = autorizacao(),
  /** Tentativas JA registradas na linha. Serve para posicionar o teto do 6c. */
  tentativasIniciais = 0,
  /** Quando a linha do inbox foi recebida. Posiciona a quarentena por idade. */
  recebidoEm: Date = new Date(),
) {
  const criadas: Criada[] = [];
  const inbox: Record<string, unknown>[] = [];
  const filtros: Record<string, unknown>[] = [];
  // Dois espioes com o MESMO nome de operacao, em clientes diferentes: e a
  // unica forma de distinguir "gravou dentro da transacao" de "gravou fora".
  const outboxNoTx = jest.fn(async () => ({}));
  const outboxForaDaTx = jest.fn(async () => ({}));
  let iLeitura = 0;
  let iCas = 0;

  const tx = {
    payment: { updateMany: jest.fn(async () => ({ count: contagens[iCas++] ?? 0 })) },
    paymentTransaction: {
      create: jest.fn(async ({ data }: { data: Criada }) => { criadas.push(data); return data; }),
      update: jest.fn(async () => ({})),
    },
    webhookEvent: {
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => { inbox.push(data); return data; }),
    },
    outboxEvent: { create: outboxNoTx },
  };

  let tentativas = tentativasIniciais;

  const prisma = {
    webhookEvent: {
      create: jest.fn(async () => ({ id: 'inbox_1' })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => { inbox.push(data); return data; }),
      updateMany: jest.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          filtros.push(where);

          // Modela o MINIMO do banco que o teto do Bloco 6c exige: `attempts` e
          // um contador real e o filtro `gte` e avaliado sobre ele. Sem isto o
          // duble devolveria count 1 para qualquer WHERE, a quarentena
          // "aconteceria" sempre, e qualquer teste dos dois lados do teto
          // provaria o duble em vez do servico.
          const minimo = (where.attempts as { gte?: number } | undefined)?.gte;
          if (typeof minimo === 'number' && tentativas < minimo) return { count: 0 };

          // Mesma razao do contador acima: sem modelar `receivedAt`, o duble
          // devolveria count 1 e a quarentena por idade "aconteceria" sempre,
          // inclusive sobre linha recem-criada.
          const antesDe = (where.receivedAt as { lt?: Date } | undefined)?.lt;
          if (antesDe instanceof Date && recebidoEm >= antesDe) return { count: 0 };

          const incremento = (data.attempts as { increment?: number } | undefined)?.increment;
          if (typeof incremento === 'number') tentativas += incremento;

          inbox.push(data);
          return { count: 1 };
        },
      ),
      findUniqueOrThrow: jest.fn(),
    },
    paymentTransaction: { findFirst: jest.fn(async () => transacao) },
    outboxEvent: { create: outboxForaDaTx },
    payment: {
      findUniqueOrThrow: jest.fn(async () =>
        leituras[Math.min(iLeitura++, leituras.length - 1)],
      ),
    },
    $transaction: jest.fn(async (cb: (t: unknown) => Promise<unknown>) => {
      if (erroNaTransacao) throw erroNaTransacao;
      return cb(tx);
    }),
  } as unknown as PrismaClient;

  return { service: new WebhookService({ prisma, tetoDeTentativas: 5, idadeMaximaMinutos: 60 }), criadas, inbox, filtros, tx, outboxNoTx, outboxForaDaTx };
}

describe('WebhookService — CAS perdido no reembolso (achado 4.1)', () => {
  it('recarrega o estado e aplica o delta correto em vez de descartar o evento', async () => {
    // Dois eventos concorrentes: 5000 vence o CAS, 7000 perde. Sem releitura,
    // o de 7000 vira IGNORED com 200 e o banco fica ABAIXO do reembolso real.
    const { service, criadas } = montar(
      [pagamento({ refundedAmountCents: 0 }), pagamento({ refundedAmountCents: 5000 })],
      [0, 1],
    );

    const resultado = await service.processar('fake', eventoDeReembolso(7000));

    expect(resultado.status).toBe(WebhookStatus.PROCESSED);
    const reembolsos = criadas.filter((c) => c.type === TransactionType.REFUND);
    expect(reembolsos).toHaveLength(1);
    // Delta sobre o estado RECARREGADO: 7000 - 5000. Reaplicar 7000 inteiro
    // duplicaria o valor na trilha.
    expect(reembolsos[0].amountCents).toBe(2000);
  });

  it('trata como replay quando a releitura ja reflete o total do evento', async () => {
    const { service, criadas } = montar(
      [pagamento({ refundedAmountCents: 0 }), pagamento({ refundedAmountCents: 7000 })],
      [0],
    );

    const resultado = await service.processar('fake', eventoDeReembolso(7000));

    expect(resultado.status).toBe(WebhookStatus.PROCESSED);
    // Delta zero: nada a mover, e nenhuma linha nova na trilha.
    expect(criadas.filter((c) => c.type === TransactionType.REFUND)).toHaveLength(0);
  });
});

describe('WebhookService — CAS perdido na transicao de status (achado 4.2)', () => {
  it('marca como RETENTAVEL quando a transicao continua permitida apos releitura', async () => {
    // Perder a corrida nao significa que o evento e obsoleto. Se depois da
    // releitura a transicao AINDA e permitida, encerrar como IGNORED com 200
    // descartaria um efeito financeiro que deveria acontecer.
    const emVoo = pagamento({ status: PaymentStatus.PROCESSING, capturedAmountCents: 0 });
    const { service } = montar([emVoo, emVoo], [0]);

    const resultado = await service.processar('fake', eventoDeCaptura());

    expect(resultado.retentavel).toBe(true);
    expect(resultado.status).toBe(WebhookStatus.RECEIVED);
  });
});

describe('WebhookService — ordenacao fina por providerCreatedAt (Bloco 6d)', () => {
  const UMA_HORA = 3_600_000;

  it('CASO U1: evento com o MESMO instante do marcador e obsoleto', async () => {
    // A comparacao e `<=`, nao `<`. Dois eventos com o mesmo providerCreatedAt
    // nao tem ordem entre si — aplicar o segundo seria escolher no escuro, e o
    // primeiro ja aplicou. Com `<`, o segundo passaria.
    const { service, inbox } = montar(
      [pagamento({ status: PaymentStatus.PROCESSING, capturedAmountCents: 0, lastProviderEventAt: AGORA })],
      [],
    );

    const resultado = await service.processar('fake', eventoDeCaptura({ providerCreatedAt: AGORA }));

    expect(resultado.status).toBe(WebhookStatus.IGNORED);
    // Motivo PROPRIO do empate: dizer "anterior" sobre dois eventos do mesmo
    // instante grava informacao errada no campo que a triagem le.
    expect(String(resultado.motivo)).toContain('mesmo instante do ultimo evento aplicado');
    expect(inbox.find((d) => d.status === WebhookStatus.IGNORED)).toBeDefined();
  });

  it('CASO U2: evento ANTERIOR ao marcador nao e aplicado', async () => {
    // A maquina de estados nao pega este caso: a transicao continua permitida.
    // Quem distingue os dois eventos e o instante em que o PROVEDOR os gerou.
    const { service } = montar(
      [
        pagamento({
          status: PaymentStatus.PROCESSING,
          capturedAmountCents: 0,
          lastProviderEventAt: new Date(AGORA.getTime() + UMA_HORA),
        }),
      ],
      [],
    );

    const resultado = await service.processar('fake', eventoDeCaptura({ providerCreatedAt: AGORA }));

    expect(resultado.status).toBe(WebhookStatus.IGNORED);
  });

  it('CASO U5: providerCreatedAt muito no futuro nao vira marcador', async () => {
    // Achado 3.1 do review do PR #59. A assinatura prova a ORIGEM dos bytes,
    // nao a PLAUSIBILIDADE do valor. Como o campo vira marcador PERSISTENTE, um
    // unico evento com timestamp absurdo bloquearia todas as transicoes
    // seguintes daquele pagamento — negacao de servico por pagamento, terminal.
    const { service, tx } = montar(
      [pagamento({ status: PaymentStatus.PROCESSING, capturedAmountCents: 0, lastProviderEventAt: null })],
      [],
    );

    const resultado = await service.processar(
      'fake',
      eventoDeCaptura({ providerCreatedAt: new Date(Date.now() + 60 * 60_000) }),
    );

    expect(resultado.status).toBe(WebhookStatus.IGNORED);
    expect(String(resultado.motivo)).toContain('alem da tolerancia de futuro');
    // Nem chega a abrir a transacao: o marcador NAO avanca.
    expect(tx.payment.updateMany).not.toHaveBeenCalled();
  });

  it('CASO U6: dentro da tolerancia, desvio de relogio nao impede a aplicacao', async () => {
    // Contraparte do U5. Sem ela, uma tolerancia zerada (ou invertida) recusaria
    // todo evento e a suite continuaria verde pelo lado errado — relogio de
    // provedor adiantado em segundos e normal, nao anomalia.
    const { service } = montar(
      [pagamento({ status: PaymentStatus.PROCESSING, capturedAmountCents: 0, lastProviderEventAt: null })],
      [1],
    );

    const resultado = await service.processar(
      'fake',
      eventoDeCaptura({ providerCreatedAt: new Date(Date.now() + 60_000) }),
    );

    expect(resultado.status).toBe(WebhookStatus.PROCESSED);
  });

  it('CASO U4: perder o CAS e reler um marcador MAIS NOVO encerra como obsoleto', async () => {
    // Perder o CAS nao prova obsolescencia (achado 4.2 do Bloco 4), por isso ha
    // releitura. Mas se a releitura mostra um marcador mais novo, o evento E
    // obsoleto: sem esta checagem o fluxo devolveria "retentavel" e o provedor
    // reentregaria para sempre um evento que nunca podera ser aplicado — laco
    // que so pararia no teto do 6c, e como quarentena, nao como decisao.
    const { service } = montar(
      [
        pagamento({ status: PaymentStatus.PROCESSING, capturedAmountCents: 0, lastProviderEventAt: null }),
        pagamento({
          status: PaymentStatus.PROCESSING,
          capturedAmountCents: 0,
          lastProviderEventAt: new Date(AGORA.getTime() + UMA_HORA),
        }),
      ],
      [0],
    );

    const resultado = await service.processar('fake', eventoDeCaptura({ providerCreatedAt: AGORA }));

    expect(resultado.status).toBe(WebhookStatus.IGNORED);
    expect(String(resultado.motivo)).toContain('anterior ao ultimo ja aplicado');
  });

  it('CASO U3: sem marcador, aplica — e o CAS carrega a condicao e o novo marcador', async () => {
    // Assercao ESTRUTURAL sobre a consulta: a condicao tem de viver no WHERE,
    // nao so no ramo em JavaScript. Sem ela, entre a leitura e a escrita outro
    // evento pode avancar o marcador e este sobrescreveria o efeito dele.
    const { service, tx } = montar(
      [pagamento({ status: PaymentStatus.PROCESSING, capturedAmountCents: 0, lastProviderEventAt: null })],
      [1],
    );

    const resultado = await service.processar('fake', eventoDeCaptura({ providerCreatedAt: AGORA }));
    expect(resultado.status).toBe(WebhookStatus.PROCESSED);

    const [argumentos] = (tx.payment.updateMany as jest.Mock).mock.calls[0];
    expect(argumentos.where.OR).toEqual([
      { lastProviderEventAt: null },
      { lastProviderEventAt: { lt: AGORA } },
    ]);
    // O marcador avanca na MESMA instrucao do efeito.
    expect(argumentos.data.lastProviderEventAt).toEqual(AGORA);
  });
});

describe('WebhookService — teto de tentativas (Bloco 6c)', () => {
  it('CASO T1: ao atingir o teto, a linha vai para QUARANTINED e o erro NAO propaga', async () => {
    // Falha DETERMINISTICA lanca a cada reentrega, a rota responde 5xx e o
    // provedor reentrega — laco sem fim, reprocessando o evento inteiro a cada
    // volta. Ao atingir o teto a rota precisa responder 200 para o provedor
    // parar, e para isso o erro NAO pode propagar. E a unica diferenca
    // observavel entre "ainda tentando" e "desistimos".
    const falha = new Error('relation "payments" does not exist at character 42');
    const { service, inbox } = montar(
      [pagamento({ status: PaymentStatus.PROCESSING, capturedAmountCents: 0 })],
      [],
      falha,
      autorizacao(),
      4, // quatro tentativas ja registradas: esta falha fecha o teto de 5
    );

    const resultado = await service.processar('fake', eventoDeCaptura());

    expect(resultado.status).toBe(WebhookStatus.QUARANTINED);
    expect(resultado.retentavel).toBeUndefined();

    const quarentena = inbox.find((d) => d.status === WebhookStatus.QUARANTINED);
    expect(quarentena).toBeDefined();
    expect(String(quarentena?.lastError)).toContain('teto de 5 tentativas atingido');
    // A mensagem original do banco nao pode vazar nem por este caminho: o
    // lastError da quarentena carrega o ultimo erro JA sanitizado.
    expect(JSON.stringify(quarentena)).not.toContain('relation');
  });

  it('CASO T2: uma tentativa abaixo do teto continua propagando o erro', async () => {
    // Contraparte do T1. Sem este caso, trocar o `gte` por `gt` (ou o teto por
    // zero) passaria despercebido em uma das duas direcoes.
    const falha = new Error('falha transitoria');
    const { service, inbox } = montar(
      [pagamento({ status: PaymentStatus.PROCESSING, capturedAmountCents: 0 })],
      [],
      falha,
      autorizacao(),
      3, // esta falha leva a 4, ainda abaixo do teto de 5
    );

    await expect(service.processar('fake', eventoDeCaptura())).rejects.toThrow(falha);
    expect(inbox.find((d) => d.status === WebhookStatus.QUARANTINED)).toBeUndefined();
  });
});

describe('WebhookService — quarentena por idade (Bloco 6c)', () => {
  /** Sem transacao => providerRef ainda desconhecido => desfecho retentavel. */
  function retentavel(recebidoEm: Date) {
    return montar(
      [pagamento({ status: PaymentStatus.PROCESSING, capturedAmountCents: 0 })],
      [],
      undefined,
      null,
      0,
      recebidoEm,
    );
  }

  it('CASO T3: evento retentavel ha tempo demais vai para QUARANTINED', async () => {
    // Esta populacao NAO passa pelo catch, entao `attempts` nunca sobe e o teto
    // nunca a alcanca (achado 4.5 do Bloco 4). Sem limite por idade ela gira ate
    // o provedor desistir sozinho, e nada do nosso lado registra que desistimos.
    const { service, inbox } = retentavel(new Date(Date.now() - 120 * 60_000));

    const resultado = await service.processar('fake', eventoDeCaptura());

    expect(resultado.status).toBe(WebhookStatus.QUARANTINED);
    expect(resultado.retentavel).toBeUndefined();

    const quarentena = inbox.find((d) => d.status === WebhookStatus.QUARANTINED);
    expect(String(quarentena?.lastError)).toContain('inaplicavel ha mais de 60 minutos');
    // O motivo ORIGINAL sobrevive: sem ele, a triagem sabe que desistimos e nao
    // sabe de que.
    expect(String(quarentena?.lastError)).toContain('providerRef ainda desconhecido');
  });

  it('CASO T4: evento retentavel RECENTE continua retentavel', async () => {
    // Contraparte do T3. O evento chega antes de o providerRef ser gravado —
    // situacao normal e frequente. Quarentenar aqui descartaria uma captura que
    // seria aplicada segundos depois, e quarentena e terminal.
    const { service, inbox } = retentavel(new Date());

    const resultado = await service.processar('fake', eventoDeCaptura());

    expect(resultado.retentavel).toBe(true);
    expect(resultado.status).toBe(WebhookStatus.RECEIVED);
    expect(inbox.find((d) => d.status === WebhookStatus.QUARANTINED)).toBeUndefined();
  });
});

describe('WebhookService — falha durante a aplicacao (achado 6.4)', () => {
  it('marca FAILED com mensagem sanitizada, incrementa attempts e propaga o erro', async () => {
    // A rota traduz a excecao em 500, e o provedor retenta. O caminho de falha
    // nao tinha NENHUM teste: nada provava que a linha nao fica presa em
    // RECEIVED nem que a mensagem original do banco fica fora do inbox.
    const falha = new Error('relation "payments" does not exist at character 42');
    const { service, inbox, filtros } = montar(
      [pagamento({ status: PaymentStatus.PROCESSING, capturedAmountCents: 0 })],
      [],
      falha,
    );

    await expect(service.processar('fake', eventoDeCaptura())).rejects.toThrow(falha);

    const marcacao = inbox.find((d) => d.status === WebhookStatus.FAILED);
    expect(marcacao).toBeDefined();
    expect(marcacao?.attempts).toEqual({ increment: 1 });
    // Erro de Prisma carrega nome de tabela e coluna, e o inbox e lido em
    // triagem operacional. A mensagem original nunca pode chegar la.
    expect(JSON.stringify(marcacao)).not.toContain('relation');

    // Assercao ESTRUTURAL (nao comportamental): a marcacao de FAILED so pode
    // atingir linha ainda nao concluida. Provar isso por comportamento exigiria
    // simular a execucao concorrente, o que so faz sentido com o claim
    // exclusivo do Bloco 6.
    const filtro = filtros.find((f) => f.status !== undefined);
    expect(filtro).toMatchObject({
      id: 'inbox_1',
      status: { in: [WebhookStatus.RECEIVED, WebhookStatus.FAILED] },
    });
  });
});

describe('WebhookService — exaustao do laco de reavaliacao (achado 6.2)', () => {
  it('esgota o limite e devolve RETENTAVEL sem criar trilha nem encerrar o inbox', async () => {
    // Contencao continua: todo CAS falha. O evento NAO pode virar terminal —
    // sem efeito aplicado, encerrar aqui perderia o reembolso de vez.
    const { service, criadas, inbox } = montar(
      [pagamento({ refundedAmountCents: 0 })],
      [0, 0, 0, 0],
    );

    const resultado = await service.processar('fake', eventoDeReembolso(7000));

    expect(resultado.retentavel).toBe(true);
    expect(resultado.status).toBe(WebhookStatus.RECEIVED);
    expect(criadas.filter((c) => c.type === TransactionType.REFUND)).toHaveLength(0);
    expect(inbox.some((d) => d.status === WebhookStatus.PROCESSED)).toBe(false);
    expect(inbox.some((d) => d.status === WebhookStatus.IGNORED)).toBe(false);
  });
});

describe('WebhookService — guarda de concorrencia no caminho retentavel (achado 4.1)', () => {
  it('so grava lastError de providerRef desconhecido em linha nao concluida', async () => {
    // Sem a guarda, uma execucao atrasada escreve "providerRef ainda
    // desconhecido" numa linha que a concorrente ja concluiu como PROCESSED.
    const { service, filtros } = montar([pagamento()], [], undefined, null);

    const resultado = await service.processar('fake', eventoDeCaptura());

    expect(resultado.retentavel).toBe(true);
    const filtro = filtros[filtros.length - 1];
    expect(filtro).toMatchObject({
      id: 'inbox_1',
      status: { in: [WebhookStatus.RECEIVED, WebhookStatus.FAILED] },
    });
  });
});

describe('WebhookService — outbox na MESMA transacao (achado R6)', () => {
  it('grava o evento pelo cliente da TRANSACAO, nunca pelo cliente solto', async () => {
    const emVoo = pagamento({ status: PaymentStatus.PROCESSING, capturedAmountCents: 0 });
    const { service, outboxNoTx, outboxForaDaTx } = montar([emVoo], [1]);

    const resultado = await service.processar('fake', eventoDeCaptura());

    expect(resultado.status).toBe(WebhookStatus.PROCESSED);
    expect(outboxNoTx).toHaveBeenCalledTimes(1);
    // Pelo cliente solto, o evento COMMITA sozinho: um efeito que reverte
    // deixaria o order-service sabendo de um pagamento que nao aconteceu.
    // O CASO 30 prova a direcao oposta (evento falha -> efeito nao fica);
    // esta e a simetrica, e ate a sabotagem R6 ela nao tinha prova nenhuma.
    expect(outboxForaDaTx).not.toHaveBeenCalled();
  });
});
