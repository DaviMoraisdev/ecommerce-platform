import type { RequestHandler } from 'express';
import request from 'supertest';

import { createApp } from '../../../src/app';
import {
  criarPaymentController,
  type ServicoDePagamento,
} from '../../../src/controllers/payment.controller';
import {
  PaymentDomainError,
  type CodigoDeErroDePagamento,
} from '../../../src/domain/errors';
import { criarPaymentRouter } from '../../../src/routes/payment.routes';
import { pagamentoCriadoDeTeste } from '../../helpers/pagamento';

const TOKEN_FALSO = 'Bearer token.de.teste';

function montarApp(
  criarPagamento: jest.Mock,
  opcoes: { autentica?: boolean } = {},
) {
  // Duble do middleware: popula userId como o real faria. Isola o controller —
  // uma falha aqui nunca vem de JWT malformado.
  const authMiddleware: RequestHandler = (req, _res, next) => {
    if (opcoes.autentica !== false) req.userId = 'usr_1';
    next();
  };

  const service: ServicoDePagamento = { criarPagamento };

  return createApp({
    payments: criarPaymentRouter({
      authMiddleware,
      controller: criarPaymentController(service),
    }),
  });
}

const CORPO_VALIDO = { orderId: 'ord_1', paymentMethodToken: 'tok_visa' };

function postar(
  app: ReturnType<typeof montarApp>,
  opcoes: {
    idempotencyKey?: string | null;
    authorization?: string | null;
    corpo?: Record<string, unknown>;
  } = {},
) {
  let req = request(app).post('/payments');
  if (opcoes.authorization !== null) {
    req = req.set('Authorization', opcoes.authorization ?? TOKEN_FALSO);
  }
  if (opcoes.idempotencyKey !== null) {
    req = req.set('Idempotency-Key', opcoes.idempotencyKey ?? 'idem_1');
  }
  return req.send(opcoes.corpo === undefined ? CORPO_VALIDO : opcoes.corpo);
}

describe('POST /payments — caminho feliz', () => {
  it('responde 201 quando houve efeito novo', async () => {
    const resultado = pagamentoCriadoDeTeste({ replay: false });
    const criarPagamento = jest.fn().mockResolvedValue(resultado);

    const resposta = await postar(montarApp(criarPagamento));

    expect(resposta.status).toBe(201);
    expect(resposta.body).toEqual(resultado);
  });

  it('responde 200 quando a resposta veio de replay idempotente', async () => {
    const resultado = pagamentoCriadoDeTeste({ replay: true });
    const criarPagamento = jest.fn().mockResolvedValue(resultado);

    const resposta = await postar(montarApp(criarPagamento));

    // O status distingue "criei agora" de "voce ja tinha pedido isso" sem o
    // cliente precisar interpretar o corpo.
    expect(resposta.status).toBe(200);
  });

  it('repassa userId, cabecalho Authorization BRUTO, chave e corpo ao servico', async () => {
    const criarPagamento = jest.fn().mockResolvedValue(pagamentoCriadoDeTeste());

    await postar(montarApp(criarPagamento), { idempotencyKey: 'idem_abc' });

    expect(criarPagamento).toHaveBeenCalledTimes(1);
    expect(criarPagamento).toHaveBeenCalledWith({
      userId: 'usr_1',
      // BRUTO com o "Bearer ": o order-service revalida o mesmo token, entao o
      // controller nao pode desmontar o cabecalho.
      authorization: TOKEN_FALSO,
      orderId: 'ord_1',
      paymentMethodToken: 'tok_visa',
      idempotencyKey: 'idem_abc',
    });
  });
});

describe('POST /payments — validacao de entrada', () => {
  it.each([
    ['Idempotency-Key ausente', { idempotencyKey: null as null }],
    ['Idempotency-Key so com espacos', { idempotencyKey: '   ' }],
    ['Idempotency-Key acima de 255 caracteres', { idempotencyKey: 'a'.repeat(256) }],
    ['corpo vazio', { corpo: {} }],
    ['sem orderId', { corpo: { paymentMethodToken: 'tok_visa' } }],
    ['sem paymentMethodToken', { corpo: { orderId: 'ord_1' } }],
    ['orderId numerico', { corpo: { orderId: 7, paymentMethodToken: 'tok_visa' } }],
    ['orderId nulo', { corpo: { orderId: null, paymentMethodToken: 'tok_visa' } }],
    ['orderId com espaco em volta', { corpo: { orderId: 'ord_1 ', paymentMethodToken: 'tok_visa' } }],
  ])('responde 400 e NAO chama o servico: %s', async (_rotulo, opcoes) => {
    // Resolve com resultado VALIDO de proposito. Com jest.fn() vazio, um caso
    // que escapasse da validacao estouraria em resultado.replay e daria 500 —
    // diagnostico ruim. Assim ele da 201, e a falha aponta direto para o
    // buraco na validacao.
    const criarPagamento = jest.fn().mockResolvedValue(pagamentoCriadoDeTeste());

    const resposta = await postar(montarApp(criarPagamento), opcoes);

    expect(resposta.status).toBe(400);
    expect(resposta.body.code).toBe('REQUISICAO_INVALIDA');
    // O ponto principal: validacao roda ANTES de qualquer efeito.
    expect(criarPagamento).not.toHaveBeenCalled();
  });

  it('aceita Idempotency-Key com espaco em volta porque o parser HTTP o remove antes', async () => {
    const criarPagamento = jest.fn().mockResolvedValue(pagamentoCriadoDeTeste());

    const resposta = await postar(montarApp(criarPagamento), { idempotencyKey: '  idem_1  ' });

    // Comprovado empiricamente: o parser HTTP do Node apara OWS de valores de
    // cabecalho, entao "  idem_1  " chega como "idem_1". A guarda contra espaco
    // no controller NAO e inutil: o corpo JSON preserva espaco (ver o caso de
    // orderId abaixo) e um chamador que nao passe por HTTP tambem.
    expect(resposta.status).toBe(201);
    expect(criarPagamento).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'idem_1' }),
    );
  });

  it('responde 401 quando a rota foi montada sem autenticacao (defesa em profundidade)', async () => {
    const criarPagamento = jest.fn();

    const resposta = await postar(montarApp(criarPagamento, { autentica: false }));

    expect(resposta.status).toBe(401);
    expect(criarPagamento).not.toHaveBeenCalled();
  });

  it('responde 401 quando ha userId mas nao ha cabecalho Authorization para repassar', async () => {
    const criarPagamento = jest.fn();

    const resposta = await postar(montarApp(criarPagamento), { authorization: null });

    expect(resposta.status).toBe(401);
    expect(criarPagamento).not.toHaveBeenCalled();
  });
});

describe('POST /payments — mapeamento de erro de dominio para HTTP', () => {
  // Tabela DUPLICADA de proposito. Se alguem mudar o STATUS_POR_CODIGO de
  // producao, esta tabela discorda e o teste quebra — que e o objetivo.
  const ESPERADO: Array<[CodigoDeErroDePagamento, number]> = [
    ['REQUISICAO_INVALIDA', 400],
    ['NAO_AUTORIZADO', 401],
    ['PEDIDO_NAO_ENCONTRADO', 404],
    ['IDEMPOTENCIA_EM_ANDAMENTO', 409],
    ['IDEMPOTENCIA_JA_FALHOU', 409],
    ['PEDIDO_NAO_COBRAVEL', 409],
    ['PEDIDO_JA_PAGO', 409],
    ['TENTATIVA_EM_ANDAMENTO', 409],
    ['JANELA_EXPIRADA', 409],
    ['VALOR_DO_PEDIDO_INVALIDO', 422],
    ['DEPENDENCIA_INDISPONIVEL', 503],
  ];

  it.each(ESPERADO)('mapeia %s para %i', async (codigo, status) => {
    const criarPagamento = jest
      .fn()
      .mockRejectedValue(new PaymentDomainError(codigo, 'mensagem de dominio'));

    const resposta = await postar(montarApp(criarPagamento));

    expect(resposta.status).toBe(status);
    expect(resposta.body).toEqual({ code: codigo, error: 'mensagem de dominio' });
  });

  it('anexa Retry-After quando o erro e retentavel', async () => {
    const criarPagamento = jest
      .fn()
      .mockRejectedValue(
        new PaymentDomainError('DEPENDENCIA_INDISPONIVEL', 'order fora do ar', true),
      );

    const resposta = await postar(montarApp(criarPagamento));

    expect(resposta.status).toBe(503);
    expect(resposta.headers['retry-after']).toBe('2');
  });

  it('NAO anexa Retry-After quando o erro e definitivo', async () => {
    const criarPagamento = jest
      .fn()
      .mockRejectedValue(new PaymentDomainError('PEDIDO_JA_PAGO', 'ja pago'));

    const resposta = await postar(montarApp(criarPagamento));

    // Retry-After num erro definitivo convida o cliente a repetir o que nunca
    // vai funcionar, gastando carga do servico.
    expect(resposta.headers['retry-after']).toBeUndefined();
  });
});

describe('POST /payments — erro inesperado', () => {
  it('responde 500 generico sem vazar a mensagem interna', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const criarPagamento = jest
      .fn()
      .mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5432'));

    const resposta = await postar(montarApp(criarPagamento));

    expect(resposta.status).toBe(500);
    expect(resposta.body).toEqual({ code: 'ERRO_INTERNO', error: 'Erro interno' });
    expect(resposta.text).not.toContain('ECONNREFUSED');
    expect(resposta.text).not.toContain('5432');
    spy.mockRestore();
  });
});
