import express, { type Express, type NextFunction, type Request, type Response, type Router } from 'express';
import helmet from 'helmet';

export interface RotasDaAplicacao {
  payments: Router;
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

  // ATENCAO (Bloco 4): este parser NAO pode alcancar a rota de webhook — a
  // verificacao de assinatura HMAC exige o corpo CRU. Quando ela entrar, sera
  // montada ANTES deste middleware, com express.raw().
  //
  // O limite existe agora porque corpo sem teto e vetor de exaustao de memoria.
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
