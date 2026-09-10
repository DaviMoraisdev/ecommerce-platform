import express, { type RequestHandler } from 'express';
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
import { exigirRole } from '../../../src/middlewares/role.middleware';

const TOKEN_FALSO = 'Bearer token.de.teste';

function montarApp(
  criarPagamento: jest.Mock,
  opcoes: {
    autentica?: boolean;
    role?: string;
    reembolsar?: jest.Mock;
  } = {},
) {
  // Duble do middleware: popula userId como o real faria. Isola o controller —
  // uma falha aqui nunca vem de JWT malformado.
  const authMiddleware: RequestHandler = (req, _res, next) => {
    if (opcoes.autentica !== false) {
      req.userId = 'usr_1';
      // A claim `role` e OPCIONAL no token real: por padrao o dublê nao a
      // popula, e o caminho sem role fica exercitado por construcao.
      req.userRole = opcoes.role;
    }
    next();
  };

  const service: ServicoDePagamento = {
    criarPagamento,
    reembolsar: opcoes.reembolsar ?? jest.fn(),
  };

  return createApp({
    payments: criarPaymentRouter({
      authMiddleware,
      // O exigirRole REAL, nao um stub: assim a rota exercita a autorizacao
      // de verdade em vez de uma imitacao dela.
      exigirAdmin: exigirRole('ADMIN'),
      controller: criarPaymentController(service),
    }),
    // Este arquivo testa o controller de pagamento; o webhook nao participa.
    webhooks: express.Router(),
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
    ['IDEMPOTENCIA_CONFLITANTE', 422],
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


describe('POST /payments/:id/refunds — autorizacao e mapeamento (Bloco 7)', () => {
  function pedir(
    app: ReturnType<typeof createApp>,
    opcoes: { chave?: string | null; corpo?: unknown } = {},
  ) {
    let req = request(app).post('/payments/pay_1/refunds').set('Authorization', TOKEN_FALSO);
    if (opcoes.chave !== null) req = req.set('Idempotency-Key', opcoes.chave ?? 'idem_r1');
    return req.send(opcoes.corpo ?? { valorCents: 100 });
  }

  it('CASO A1: token SEM role e recusado, e o servico nao e chamado', async () => {
    // A claim `role` e opcional no token: um token perfeitamente valido chega
    // sem ela. Recusar tem de ser explicito, nao acidente da comparacao.
    const reembolsar = jest.fn();
    const res = await pedir(montarApp(jest.fn(), { reembolsar }));

    expect(res.status).toBe(403);
    expect(reembolsar).not.toHaveBeenCalled();
  });

  it('CASO A2: role diferente de ADMIN e recusada', async () => {
    const reembolsar = jest.fn();
    const res = await pedir(montarApp(jest.fn(), { role: 'USER', reembolsar }));

    expect(res.status).toBe(403);
    expect(reembolsar).not.toHaveBeenCalled();
  });

  it('CASO A3: o 403 NAO revela qual role era exigida', async () => {
    // O TECH_DEBT registra esse vazamento como divida nos outros servicos; o
    // endpoint novo nasce sem ele.
    const res = await pedir(montarApp(jest.fn(), { role: 'USER', reembolsar: jest.fn() }));

    const corpo = JSON.stringify(res.body);
    expect(corpo).not.toContain('ADMIN');
    expect(corpo).not.toContain('USER');
  });

  it('CASO A4: ADMIN passa e o servico recebe a requisicao montada', async () => {
    const reembolsar = jest.fn(async () => ({
      tipo: 'aplicado' as const,
      totalReembolsadoCents: 100,
      providerRefundRef: 're_1',
    }));

    const res = await pedir(montarApp(jest.fn(), { role: 'ADMIN', reembolsar }));

    expect(res.status).toBe(201);
    expect(reembolsar).toHaveBeenCalledWith({
      userId: 'usr_1',
      idempotencyKey: 'idem_r1',
      paymentId: 'pay_1',
      valorCents: 100,
    });
  });

  it('CASO A5: aceite ASSINCRONO responde 202, nao 201', async () => {
    // O dinheiro ainda nao voltou. O cliente precisa saber que o desfecho ainda
    // vai mudar, sem interpretar o corpo.
    const reembolsar = jest.fn(async () => ({ tipo: 'pendente' as const, providerRefundRef: 're_1' }));
    const res = await pedir(montarApp(jest.fn(), { role: 'ADMIN', reembolsar }));

    expect(res.status).toBe(202);
  });

  it('CASO A6: replay responde 200, mesmo com desfecho de efeito novo', async () => {
    const reembolsar = jest.fn(async () => ({
      tipo: 'aplicado' as const,
      totalReembolsadoCents: 100,
      providerRefundRef: 're_1',
      replay: true,
    }));

    const res = await pedir(montarApp(jest.fn(), { role: 'ADMIN', reembolsar }));

    expect(res.status).toBe(200);
  });

  it('CASO A7: estouro do capturado e 409, com os numeros no corpo', async () => {
    const reembolsar = jest.fn(async () => ({
      tipo: 'excede-o-capturado' as const,
      capturadoCents: 1000,
      reembolsadoCents: 900,
    }));

    const res = await pedir(montarApp(jest.fn(), { role: 'ADMIN', reembolsar }));

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ capturadoCents: 1000, reembolsadoCents: 900 });
  });

  it('CASO A8: contencao e 503 RETENTAVEL, com Retry-After', async () => {
    // Dinheiro movido no provedor e contabilidade pendente: repetir e a acao
    // certa, e o cliente precisa saber disso pelo cabecalho.
    const reembolsar = jest.fn(async () => ({ tipo: 'contencao' as const }));
    const res = await pedir(montarApp(jest.fn(), { role: 'ADMIN', reembolsar }));

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('2');
  });

  it.each([[{}], [{ valorCents: 0 }], [{ valorCents: -1 }], [{ valorCents: 1.5 }], [{ valorCents: '100' }]])(
    'CASO A9: corpo %p e 400 sem chegar ao servico',
    async (corpo) => {
      const reembolsar = jest.fn();
      const res = await pedir(montarApp(jest.fn(), { role: 'ADMIN', reembolsar }), { corpo });

      expect(res.status).toBe(400);
      expect(reembolsar).not.toHaveBeenCalled();
    },
  );

  it('CASO A10: sem Idempotency-Key e 400 — reembolso sem chave e reembolso duplo', async () => {
    const reembolsar = jest.fn();
    const res = await pedir(montarApp(jest.fn(), { role: 'ADMIN', reembolsar }), { chave: null });

    expect(res.status).toBe(400);
    expect(reembolsar).not.toHaveBeenCalled();
  });

  // A11 e A12 existem porque o mapeamento de `divergencia` NAO tinha teste
  // nenhum: a troca de 409 para 500 atravessou a suite inteira sem uma falha.
  // Mecanismo sem prova e mecanismo que a proxima mudanca desfaz em silencio.
  const DIVERGENCIA = {
    tipo: 'divergencia' as const,
    capturadoCents: 10000,
    reembolsadoCents: 9000,
  };

  it('CASO A11: divergencia responde 500, nao 4xx', async () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const reembolsar = jest.fn(async () => DIVERGENCIA);

    const res = await pedir(montarApp(jest.fn(), { reembolsar, role: 'ADMIN' }));

    // Anomalia NOSSA: o provedor aceitou o que a contabilidade local nao
    // comporta. 4xx faria cliente e monitoramento tratarem incidente
    // operacional como erro de requisicao.
    expect(res.status).toBe(500);
    log.mockRestore();
  });

  it('CASO A12: os valores da divergencia vao para o LOG, nao para o corpo', async () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const reembolsar = jest.fn(async () => DIVERGENCIA);

    const res = await pedir(montarApp(jest.fn(), { reembolsar, role: 'ADMIN' }));

    // As duas metades sao afirmadas juntas de proposito. So "nao vaza no corpo"
    // seria satisfeito por nao registrar nada em lugar nenhum — o que perderia
    // a informacao que o operador precisa.
    expect(res.body).not.toHaveProperty('capturadoCents');
    expect(res.body).not.toHaveProperty('reembolsadoCents');
    expect(res.body.code).toBe('DIVERGENCIA_DE_REEMBOLSO');
    expect(log).toHaveBeenCalledWith(
      '[payment-service] divergencia de reembolso',
      expect.objectContaining({ capturadoCents: 10000, reembolsadoCents: 9000 }),
    );
    log.mockRestore();
  });
});
