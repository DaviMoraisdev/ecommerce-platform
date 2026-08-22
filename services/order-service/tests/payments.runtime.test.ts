import { montarTopologia, executarAcao, ChannelLike } from '../src/events/payments.runtime';
import {
  EXCHANGE_PAGAMENTOS,
  QUEUE_PAGAMENTOS,
  DLX_PAGAMENTOS,
  DLQ_PAGAMENTOS,
  BINDING_PAYMENT_CAPTURED,
} from '../src/events/payments.topology';

function canalFalso() {
  return {
    assertExchange: jest.fn(async () => undefined),
    assertQueue: jest.fn(async () => undefined),
    bindQueue: jest.fn(async () => undefined),
    prefetch: jest.fn(async () => undefined),
    ack: jest.fn(),
    nack: jest.fn(),
  } satisfies ChannelLike & Record<string, unknown>;
}

describe('montarTopologia', () => {
  it('CASO C10: declara DLX e DLQ antes de ligar a fila principal', async () => {
    // Sem dead-letter, uma mensagem rejeitada some. Erro silencioso: a fila
    // sobe, o consumidor loga "consumindo", e a mensagem ruim evapora.
    const ch = canalFalso();
    await montarTopologia(ch);

    expect(ch.assertExchange).toHaveBeenCalledWith(DLX_PAGAMENTOS, 'fanout', { durable: true });
    expect(ch.assertQueue).toHaveBeenCalledWith(DLQ_PAGAMENTOS, { durable: true });
    expect(ch.bindQueue).toHaveBeenCalledWith(DLQ_PAGAMENTOS, DLX_PAGAMENTOS, '');
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
