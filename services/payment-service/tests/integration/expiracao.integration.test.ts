import { randomUUID } from 'node:crypto';
import {
  PaymentStatus,
  TransactionStatus,
  TransactionType,
  type PrismaClient,
} from '@prisma/client';
import { connectDatabase, disconnectDatabase } from '../../src/config/database';
import { FakeProvider } from '../../src/providers/fake/fake.provider';
import { FAKE_TOKENS } from '../../src/providers/fake/fake.tokens';
import { PaymentService } from '../../src/services/payment.service';
import { assertTestDatabase } from '../helpers/testDbGuard';
import { SEGREDO_WEBHOOK } from '../helpers/config';
import { orderClientFalso, pedidoDeTeste } from '../helpers/prisma-fake';
import { buscarTentativasExpirando } from '../../src/jobs/expiracao.repository';
import { buscarTentativasPresas } from '../../src/jobs/reconciliacao.repository';

/**
 * POPULACAO DA EXPIRACAO (Bloco 6e), montada de PONTA A PONTA.
 *
 * O token PROCESSING produz o aceite assincrono real: cobranca criada,
 * providerRef devolvido, confirmacao prometida por webhook que nunca chega.
 * A suite de webhook fabrica esse estado no banco de proposito — la o alvo e o
 * handler. Aqui o alvo e a CONSULTA que decide quem entra na varredura, entao
 * fabricar as linhas provaria que o WHERE funciona sobre dados que eu escrevi.
 */

const JANELA_MS = 15 * 60 * 1000;

let prisma: PrismaClient;

beforeAll(async () => {
  assertTestDatabase(process.env);
  prisma = await connectDatabase(process.env.DATABASE_URL as string);
});

afterEach(async () => {
  await prisma.outboxEvent.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.paymentTransaction.deleteMany();
  await prisma.payment.deleteMany();
});

afterAll(async () => {
  await disconnectDatabase();
});

function cenario(token: string) {
  const userId = randomUUID();
  const orderId = randomUUID();
  const pedido = pedidoDeTeste({ id: orderId, userId });
  const service = new PaymentService({
    prisma,
    orderClient: orderClientFalso(jest.fn(async () => pedido)),
    provider: new FakeProvider({ webhookSecret: SEGREDO_WEBHOOK }),
    currency: 'BRL',
    windowMinutes: 15,
  });

  return {
    service,
    orderId,
    input: {
      userId,
      authorization: 'Bearer token.do.usuario',
      orderId,
      paymentMethodToken: token,
      idempotencyKey: randomUUID(),
    },
  };
}

async function lerTentativa(orderId: string) {
  const payment = await prisma.payment.findUniqueOrThrow({
    where: { orderId },
  });
  const tentativa = await prisma.paymentTransaction.findFirstOrThrow({
    where: { paymentId: payment.id, type: TransactionType.AUTHORIZE },
  });
  return { payment, tentativa };
}

/** Aceite assincrono: a cobranca EXISTE e o provedor prometeu avisar depois. */
async function tentativaAceita() {
  const ctx = cenario(FAKE_TOKENS.PROCESSING);
  await ctx.service.criarPagamento(ctx.input);
  const { payment, tentativa } = await lerTentativa(ctx.orderId);

  // Pre-condicoes do rastro. Sem elas o resto do teste nao significa nada.
  expect(payment.status).toBe(PaymentStatus.PROCESSING);
  expect(tentativa.status).toBe(TransactionStatus.PENDING);
  expect(tentativa.providerRef).not.toBeNull();

  return { ...ctx, payment, tentativa };
}

/** Populacao do 6b: cobrou e a resposta se perdeu, entao NAO temos providerRef. */
async function tentativaPresa() {
  const ctx = cenario(FAKE_TOKENS.TIMEOUT_AFTER_CHARGE);
  await expect(ctx.service.criarPagamento(ctx.input)).rejects.toThrow();
  const { payment, tentativa } = await lerTentativa(ctx.orderId);

  expect(tentativa.status).toBe(TransactionStatus.PENDING);
  expect(tentativa.providerRef).toBeNull();

  return { ...ctx, payment, tentativa };
}

async function envelhecer(ids: string[], quando: Date) {
  await prisma.paymentTransaction.updateMany({
    where: { id: { in: ids } },
    data: { createdAt: quando },
  });
}

const limiteDaJanela = () => new Date(Date.now() - JANELA_MS);

describe('buscarTentativasExpirando', () => {
  it('CASO E1: devolve a tentativa com providerRef que passou da janela', async () => {
    const { payment, tentativa } = await tentativaAceita();
    const nascimento = new Date(Date.now() - 60 * 60 * 1000);
    await envelhecer([tentativa.id], nascimento);

    const candidatas = await buscarTentativasExpirando(limiteDaJanela(), 100);

    expect(candidatas).toHaveLength(1);
    expect(candidatas[0]).toEqual({
      id: tentativa.id,
      paymentId: payment.id,
      attemptCount: payment.attemptCount,
      providerRef: tentativa.providerRef,
      createdAt: nascimento,
    });
  });

  it('CASO E2: nao devolve providerRef nulo, nem dentro da janela, nem ja concluida', async () => {
    // Tres formas de NAO ser candidata. Um WHERE que perca qualquer uma delas
    // manda cancelar uma cobranca que nao devia ser cancelada.
    const semRef = await tentativaPresa();
    const dentroDaJanela = await tentativaAceita();
    const concluida = await tentativaAceita();

    const nascimento = new Date(Date.now() - 60 * 60 * 1000);
    await envelhecer([semRef.tentativa.id, concluida.tentativa.id], nascimento);
    await prisma.paymentTransaction.update({
      where: { id: concluida.tentativa.id },
      data: { status: TransactionStatus.SUCCEEDED },
    });

    const candidatas = await buscarTentativasExpirando(limiteDaJanela(), 100);

    expect(candidatas).toEqual([]);
    // A que ficou de fora por IDADE continua existindo e ainda e PENDING: o
    // filtro a excluiu por tempo, nao por a linha ter mudado.
    const viva = await prisma.paymentTransaction.findUniqueOrThrow({
      where: { id: dentroDaJanela.tentativa.id },
    });
    expect(viva.status).toBe(TransactionStatus.PENDING);
  });

  it('CASO E3: populacao COMPLEMENTAR a da reconciliacao, sem intersecao', async () => {
    // Este caso nao prova a minha consulta isolada: prova a RELACAO entre duas
    // varreduras que rodam no MESMO ciclo. Se um dia alguem afrouxar um dos dois
    // filtros, uma passa a PERGUNTAR ao provedor sobre a linha que a outra esta
    // mandando CANCELAR. Nenhum teste de qualquer um dos dois jobs pegaria isso.
    const aceita = await tentativaAceita();
    const presa = await tentativaPresa();

    const nascimento = new Date(Date.now() - 60 * 60 * 1000);
    await envelhecer([aceita.tentativa.id, presa.tentativa.id], nascimento);

    const limite = limiteDaJanela();
    const idsExpirando = (await buscarTentativasExpirando(limite, 100)).map(
      (t) => t.id,
    );
    const idsPresas = (await buscarTentativasPresas(limite, 100)).map(
      (t) => t.id,
    );

    expect(idsExpirando).toEqual([aceita.tentativa.id]);
    expect(idsPresas).toEqual([presa.tentativa.id]);
    // A assercao que importa: nenhuma linha aparece nas duas.
    expect(idsExpirando.filter((id) => idsPresas.includes(id))).toEqual([]);
  });

  it('CASO E4: paginacao keyset real — desempate por id e continuacao pelo cursor', async () => {
    // Espelha o CASO J8 do 6b sobre a consulta nova. Duas linhas com o MESMO
    // createdAt sao o unico jeito de exercitar o desempate por id: sem ele,
    // linhas empatadas trocam de posicao entre paginas e uma nunca e lida.
    const a = await tentativaAceita();
    const b = await tentativaAceita();

    const nascimento = new Date(Date.now() - 60 * 60 * 1000);
    await envelhecer([a.tentativa.id, b.tentativa.id], nascimento);

    const limite = limiteDaJanela();
    const [menor, maior] = [a.tentativa.id, b.tentativa.id].sort();

    const pagina1 = await buscarTentativasExpirando(limite, 1);
    expect(pagina1.map((t) => t.id)).toEqual([menor]);

    const pagina2 = await buscarTentativasExpirando(limite, 1, {
      createdAt: nascimento,
      id: menor,
    });
    expect(pagina2.map((t) => t.id)).toEqual([maior]);

    const pagina3 = await buscarTentativasExpirando(limite, 1, {
      createdAt: nascimento,
      id: maior,
    });
    expect(pagina3).toEqual([]);
  });

  it('CASO E5: expirar leva o pagamento a EXPIRED e FINALIZA a chave', async () => {
    const { service, payment, tentativa } = await tentativaAceita();

    const expirou = await service.expirarTentativa(
      tentativa.id,
      tentativa.providerRef as string,
    );
    expect(expirou).toBe(true);

    const atual = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(atual.status).toBe(PaymentStatus.EXPIRED);

    const linha = await prisma.paymentTransaction.findUniqueOrThrow({
      where: { id: tentativa.id },
    });
    expect(linha.status).toBe(TransactionStatus.FAILED);
    // Codigo proprio: na trilha, distingue expiracao de recusa e de liberacao.
    expect(linha.failureCode).toBe('EXPIRADO_JANELA');

    // Sem isto o cliente receberia IDEMPOTENCIA_EM_ANDAMENTO para sempre sobre
    // um pagamento que ja tem desfecho definitivo.
    const chave = await prisma.idempotencyRecord.findFirstOrThrow({
      where: { paymentId: payment.id },
    });
    // A chave permanece COMPLETED e a resposta congelada NAO e reescrita.
    // A primeira versao deste teste afirmava FAILED, porque eu copiei a
    // finalizacao do 6b por analogia — la a chamada falhou e o claim ficou
    // PROCESSING; aqui ela sucedeu e o claim ja estava concluido.
    //
    // Reescrever o congelado faria duas chamadas com a MESMA chave darem
    // respostas diferentes, que e a definicao do que idempotencia impede.
    // O cliente descobre o desfecho final pelo pagamento, nao pelo replay.
    expect(chave.status).toBe('COMPLETED');
    expect((chave.completedResponse as { status?: string } | null)?.status).toBe(
      'PROCESSING',
    );
  });

  it('CASO E6: tentativa JA CONCLUIDA nao pode ser expirada', async () => {
    // O 6b teve exatamente este defeito: o CAS de liberarTentativaPresa nao
    // tinha condicao de estado, e o teste do caminho feliz passava verde porque
    // a linha ainda estava PENDING. Sem a condicao, uma varredura decidindo
    // sobre snapshot obsoleto sobrescreve um desfecho JA aplicado.
    const { service, payment, tentativa } = await tentativaAceita();

    await prisma.paymentTransaction.update({
      where: { id: tentativa.id },
      data: { status: TransactionStatus.SUCCEEDED },
    });

    const expirou = await service.expirarTentativa(
      tentativa.id,
      tentativa.providerRef as string,
    );
    expect(expirou).toBe(false);

    const linha = await prisma.paymentTransaction.findUniqueOrThrow({
      where: { id: tentativa.id },
    });
    expect(linha.status).toBe(TransactionStatus.SUCCEEDED);
    expect(linha.failureCode).toBeNull();

    const atual = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(atual.status).toBe(PaymentStatus.PROCESSING);
  });

  it('CASO E7: providerRef divergente NAO expira — a cobranca nao e mais a nossa', async () => {
    // A reivindicacao usa o ref EXATO que a varredura cancelou. Se a linha
    // trocou de cobranca entre a selecao e a acao, expirar seria encerrar um
    // pagamento com base numa decisao tomada sobre OUTRA cobranca.
    const { service, payment, tentativa } = await tentativaAceita();

    const expirou = await service.expirarTentativa(
      tentativa.id,
      'ch_de_outra_cobranca',
    );
    expect(expirou).toBe(false);

    const linha = await prisma.paymentTransaction.findUniqueOrThrow({
      where: { id: tentativa.id },
    });
    expect(linha.status).toBe(TransactionStatus.PENDING);
    const atual = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(atual.status).toBe(PaymentStatus.PROCESSING);
  });

  it('CASO E8: provedor que capturou antes do comando aplica CAPTURA, nao expiracao', async () => {
    // O ramo que mais custa dinheiro. O cancelamento e recusado porque a
    // cobranca ja foi capturada; o desfecho correto e aplicar a captura pelo
    // caminho normal, com trilha e evento de outbox.
    const { service, payment, tentativa } = await tentativaAceita();

    const aplicou = await service.aplicarDesfechoDeExpiracao(
      tentativa.id,
      tentativa.providerRef as string,
      {
        providerRef: tentativa.providerRef as string,
        state: 'SUCCEEDED',
        capturedAmountCents: payment.amountCents,
      },
    );
    expect(aplicou).toBe(true);

    const atual = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(atual.status).toBe(PaymentStatus.CAPTURED);

    const trilha = await prisma.paymentTransaction.findMany({
      where: { paymentId: payment.id },
    });
    expect(
      trilha.filter((t) => t.type === TransactionType.CAPTURE),
    ).toHaveLength(1);

    // O pedido so e liberado pelo evento; sem ele a captura ficaria invisivel.
    expect(await prisma.outboxEvent.count()).toBe(1);

    // Mesmo invariante do E5 no caminho da captura: o desfecho e aplicado,
    // mas a resposta congelada daquela tentativa continua a que o cliente
    // recebeu. E o que `aplicarDesfechoDeExpiracao` sinaliza com `ignorar`.
    const chave = await prisma.idempotencyRecord.findFirstOrThrow({
      where: { paymentId: payment.id },
    });
    expect(chave.status).toBe('COMPLETED');
    expect((chave.completedResponse as { status?: string } | null)?.status).toBe(
      'PROCESSING',
    );
  });
});
