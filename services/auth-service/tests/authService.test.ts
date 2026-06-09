process.env.JWT_SECRET = 'test_secret';
process.env.JWT_EXPIRES_IN = '15m';
process.env.JWT_REFRESH_SECRET = 'test_refresh_secret';
process.env.JWT_REFRESH_EXPIRES_IN = '7d';

// Mock do Prisma: as funcoes sao criadas dentro do factory para evitar hoisting
jest.mock('@prisma/client', () => {
  const mockFns = {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  return {
    PrismaClient: jest.fn(() => ({ user: mockFns })),
    __mockFns: mockFns,
  };
});

import { registerUser, loginUser } from '../src/services/auth.service';
import bcrypt from 'bcrypt';
import * as prismaModule from '@prisma/client';

const mockFns = (prismaModule as any).__mockFns;

describe('registerUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('deve persistir a senha hasheada, nunca em texto puro', async () => {
    mockFns.findUnique.mockResolvedValue(null);
    mockFns.create.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: '1', ...data, role: 'BUYER' })
    );

    await registerUser('novo@teste.com', 'senha123', 'Novo');

    const dadosSalvos = mockFns.create.mock.calls[0][0].data;
    expect(dadosSalvos.password).not.toBe('senha123');
    const ehHashValido = await bcrypt.compare('senha123', dadosSalvos.password);
    expect(ehHashValido).toBe(true);
  });

  it('deve lancar erro se o email ja existe', async () => {
    mockFns.findUnique.mockResolvedValue({ id: '1', email: 'existe@teste.com' });

    await expect(
      registerUser('existe@teste.com', 'senha123', 'Existe')
    ).rejects.toThrow('EMAIL_ALREADY_EXISTS');
  });
});

describe('loginUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('deve rejeitar credenciais quando usuario nao existe', async () => {
    mockFns.findUnique.mockResolvedValue(null);

    await expect(
      loginUser('naoexiste@teste.com', 'senha123')
    ).rejects.toThrow('INVALID_CREDENTIALS');
  });

  it('deve rejeitar quando a senha esta errada', async () => {
    const hashReal = await bcrypt.hash('senhaCerta', 10);
    mockFns.findUnique.mockResolvedValue({
      id: '1', email: 'davi@teste.com', name: 'Davi',
      password: hashReal, role: 'BUYER',
    });

    await expect(
      loginUser('davi@teste.com', 'senhaErrada')
    ).rejects.toThrow('INVALID_CREDENTIALS');
  });
});
