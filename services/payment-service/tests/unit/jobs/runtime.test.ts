import { criarExecutorDeCiclo } from '../../../src/jobs/runtime';

/** Promessa controlada pelo teste: e o unico jeito de encenar "pendurada". */
function adiado() {
  let resolver!: () => void;
  let rejeitar!: (erro: unknown) => void;
  const promessa = new Promise<void>((res, rej) => {
    resolver = res;
    rejeitar = rej;
  });
  return { promessa, resolver, rejeitar };
}

const assentar = () => new Promise((r) => setImmediate(r));

describe('criarExecutorDeCiclo', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('CASO N4: falha de UMA varredura nao impede a seguinte', async () => {
    // Com um catch unico ao redor do ciclo, um erro na reconciliacao deixaria o
    // inbox sem varrer ate alguem reiniciar o servico. Sao independentes.
    const inbox = jest.fn(async () => undefined);
    const executor = criarExecutorDeCiclo(
      [
        {
          nome: 'reconciliacao',
          executar: jest.fn(async () => {
            throw new Error('banco fora do ar');
          }),
        },
        { nome: 'inbox', executar: inbox },
      ],
      1_000,
    );

    await executor.executar(() => false);

    expect(inbox).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('reconciliacao'));
  });

  it('CASO N5: parada durante o ciclo interrompe as varreduras restantes', async () => {
    // Sem esta checagem, um shutdown esperaria a fila inteira mesmo depois de
    // decidido que ninguem deve mais tocar no banco.
    const segunda = jest.fn(async () => undefined);
    let parado = false;
    const executor = criarExecutorDeCiclo(
      [
        {
          nome: 'primeira',
          executar: jest.fn(async () => {
            parado = true;
          }),
        },
        { nome: 'segunda', executar: segunda },
      ],
      1_000,
    );

    await executor.executar(() => parado);

    expect(segunda).not.toHaveBeenCalled();
  });

  it('CASO N6: varredura PENDURADA nao impede a seguinte', async () => {
    // O catch so pega REJEICAO. Uma promessa que nunca resolve nao rejeita:
    // sem prazo, ela segura o `await` do ciclo para sempre.
    const d = adiado();
    const inbox = jest.fn(async () => undefined);
    const executor = criarExecutorDeCiclo(
      [
        { nome: 'reconciliacao', executar: () => d.promessa },
        { nome: 'inbox', executar: inbox },
      ],
      20,
    );

    await executor.executar(() => false);

    expect(inbox).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('excedeu o prazo'));
    d.resolver();
  });

  it('CASO N7: varredura pendurada NAO e reiniciada no ciclo seguinte', async () => {
    // Regressao que a correcao anterior criou (achado 4.1 da 3a rodada): o
    // prazo devolvia o laco mas abandonava a operacao, entao o ciclo seguinte
    // iniciava OUTRA execucao da mesma varredura. Elas se acumulavam —
    // conexoes, chamadas ao provedor e concorrencia sobre o mesmo trabalho.
    const d = adiado();
    const executar = jest.fn(() => d.promessa);
    const executor = criarExecutorDeCiclo([{ nome: 'lenta', executar }], 20);

    await executor.executar(() => false);
    await executor.executar(() => false);
    await executor.executar(() => false);

    expect(executar).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('ainda em voo'));
    d.resolver();
  });

  it('CASO N8: quando o trabalho assenta, a varredura volta a rodar', async () => {
    // Contraparte do N7: single-flight nao pode virar "nunca mais roda". Sem
    // este caso, esquecer de limpar o registro passaria despercebido e o job
    // morreria em silencio na primeira lentidao.
    const d = adiado();
    const executar = jest.fn(() => d.promessa);
    const executor = criarExecutorDeCiclo([{ nome: 'lenta', executar }], 20);

    await executor.executar(() => false);
    d.resolver();
    await assentar();

    await executor.executar(() => false);

    expect(executar).toHaveBeenCalledTimes(2);
  });

  it('CASO N9: rejeicao que chega DEPOIS do prazo e registrada, nao perdida', async () => {
    // Ninguem mais espera essa promessa: sem tratador ela viraria unhandled
    // rejection e sumiria do log — justamente o caso que mais precisa aparecer.
    const d = adiado();
    const executor = criarExecutorDeCiclo([{ nome: 'lenta', executar: () => d.promessa }], 10);

    await executor.executar(() => false);
    d.rejeitar(new Error('caiu depois do prazo'));
    await assentar();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('rejeitou APOS o prazo'));
  });

  it('CASO N10: o trabalho que excedeu o prazo continua rastreado para o shutdown', async () => {
    // Sem isto o shutdown encerraria banco e publisher POR CIMA de uma
    // varredura ainda em execucao: a promessa sumia do ciclo ao expirar.
    const d = adiado();
    const executor = criarExecutorDeCiclo([{ nome: 'lenta', executar: () => d.promessa }], 10);

    await executor.executar(() => false);
    expect(executor.emVoo()).toHaveLength(1);

    d.resolver();
    await assentar();
    expect(executor.emVoo()).toHaveLength(0);
  });
});
