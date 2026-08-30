import { executarCiclo } from '../../../src/jobs/runtime';

describe('executarCiclo', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('CASO N4: falha de UMA varredura nao impede a seguinte', async () => {
    // Com um catch unico ao redor do ciclo, um erro na reconciliacao deixaria o
    // inbox sem varrer ate alguem reiniciar o servico. As duas sao
    // independentes e uma nao pode sequestrar o ciclo da outra.
    const inbox = jest.fn(async () => undefined);
    await executarCiclo(
      [
        {
          nome: 'reconciliacao',
          executar: jest.fn(async () => {
            throw new Error('banco fora do ar');
          }),
        },
        { nome: 'inbox', executar: inbox },
      ],
      () => false,
    );

    expect(inbox).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('reconciliacao'));
  });

  it('CASO N5: parada durante o ciclo interrompe as varreduras restantes', async () => {
    // Sem esta checagem, um shutdown esperaria a fila inteira de varreduras
    // mesmo depois de decidido que ninguem deve mais tocar no banco.
    const segunda = jest.fn(async () => undefined);
    let parado = false;
    await executarCiclo(
      [
        {
          nome: 'primeira',
          executar: jest.fn(async () => {
            parado = true;
          }),
        },
        { nome: 'segunda', executar: segunda },
      ],
      () => parado,
    );

    expect(segunda).not.toHaveBeenCalled();
  });
});
