import type { Request, Response } from 'express';

import { PaymentDomainError, type CodigoDeErroDePagamento } from '../domain/errors';
import type { PaymentService } from '../services/payment.service';
import type { DesfechoDeReembolso } from '../domain/reembolso';

/**
 * O controller depende do MENOR contrato possivel: so criarPagamento.
 *
 * Com Pick, o duble de teste nao precisa fabricar o resto da classe, e
 * qualquer mudanca na assinatura do metodo real quebra o duble em compilacao
 * — o que um objeto solto com `as` esconderia.
 */
export type ServicoDePagamento = Pick<PaymentService, 'criarPagamento' | 'reembolsar'>;

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
  PAGAMENTO_NAO_ENCONTRADO: 404,
  IDEMPOTENCIA_EM_ANDAMENTO: 409,
  IDEMPOTENCIA_JA_FALHOU: 409,
  PEDIDO_NAO_COBRAVEL: 409,
  PEDIDO_JA_PAGO: 409,
  TENTATIVA_EM_ANDAMENTO: 409,
  JANELA_EXPIRADA: 409,
  // 422, nao 409: a requisicao e sintaticamente valida, mas conflita com o uso
  // anterior daquela chave. 409 diria "o estado atual impede", que nao e o caso.
  IDEMPOTENCIA_CONFLITANTE: 422,
  VALOR_DO_PEDIDO_INVALIDO: 422,
  DEPENDENCIA_INDISPONIVEL: 503,
};

/**
 * Desfecho do reembolso -> status HTTP.
 *
 * Record COMPLETO: desfecho novo obriga a decidir o status em COMPILACAO, em vez
 * de cair num default silencioso. Mesma disciplina do STATUS_POR_CODIGO.
 */
const STATUS_POR_DESFECHO: Record<DesfechoDeReembolso['tipo'], number> = {
  // A tentativa foi registrada e o corpo diz o desfecho — inclusive quando o
  // provedor recusou. Mesmo criterio do endpoint de criacao, onde uma cobranca
  // recusada tambem e 201 com o motivo no corpo.
  aplicado: 201,
  recusado: 201,
  // 202: aceito pelo provedor, dinheiro ainda NAO voltou. Quem confirma e o
  // webhook, e o cliente precisa saber que o desfecho ainda vai mudar.
  pendente: 202,
  'valor-invalido': 400,
  'estado-invalido': 409,
  'excede-o-capturado': 409,
  // Anomalia NOSSA, nao do cliente: o provedor aceitou um estorno que a
  // contabilidade local nao comporta. 4xx faria cliente e monitoramento
  // tratarem incidente operacional como erro de requisicao.
  divergencia: 500,
  // Retentavel: o CAS perdeu acima do teto sob contencao.
  contencao: 503,
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
  reembolsar(req: Request, res: Response): Promise<void>;
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

    async reembolsar(req: Request, res: Response): Promise<void> {
      try {
        // Defesa em profundidade: o tipo do Request nao promete que o
        // authMiddleware rodou, e o exigirRole roda depois dele.
        const userId = req.userId;
        if (!userId) {
          throw new PaymentDomainError('NAO_AUTORIZADO', 'Requisicao nao autenticada');
        }

        const idempotencyKey = textoObrigatorio(req.headers['idempotency-key'], 'Idempotency-Key');
        const paymentId = textoObrigatorio(req.params.id, 'id');

        const corpo = (req.body ?? {}) as Record<string, unknown>;
        const valorCents = corpo.valorCents;
        if (!Number.isSafeInteger(valorCents) || (valorCents as number) <= 0) {
          throw new PaymentDomainError(
            'REQUISICAO_INVALIDA',
            'valorCents deve ser inteiro positivo em centavos',
          );
        }

        const resultado = await service.reembolsar({
          userId,
          idempotencyKey,
          paymentId,
          valorCents: valorCents as number,
        });

        // 200 no replay; o status do desfecho quando houve efeito novo.
        const status = resultado.replay === true ? 200 : STATUS_POR_DESFECHO[resultado.tipo];
        if (status === 503) res.setHeader('Retry-After', '2');
        if (resultado.tipo === 'divergencia') {
          // Os numeros vao para o LOG, nao para o corpo: quem precisa deles e o
          // operador, e corpo de 5xx nao carrega estado interno.
          console.error('[payment-service] divergencia de reembolso', {
            paymentId,
            capturadoCents: resultado.capturadoCents,
            reembolsadoCents: resultado.reembolsadoCents,
          });
          res.status(status).json({
            code: 'DIVERGENCIA_DE_REEMBOLSO',
            error: 'Divergencia entre o provedor e a contabilidade local',
          });
          return;
        }
        res.status(status).json(resultado);
      } catch (erro) {
        if (erro instanceof PaymentDomainError) {
          const status = STATUS_POR_CODIGO[erro.code];
          if (erro.retryable) res.setHeader('Retry-After', '2');
          res.status(status).json({ code: erro.code, error: erro.message });
          return;
        }
        throw erro;
      }
    },
  };
}
