import { decidirEntrega, ResultadoAplicacao } from '../src/events/payments.consumer';
import { BINDING_PAYMENT_CAPTURED } from '../src/events/payments.topology';

function corpo(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventId: 'payment.captured:pay_1',
    paymentId: 'pay_1',
    orderId: 'ord_1',
    amountCents: 10000,
    capturedAmountCents: 10000,
    currency: 'BRL',
    occurredAt: '2026-08-22T12:00:00.000Z',
    ...over,
  });
}

function deps(resultado: ResultadoAplicacao | Error) {
  return {
    aplicar: jest.fn(async () => {
      if (resultado instanceof Error) throw resultado;
      return resultado;
    }),
  };
}

describe('decidirEntrega — traducao de resultado em acao no broker', () => {
  it('CASO C1: duplicata e ack, nao reprocessamento', async () => {
    // A trava e o @unique do inbox: a transacao inteira aborta, entao o efeito
    // nao repete. Para o broker isso e sucesso — a mensagem ja teve efeito.
    const d = deps({ tipo: 'duplicata' });
    await expect(decidirEntrega(corpo(), BINDING_PAYMENT_CAPTURED, d)).resolves.toEqual(
      expect.objectContaining({ type: 'ack' }),
    );
  });

  it('CASO C2: payload invalido vai para a DLQ sem chamar o banco', async () => {
    // Requeue aqui e loop eterno: nenhuma tentativa futura conserta JSON quebrado.
    const d = deps({ tipo: 'aplicado' });
    await expect(decidirEntrega('{ nao e json', BINDING_PAYMENT_CAPTURED, d)).resolves.toEqual(
      expect.objectContaining({ type: 'nack-dlq' }),
    );
    await expect(
      decidirEntrega(corpo({ orderId: '' }), BINDING_PAYMENT_CAPTURED, d),
    ).resolves.toEqual(expect.objectContaining({ type: 'nack-dlq' }));
    expect(d.aplicar).not.toHaveBeenCalled();
  });

  it('CASO C3: pedido inexistente vai para a DLQ', async () => {
    // O payment so emite captura para pedido que ele consultou antes, entao
    // pedido inexistente e anomalia, nao corrida. Requeue seria loop.
    const d = deps({ tipo: 'pedido-inexistente' });
    await expect(decidirEntrega(corpo(), BINDING_PAYMENT_CAPTURED, d)).resolves.toEqual(
      expect.objectContaining({ type: 'nack-dlq' }),
    );
  });

  it('CASO C4: pedido ja PAGO e ack', async () => {
    // Efeito desejado ja existe. Nao e erro: e duplicata semantica.
    const d = deps({ tipo: 'ja-pago' });
    await expect(decidirEntrega(corpo(), BINDING_PAYMENT_CAPTURED, d)).resolves.toEqual(
      expect.objectContaining({ type: 'ack' }),
    );
  });

  it('CASO C5: pedido CANCELADO gera compensacao e ack', async () => {
    // Dinheiro capturado + pedido cancelado = estorno pendente, nao retry.
    const d = deps({ tipo: 'compensacao-registrada' });
    await expect(decidirEntrega(corpo(), BINDING_PAYMENT_CAPTURED, d)).resolves.toEqual(
      expect.objectContaining({ type: 'ack' }),
    );
  });

  it('CASO C6: falha do banco e requeue, NUNCA DLQ', async () => {
    // Indisponibilidade momentanea nao pode custar o evento.
    const d = deps(new Error('connection terminated unexpectedly'));
    await expect(decidirEntrega(corpo(), BINDING_PAYMENT_CAPTURED, d)).resolves.toEqual(
      expect.objectContaining({ type: 'nack-requeue' }),
    );
  });

  it('CASO C8: routing key fora do binding vai para a DLQ', async () => {
    // O binding e estrito; chegar outra coisa e sinal de topologia adulterada.
    const d = deps({ tipo: 'aplicado' });
    await expect(decidirEntrega(corpo(), 'payment.refunded', d)).resolves.toEqual(
      expect.objectContaining({ type: 'nack-dlq' }),
    );
    expect(d.aplicar).not.toHaveBeenCalled();
  });

  it('CASO C9: valor divergente vai para a DLQ', async () => {
    // Violacao de contrato entre servicos: exige olho humano, nao retry.
    const d = deps({ tipo: 'valor-divergente', esperadoCents: 10000, recebidoCents: 9900 });
    await expect(decidirEntrega(corpo(), BINDING_PAYMENT_CAPTURED, d)).resolves.toEqual(
      expect.objectContaining({ type: 'nack-dlq' }),
    );
  });

  it('nao vaza a credencial nem caracteres de controle no motivo', async () => {
    const d = deps({ tipo: 'aplicado' });
    const acao = await decidirEntrega(corpo(), 'payment.\u0007captured', d);
    expect(acao.reason).not.toContain('\u0007');
  });
});
