import { randomUUID } from "node:crypto";
import {
  PaymentStatus,
  TransactionStatus,
  TransactionType,
  type PrismaClient,
} from "@prisma/client";
import { connectDatabase, disconnectDatabase } from "../../src/config/database";
import { FakeProvider } from "../../src/providers/fake/fake.provider";
import { FAKE_TOKENS } from "../../src/providers/fake/fake.tokens";
import { PaymentService } from "../../src/services/payment.service";
import { assertTestDatabase } from "../helpers/testDbGuard";
import { SEGREDO_WEBHOOK } from "../helpers/config";
import { orderClientFalso, pedidoDeTeste } from "../helpers/prisma-fake";
import { buscarTentativasExpirando } from "../../src/jobs/expiracao.repository";
import { buscarTentativasPresas } from "../../src/jobs/reconciliacao.repository";

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
    currency: "BRL",
    windowMinutes: 15,
  });

  return {
    service,
    orderId,
    input: {
      userId,
      authorization: "Bearer token.do.usuario",
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

  return { payment, tentativa };
}

/** Populacao do 6b: cobrou e a resposta se perdeu, entao NAO temos providerRef. */
async function tentativaPresa() {
  const ctx = cenario(FAKE_TOKENS.TIMEOUT_AFTER_CHARGE);
  await expect(ctx.service.criarPagamento(ctx.input)).rejects.toThrow();
  const { payment, tentativa } = await lerTentativa(ctx.orderId);

  expect(tentativa.status).toBe(TransactionStatus.PENDING);
  expect(tentativa.providerRef).toBeNull();

  return { payment, tentativa };
}

async function envelhecer(ids: string[], quando: Date) {
  await prisma.paymentTransaction.updateMany({
    where: { id: { in: ids } },
    data: { createdAt: quando },
  });
}

const limiteDaJanela = () => new Date(Date.now() - JANELA_MS);

describe("buscarTentativasExpirando", () => {
  it("CASO E1: devolve a tentativa com providerRef que passou da janela", async () => {
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

  it("CASO E2: nao devolve providerRef nulo, nem dentro da janela, nem ja concluida", async () => {
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

  it("CASO E3: populacao COMPLEMENTAR a da reconciliacao, sem intersecao", async () => {
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

  it("CASO E4: paginacao keyset real — desempate por id e continuacao pelo cursor", async () => {
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
});
