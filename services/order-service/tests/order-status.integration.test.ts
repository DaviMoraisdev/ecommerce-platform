import { OrderStatus } from '@prisma/client';
import { prisma } from '../src/config/database';
import { assertTestDatabase } from './helpers/testDbGuard';
import { updateOrderStatus, getStatusHistory } from '../src/services/order.service';
import { DomainError } from '../src/domain/errors';

beforeAll(() => {
  assertTestDatabase();
});

afterEach(async () => {
  await prisma.order.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function novoPedido() {
  return prisma.order.create({ data: { userId: 'u1', total: '10.00' } });
}

describe('updateOrderStatus', () => {
  it('aplica transicao valida e registra o historico', async () => {
    const order = await novoPedido();
    const atualizado = await updateOrderStatus(order.id, OrderStatus.PAGO, 'admin1');

    expect(atualizado.status).toBe(OrderStatus.PAGO);
    const hist = await getStatusHistory(order.id);
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({
      fromStatus: OrderStatus.PENDENTE,
      toStatus: OrderStatus.PAGO,
      changedBy: 'admin1',
    });
  });

  it('rejeita pulo invalido sem alterar status nem gravar historico', async () => {
    const order = await novoPedido();
    await expect(
      updateOrderStatus(order.id, OrderStatus.ENVIADO, 'admin1')
    ).rejects.toThrow('TRANSICAO_INVALIDA');

    const depois = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(depois.status).toBe(OrderStatus.PENDENTE);
    expect(await getStatusHistory(order.id)).toHaveLength(0);
  });

  it('rejeita pedido inexistente', async () => {
    await expect(
      updateOrderStatus('nao-existe', OrderStatus.PAGO, 'admin1')
    ).rejects.toThrow('PEDIDO_NAO_ENCONTRADO');
  });

  it('acumula o caminho completo no historico, em ordem', async () => {
    const order = await novoPedido();
    await updateOrderStatus(order.id, OrderStatus.PAGO, 'admin1');
    await updateOrderStatus(order.id, OrderStatus.ENVIADO, 'admin1');
    await updateOrderStatus(order.id, OrderStatus.ENTREGUE, 'admin1');

    const hist = await getStatusHistory(order.id);
    expect(hist.map((h) => [h.fromStatus, h.toStatus])).toEqual([
      [OrderStatus.PENDENTE, OrderStatus.PAGO],
      [OrderStatus.PAGO, OrderStatus.ENVIADO],
      [OrderStatus.ENVIADO, OrderStatus.ENTREGUE],
    ]);
  });

  it('status terminal nao aceita nova transicao', async () => {
    const order = await novoPedido();
    await updateOrderStatus(order.id, OrderStatus.CANCELADO, 'admin1');
    await expect(
      updateOrderStatus(order.id, OrderStatus.PAGO, 'admin1')
    ).rejects.toThrow('TRANSICAO_INVALIDA');
  });

  it('concorrencia: a MESMA transicao disputada em paralelo so vale uma vez', async () => {
    const order = await novoPedido();
    // Alvos iguais de proposito: PAGO e CANCELADO formariam uma cadeia valida
    // (PENDENTE->PAGO->CANCELADO) e elas passariam legitimamente. Disputando a
    // MESMA transicao, so uma pode vencer:
    //  - em paralelo real: o CAS da perdedora casa 0 linhas -> CONFLITO_DE_ESTADO
    //  - se serializar: a perdedora le PAGO e tenta PAGO->PAGO -> TRANSICAO_INVALIDA
    //
    // CINCO disputantes, nao dois — e a razao esta na segunda linha acima. Com
    // dois, o par SERIALIZA na maior parte das execucoes, a matriz recusa a
    // segunda, e as assercoes abaixo passam SEM o CAS ter participado: o caso
    // media a matriz e creditava o resultado ao compare-and-swap. Medido na
    // sabotagem S2 (condicao apagada do `where` de `aplicarTransicao`): a versao
    // com dois disputantes falhou em apenas 1 de 4 execucoes. Com CINCO sobe
    // para 2 de 4 — melhor, e ainda NAO determinista: quando as cinco
    // serializam, a matriz responde por todas as recusas e o CAS segue sem ser
    // exercitado. Quem fecha o mecanismo de forma confiavel e o caso
    // `aplicarTransicao sob concorrencia` (4 de 4), no fim deste arquivo.
    // Achado 4.4 da 2a rodada do PR #63.
    const resultados = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        updateOrderStatus(order.id, OrderStatus.PAGO, 'u' + i),
      ),
    );

    const vencedores = resultados.filter((r) => r.status === 'fulfilled');
    const perdedores = resultados.filter((r) => r.status === 'rejected');
    expect(vencedores).toHaveLength(1);
    expect(perdedores).toHaveLength(4);

    // O motivo de CADA rejeicao tem que ser um dos dois esperados (por CODIGO).
    for (const p of perdedores) {
      const motivo = (p as PromiseRejectedResult).reason;
      expect(['CONFLITO_DE_ESTADO', 'TRANSICAO_INVALIDA']).toContain(motivo.code);
    }

    // Estado final e trilha coerentes com UMA unica transicao vencedora.
    const final = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(final.status).toBe(OrderStatus.PAGO);
    const hist = await getStatusHistory(order.id);
    expect(hist).toHaveLength(1);
    expect(Array.from({ length: 5 }, (_, i) => 'u' + i)).toContain(hist[0].changedBy);
  });

  it('rejeita changedBy vazio ou so espacos', async () => {
    const order = await novoPedido();
    await expect(
      updateOrderStatus(order.id, OrderStatus.PAGO, '   ')
    ).rejects.toThrow('AUTOR_INVALIDO');
    expect(await getStatusHistory(order.id)).toHaveLength(0);
  });

  it('normaliza changedBy aparando espacos nas extremidades', async () => {
    const order = await novoPedido();
    await updateOrderStatus(order.id, OrderStatus.PAGO, '  admin1  ');
    const hist = await getStatusHistory(order.id);
    expect(hist[0].changedBy).toBe('admin1');
  });

  it('rejeita changedBy longo demais', async () => {
    const order = await novoPedido();
    await expect(
      updateOrderStatus(order.id, OrderStatus.PAGO, 'x'.repeat(129))
    ).rejects.toThrow('AUTOR_INVALIDO');
  });

  it('ordena por sequencia mesmo com createdAt identico', async () => {
    const order = await novoPedido();
    const t = new Date();
    await prisma.orderStatusHistory.create({
      data: { orderId: order.id, fromStatus: OrderStatus.PENDENTE, toStatus: OrderStatus.PAGO, changedBy: 'a', createdAt: t },
    });
    await prisma.orderStatusHistory.create({
      data: { orderId: order.id, fromStatus: OrderStatus.PAGO, toStatus: OrderStatus.ENVIADO, changedBy: 'b', createdAt: t },
    });
    const hist = await getStatusHistory(order.id);
    expect(hist.map((h) => [h.fromStatus, h.toStatus])).toEqual([
      [OrderStatus.PENDENTE, OrderStatus.PAGO],
      [OrderStatus.PAGO, OrderStatus.ENVIADO],
    ]);
  });

  it('banco rejeita historico com fromStatus == toStatus', async () => {
    const order = await novoPedido();
    await expect(
      prisma.orderStatusHistory.create({
        data: { orderId: order.id, fromStatus: OrderStatus.PAGO, toStatus: OrderStatus.PAGO, changedBy: 'a' },
      })
    ).rejects.toThrow(/historico_status_diferente/);
  });

  it('politica deliberada: apagar o pedido remove a trilha (cascade)', async () => {
    const order = await novoPedido();
    await updateOrderStatus(order.id, OrderStatus.PAGO, 'admin1');
    expect(await getStatusHistory(order.id)).toHaveLength(1);
    await prisma.order.delete({ where: { id: order.id } });
    expect(await getStatusHistory(order.id)).toHaveLength(0);
  });
});

describe('aplicarTransicao sob concorrencia', () => {
  // O compare-and-swap de `aplicarTransicao` (order.service.ts:53, o `where`
  // com `status: order.status`) JA era nomeado por um teste — "concorrencia: a
  // MESMA transicao aplicada 2x so vale uma vez", acima. O problema nao era
  // ausencia de cobertura, era cobertura INTERMITENTE: sob a sabotagem S2
  // (condicao apagada do WHERE), aquele caso falhou em 1 de 4 execucoes; nas
  // outras 3 a suite inteira ficou verde com o CAS ausente. Reforcado para
  // cinco disputantes, aquele caso subiu para 2 de 4 — melhor, nao determinista.
  // Este falhou em 4 de 4. Ha ainda um terceiro, `CASO G11` em
  // payment-capture.integration.test.ts, que detectou S2 em 3 de 4. Achado 4.4
  // da 2a rodada do PR #63.
  //
  // A diferenca nao e o assunto, e a CONFIABILIDADE: 5 disputantes em vez de 2,
  // e a assercao no HISTORICO, que conta ESCRITAS em vez de observar o estado
  // final — sem o CAS varias passam e o historico denuncia, mesmo quando o
  // status final por acaso coincide.
  //
  // A licao de desenho veio de um teste meu descartado neste mesmo bloco: um
  // caso que depende de um INTERLEAVE ESPECIFICO depende de sorte, e sorte
  // passa verde. Este depende de CONTENCAO — varias promessas na MESMA linha
  // bloqueiam no lock do Postgres, a primeira commita, as demais reavaliam o
  // WHERE e recebem `count === 0`. Nao importa qual vence, importa que so UMA
  // passe.
  it('exatamente uma transicao concorrente vence e o historico registra uma unica linha', async () => {
    const order = await novoPedido();
    await updateOrderStatus(order.id, OrderStatus.PAGO, 'admin1');

    const resultados = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        updateOrderStatus(order.id, OrderStatus.ENVIADO, 'admin-concorrente'),
      ),
    );

    const ok = resultados.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);

    // Toda recusa tem de ser de DOMINIO. `CONFLITO_DE_ESTADO` quando a
    // transacao leu PAGO e perdeu o CAS; `TRANSICAO_INVALIDA` quando leu depois
    // do commit do vencedor e ENVIADO->ENVIADO ja nao existe na matriz. Timeout
    // de pool nao e nenhum dos dois, e aceitar um faria o caso passar sem ter
    // medido concorrencia — a falha que este arquivo existe para nao repetir.
    for (const r of resultados) {
      if (r.status !== 'rejected') continue;
      expect(r.reason).toBeInstanceOf(DomainError);
      expect(['CONFLITO_DE_ESTADO', 'TRANSICAO_INVALIDA']).toContain(
        (r.reason as DomainError).code,
      );
    }

    const depois = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(depois.status).toBe(OrderStatus.ENVIADO);

    // A assercao com dentes: sem o CAS, varias escritas passam e o historico
    // grava PAGO -> ENVIADO mais de uma vez.
    const hist = await getStatusHistory(order.id);
    expect(hist.filter((h) => h.toStatus === OrderStatus.ENVIADO)).toHaveLength(1);
  });
});
