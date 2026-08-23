import { Prisma } from '@prisma/client';
import {
  decidirEntrega,
  decidirPorTamanho,
  MAX_PAYLOAD_BYTES,
  ResultadoAplicacao,
} from '../src/events/payments.consumer';
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

describe('decidirPorTamanho', () => {
  it('CASO C21: payload acima do limite vai para a DLQ sem ser convertido', () => {
    // prefetch(1) limita QUANTAS mensagens chegam, nao o TAMANHO de uma delas.
    expect(decidirPorTamanho(MAX_PAYLOAD_BYTES)).toBeNull();
    expect(decidirPorTamanho(MAX_PAYLOAD_BYTES + 1)).toEqual(
      expect.objectContaining({ type: 'nack-dlq' }),
    );
  });
});

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

  it('CASO C16: moeda divergente vai para a DLQ', async () => {
    // O order nao tem coluna de moeda: comparar numero com numero marcaria como
    // pago um valor em outra moeda.
    const d = deps({ tipo: 'moeda-divergente', esperada: 'BRL', recebida: 'USD' });
    await expect(decidirEntrega(corpo(), BINDING_PAYMENT_CAPTURED, d)).resolves.toEqual(
      expect.objectContaining({ type: 'nack-dlq' }),
    );
  });

  it('CASO C17: captura parcial vai para a DLQ', async () => {
    // O pedido so representa PAGO ou nao-PAGO. Aceitar parcial seria marcar
    // como pago com dinheiro faltando.
    const d = deps({ tipo: 'captura-parcial', autorizadoCents: 10000, capturadoCents: 5000 });
    await expect(decidirEntrega(corpo(), BINDING_PAYMENT_CAPTURED, d)).resolves.toEqual(
      expect.objectContaining({ type: 'nack-dlq' }),
    );
  });

  it('CASO C18: eventId que nao corresponde ao paymentId e recusado', async () => {
    // A chave de idempotencia PRECISA estar amarrada ao identificador
    // financeiro. Solta, o mesmo pagamento com outro eventId atravessa a trava
    // e um eventId reaproveitado descarta pagamento legitimo como duplicata.
    const d = deps({ tipo: 'aplicado' });
    const acao = await decidirEntrega(
      corpo({ eventId: 'payment.captured:outro' }),
      BINDING_PAYMENT_CAPTURED,
      d,
    );
    expect(acao.type).toBe('nack-dlq');
    expect(d.aplicar).not.toHaveBeenCalled();
  });

  it('CASO C19: inteiro fora da faixa segura e recusado', async () => {
    // Acima de 2**53 a aritmetica perde precisao em silencio: 2**53 e 2**53+1
    // sao o mesmo numero. Number.isInteger aceita, isSafeInteger nao.
    const d = deps({ tipo: 'aplicado' });
    const acao = await decidirEntrega(
      corpo({ amountCents: 2 ** 53, capturedAmountCents: 2 ** 53 }),
      BINDING_PAYMENT_CAPTURED,
      d,
    );
    expect(acao.type).toBe('nack-dlq');
    expect(d.aplicar).not.toHaveBeenCalled();
  });

  it('CASO C5: pedido CANCELADO gera compensacao e ack', async () => {
    // Dinheiro capturado + pedido cancelado = estorno pendente, nao retry.
    const d = deps({ tipo: 'compensacao-registrada', motivo: 'captura_apos_cancelamento:pay_1' });
    await expect(decidirEntrega(corpo(), BINDING_PAYMENT_CAPTURED, d)).resolves.toEqual(
      expect.objectContaining({ type: 'ack' }),
    );
  });

  it('CASO C6: falha transitoria do banco e requeue, NUNCA DLQ', async () => {
    // Indisponibilidade momentanea nao pode custar o evento.
    const d = deps(new Error('connection terminated unexpectedly'));
    await expect(decidirEntrega(corpo(), BINDING_PAYMENT_CAPTURED, d)).resolves.toEqual(
      expect.objectContaining({ type: 'nack-requeue' }),
    );
  });

  it('CASO C22: erro DETERMINISTICO vai para a DLQ, nao volta para a fila', async () => {
    // Sem esta distincao, um bug de programacao volta para sempre e ocupa o
    // unico slot do prefetch(1), travando mensagens validas atras dele.
    const d = deps(new TypeError("Cannot read properties of undefined (reading 'total')"));
    await expect(decidirEntrega(corpo(), BINDING_PAYMENT_CAPTURED, d)).resolves.toEqual(
      expect.objectContaining({ type: 'nack-dlq' }),
    );
  });

  it('CASO C23: violacao de chave estrangeira e deterministica', async () => {
    const erro = new Prisma.PrismaClientKnownRequestError('FK violada', {
      code: 'P2003',
      clientVersion: 'x',
    });
    const d = deps(erro);
    await expect(decidirEntrega(corpo(), BINDING_PAYMENT_CAPTURED, d)).resolves.toEqual(
      expect.objectContaining({ type: 'nack-dlq' }),
    );
  });

  it('CASO C24: erro DESCONHECIDO e tratado como transitorio', async () => {
    // Assimetria proposital: classificar transitorio como deterministico
    // descarta pagamento; o contrario so gasta ciclo.
    const erro = new Prisma.PrismaClientKnownRequestError('codigo novo', {
      code: 'P9999',
      clientVersion: 'x',
    });
    const d = deps(erro);
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

  it('CASO C20: motivo nao vaza credencial nem caractere de controle', async () => {
    const d = deps({ tipo: 'aplicado' });

    // Caractere de controle: CR/LF em log permite forjar linha falsa.
    const comControle = await decidirEntrega(corpo(), 'payment.\u0007captured', d);
    expect(comControle.reason).not.toContain('\u0007');

    // Credencial: a versao anterior deste teste nao tinha nenhuma na entrada,
    // entao provava so a remocao de controle. Erro de biblioteca costuma trazer
    // a URL inteira do broker, com a senha dentro.
    const comSenha = deps(new Error('connect ECONNREFUSED amqp://usuario:senha_supersecreta@broker:5672'));
    const acao = await decidirEntrega(corpo(), BINDING_PAYMENT_CAPTURED, comSenha);
    expect(acao.reason).not.toContain('senha_supersecreta');
  });
});
