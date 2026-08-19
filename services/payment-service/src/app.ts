import express, { type Express, type NextFunction, type Request, type Response, type Router } from 'express';
import helmet from 'helmet';

export interface RotasDaAplicacao {
  payments: Router;
  webhooks: Router;
}

/**
 * Erros do express.json() carregam status: 413 para corpo acima do limite, 400
 * para JSON malformado. Sem esta extracao, o handler generico devolveria 500 —
 * culpando o servidor por um erro do cliente e sujando a metrica de 5xx.
 *
 * Le status e statusCode porque bibliotecas divergem em qual usam.
 */
function statusDeClienteOuNulo(erro: unknown): number | null {
  if (typeof erro !== 'object' || erro === null) return null;
  const bruto = erro as { status?: unknown; statusCode?: unknown };
  const valor = typeof bruto.status === 'number' ? bruto.status : bruto.statusCode;
  if (typeof valor !== 'number') return null;
  return valor >= 400 && valor <= 499 ? valor : null;
}

export function createApp(rotas: RotasDaAplicacao): Express {
  const app = express();

  app.use(helmet());

  // ORDEM CRITICA: a rota de webhook e montada ANTES do parser global.
  // A assinatura HMAC e verificada sobre os BYTES EXATOS; se o express.json()
  // parseasse e reserializasse o corpo, a verificacao falharia para sempre —
  // a armadilha numero um de integracao de webhook.
  //
  // O express.raw() correspondente vive DENTRO do webhookRouter, e nao aqui,
  // para que o corpo cru nunca vaze para nenhuma outra rota.
  app.use('/webhooks', rotas.webhooks);

  // O limite existe porque corpo sem teto e vetor de exaustao de memoria.
  app.use(express.json({ limit: '10kb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', service: 'payment-service' });
  });

  app.use('/payments', rotas.payments);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ code: 'ROTA_NAO_ENCONTRADA', error: 'Rota nao encontrada' });
  });

  app.use((erro: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const statusDoCliente = statusDeClienteOuNulo(erro);
    if (statusDoCliente !== null) {
      res
        .status(statusDoCliente)
        .json({ code: 'REQUISICAO_INVALIDA', error: 'Corpo da requisicao invalido' });
      return;
    }

    // Falha inesperada: 500 GENERICO. O detalhe vai para o log do servidor,
    // nunca para o corpo — mensagem de banco ou stack trace entrega estrutura
    // interna a quem estiver sondando.
    console.error(
      '[payment-service] erro nao tratado:',
      erro instanceof Error ? erro.message : erro,
    );
    res.status(500).json({ code: 'ERRO_INTERNO', error: 'Erro interno' });
  });

  return app;
}
