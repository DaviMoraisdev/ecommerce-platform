import { Prisma } from '@prisma/client';
import { mensagemSegura } from '../../../src/domain/mensagem-segura';

describe('mensagemSegura', () => {
  it('CASO M1: erro de Prisma vira codigo, sem nome de tabela ou coluna', () => {
    const erro = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on payments.orderId', {
      code: 'P2002',
      clientVersion: '6.0.0',
    });
    expect(mensagemSegura(erro)).toBe('falha de banco (P2002)');
  });

  it('CASO M2: NUNCA repassa a mensagem original', () => {
    // A razao de a funcao existir: um adaptador pode incluir corpo de resposta,
    // referencia externa ou token na mensagem da excecao.
    const erro = new Error('authorization=Bearer sk_live_abc123 body={"pan":"4111"}');
    const saida = mensagemSegura(erro);
    expect(saida).not.toContain('sk_live_abc123');
    expect(saida).not.toContain('4111');
  });

  it('CASO M3: o contexto vem do CHAMADOR e o default nao cita webhook', () => {
    // Achado 5.1 da 2a rodada: a funcao foi extraida do WebhookService com a
    // mensagem dele, e passou a cobrir falhas do job de expiracao — uma falha
    // de cancelCharge era registrada como falha de webhook.
    expect(mensagemSegura(new Error('x'))).not.toContain('webhook');
    expect(mensagemSegura(new Error('x'), 'cancelamento da cobranca')).toBe(
      'falha inesperada no cancelamento da cobranca',
    );
  });
});
