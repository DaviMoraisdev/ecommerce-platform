import { montarTopologia, executarAcao, ChannelLike } from '../src/events/payments.runtime';
import {
  EXCHANGE_PAGAMENTOS,
  QUEUE_PAGAMENTOS,
  DLX_PAGAMENTOS,
  DLQ_PAGAMENTOS,
  BINDING_PAYMENT_CAPTURED,
  BINDING_PAYMENT_EXPIRED,
} from '../src/events/payments.topology';

function canalFalso() {
  return {
    // Parametros DECLARADOS: sem eles o TS infere mock.calls como tupla vazia
    // e nao deixa inspecionar os argumentos.
    assertExchange: jest.fn(async (_nome: string, _tipo: string, _opts: object) => undefined),
    assertQueue: jest.fn(async (_nome: string, _opts: object) => undefined),
    bindQueue: jest.fn(async (_fila: string, _exchange: string, _chave: string) => undefined),
    prefetch: jest.fn(async (_n: number) => undefined),
    ack: jest.fn(),
    nack: jest.fn(),
  } satisfies ChannelLike & Record<string, unknown>;
}

describe('montarTopologia', () => {
  it('CASO C10: declara DLX e DLQ ANTES da fila principal, na ordem real', async () => {
    // Sem dead-letter, uma mensagem rejeitada some. E argumento de fila duravel
    // e IMUTAVEL: apontar para uma DLX inexistente so se corrige recriando a
    // fila. Por isso a ORDEM importa, nao so o conjunto de chamadas.
    const ch = canalFalso();
    await montarTopologia(ch);

    expect(ch.assertExchange).toHaveBeenCalledWith(DLX_PAGAMENTOS, 'fanout', { durable: true });
    expect(ch.assertQueue).toHaveBeenCalledWith(DLQ_PAGAMENTOS, { durable: true });
    expect(ch.bindQueue).toHaveBeenCalledWith(DLQ_PAGAMENTOS, DLX_PAGAMENTOS, '');

    // toHaveBeenCalledWith nao prova ordem nenhuma: o teste anterior continuaria
    // verde com a topologia declarada ao contrario. invocationCallOrder da a
    // sequencia global das chamadas entre mocks diferentes.
    const ordemDlx = ch.assertExchange.mock.invocationCallOrder[
      ch.assertExchange.mock.calls.findIndex((c) => c[0] === DLX_PAGAMENTOS)
    ];
    const ordemFila = ch.assertQueue.mock.invocationCallOrder[
      ch.assertQueue.mock.calls.findIndex((c) => c[0] === QUEUE_PAGAMENTOS)
    ];
    expect(ordemDlx).toBeLessThan(ordemFila);
  });

  it('CASO C11: fila principal aponta para a DLX e usa binding ESTRITO', async () => {
    const ch = canalFalso();
    await montarTopologia(ch);

    expect(ch.assertQueue).toHaveBeenCalledWith(QUEUE_PAGAMENTOS, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': DLX_PAGAMENTOS },
    });
    // Estrito, nao payment.*: evento futuro sem handler nao roteia, e o
    // publisher do payment (mandatory + basic.return) mantem PENDING e loga.
    expect(ch.bindQueue).toHaveBeenCalledWith(
      QUEUE_PAGAMENTOS,
      EXCHANGE_PAGAMENTOS,
      BINDING_PAYMENT_CAPTURED,
    );
    expect(ch.bindQueue).not.toHaveBeenCalledWith(
      QUEUE_PAGAMENTOS,
      EXCHANGE_PAGAMENTOS,
      'payment.*',
    );
  });

  it('CASO C34: a fila tem EXATAMENTE os bindings esperados, nem mais nem menos', async () => {
    // O CASO C11 usa toHaveBeenCalledWith, que prova que UMA chamada aconteceu e
    // nada sobre as outras: trocar o binding estrito por 'payment.*' o deixaria
    // verde, e apagar um binding tambem. Aqui o conjunto INTEIRO e fixado.
    //
    // Binding ausente e falha silenciosa da pior especie: o servico sobe, a fila
    // existe, e simplesmente nunca recebe aquele tipo de evento.
    const ch = canalFalso();
    await montarTopologia(ch);

    const chaves = ch.bindQueue.mock.calls
      .filter((c) => c[0] === QUEUE_PAGAMENTOS)
      .map((c) => c[2])
      .sort();

    expect(chaves).toEqual([BINDING_PAYMENT_CAPTURED, BINDING_PAYMENT_EXPIRED].sort());
  });


  it('CASO C12: prefetch limita o dano de um crash', async () => {
    // Sem prefetch o broker despeja a fila inteira no processo; um crash
    // devolve tudo de uma vez.
    const ch = canalFalso();
    await montarTopologia(ch);
    expect(ch.prefetch).toHaveBeenCalledWith(1);
  });
});

describe('executarAcao', () => {
  it('CASO C13: DLQ usa nack SEM requeue', async () => {
    // requeue=true aqui seria loop infinito: a mesma mensagem invalida volta
    // para a mesma fila para sempre.
    const ch = canalFalso();
    const msg = {};
    const atraso = jest.fn(async () => undefined);

    await executarAcao(ch, msg, { type: 'nack-dlq', reason: 'x' }, atraso);

    expect(ch.nack).toHaveBeenCalledWith(msg, false, false);
    expect(atraso).not.toHaveBeenCalled();
  });

  it('CASO C14: requeue espera antes de devolver', async () => {
    // Sem atraso, uma falha persistente vira hot loop consumindo CPU e log.
    const ch = canalFalso();
    const msg = {};
    const atraso = jest.fn(async () => undefined);

    await executarAcao(ch, msg, { type: 'nack-requeue', reason: 'x' }, atraso);

    expect(atraso).toHaveBeenCalled();
    expect(ch.nack).toHaveBeenCalledWith(msg, false, true);
  });

  it('CASO C15: ack nao mexe no nack', async () => {
    const ch = canalFalso();
    const msg = {};
    await executarAcao(ch, msg, { type: 'ack', reason: 'processado' }, async () => undefined);

    expect(ch.ack).toHaveBeenCalledWith(msg);
    expect(ch.nack).not.toHaveBeenCalled();
  });
});
