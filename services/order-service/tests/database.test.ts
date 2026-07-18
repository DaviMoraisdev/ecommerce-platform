import { prisma, connectDatabase } from '../src/config/database';

describe('connectDatabase', () => {
  afterEach(() => jest.restoreAllMocks());

  it('resolve e loga quando $connect sucede', async () => {
    jest.spyOn(prisma, '$connect').mockResolvedValue(undefined as never);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(connectDatabase()).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalled();
  });

  it('lanca mensagem sanitizada quando $connect rejeita', async () => {
    const err = new Error('detalhe sensivel');
    err.name = 'PrismaClientInitializationError';
    jest.spyOn(prisma, '$connect').mockRejectedValue(err);
    await expect(connectDatabase()).rejects.toThrow(
      'Falha ao conectar ao banco de dados: PrismaClientInitializationError'
    );
  });
});
