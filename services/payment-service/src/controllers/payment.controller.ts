import type { Request, Response } from 'express';

import { PaymentDomainError, type CodigoDeErroDePagamento } from '../domain/errors';
import type { PaymentService } from '../services/payment.service';

/**
 * O controller depende do MENOR contrato possivel: so criarPagamento.
 *
 * Com Pick, o duble de teste nao precisa fabricar o resto da classe, e
 * qualquer mudanca na assinatura do metodo real quebra o duble em compilacao
 * — o que um objeto solto com `as` esconderia.
 */
export type ServicoDePagamento = Pick<PaymentService, 'criarPagamento'>;

/**
 * Codigo de dominio -> status HTTP.
 *
 * Tabela unica, e o `Record` completo obriga a decidir o status de todo codigo
 * novo em compilacao — em vez de cair num default silencioso.
 */
const STATUS_POR_CODIGO: Record<CodigoDeErroDePagamento, number> = {
  REQUISICAO_INVALIDA: 400,
  NAO_AUTORIZADO: 401,
  PEDIDO_NAO_ENCONTRADO: 404,
  IDEMPOTENCIA_EM_ANDAMENTO: 409,
  IDEMPOTENCIA_JA_FALHOU: 409,
  PEDIDO_NAO_COBRAVEL: 409,
  PEDIDO_JA_PAGO: 409,
  TENTATIVA_EM_ANDAMENTO: 409,
  JANELA_EXPIRADA: 409,
  VALOR_DO_PEDIDO_INVALIDO: 422,
  DEPENDENCIA_INDISPONIVEL: 503,
};

const MAX_TAMANHO_CAMPO = 255;

function textoObrigatorio(valor: unknown, campo: string): string {
  if (typeof valor !== 'string' || valor.trim() === '') {
    throw new PaymentDomainError('REQUISICAO_INVALIDA', `${campo} e obrigatorio`);
  }
  if (valor.length > MAX_TAMANHO_CAMPO) {
    throw new PaymentDomainError(
      'REQUISICAO_INVALIDA',
      `${campo} excede ${MAX_TAMANHO_CAMPO} caracteres`,
    );
  }
  // REJEITA espaco em volta, nao apara. Identificador opaco nao se normaliza:
  // se aparassemos, "chave " e "chave" seriam a MESMA chave de idempotencia,
  // mascarando um cliente inconsistente. Se aceitassemos sem aparar, seriam
  // DUAS chaves para a mesma requisicao logica — e um proxy que apara whitespace
  // produz exatamente esse par, abrindo caminho para cobranca dupla.
  // Mesma regra do identificador() em providers/fake/fake.wire.ts.
  if (valor !== valor.trim()) {
    throw new PaymentDomainError('REQUISICAO_INVALIDA', `${campo} tem espaco em volta`);
  }
  return valor;
}

export interface PaymentController {
  criar(req: Request, res: Response): Promise<void>;
}

export function criarPaymentController(service: ServicoDePagamento): PaymentController {
  return {
    async criar(req: Request, res: Response): Promise<void> {
      try {
        // O tipo do Request declara userId como OPCIONAL: ele nao pode prometer
        // que o middleware rodou. Esta checagem e defesa em profundidade contra
        // alguem montar a rota sem autenticacao.
        const userId = req.userId;
        if (!userId) {
          throw new PaymentDomainError('NAO_AUTORIZADO', 'Requisicao nao autenticada');
        }

        const authorization = req.headers.authorization;
        if (!authorization) {
          throw new PaymentDomainError('NAO_AUTORIZADO', 'Token nao fornecido');
        }

        const idempotencyKey = textoObrigatorio(
          req.headers['idempotency-key'],
          'Idempotency-Key',
        );

        const corpo = (req.body ?? {}) as Record<string, unknown>;
        const orderId = textoObrigatorio(corpo.orderId, 'orderId');
        const paymentMethodToken = textoObrigatorio(
          corpo.paymentMethodToken,
          'paymentMethodToken',
        );

        const resultado = await service.criarPagamento({
          userId,
          authorization,
          orderId,
          paymentMethodToken,
          idempotencyKey,
        });

        // 200 no replay, 201 quando houve efeito novo. O cliente distingue sem
        // precisar interpretar o corpo.
        res.status(resultado.replay ? 200 : 201).json(resultado);
      } catch (erro) {
        if (erro instanceof PaymentDomainError) {
          const status = STATUS_POR_CODIGO[erro.code];
          if (erro.retryable) res.setHeader('Retry-After', '2');
          res.status(status).json({ code: erro.code, error: erro.message });
          return;
        }
        // Nao mapeado: deixa subir para o handler de erro do app, que responde
        // 500 generico sem vazar detalhe interno.
        throw erro;
      }
    },
  };
}
