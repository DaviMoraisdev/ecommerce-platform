import bcrypt from 'bcrypt';

describe('Hash de senha com bcrypt', () => {
  const senha = 'minhaSenha123';

  it('deve gerar um hash diferente da senha original', async () => {
    const hash = await bcrypt.hash(senha, 10);
    expect(hash).not.toBe(senha);
  });

  it('deve validar a senha correta contra o hash', async () => {
    const hash = await bcrypt.hash(senha, 10);
    const match = await bcrypt.compare(senha, hash);
    expect(match).toBe(true);
  });

  it('deve rejeitar uma senha incorreta', async () => {
    const hash = await bcrypt.hash(senha, 10);
    const match = await bcrypt.compare('senhaErrada', hash);
    expect(match).toBe(false);
  });

  it('deve gerar hashes diferentes para a mesma senha (salt)', async () => {
    const hash1 = await bcrypt.hash(senha, 10);
    const hash2 = await bcrypt.hash(senha, 10);
    expect(hash1).not.toBe(hash2);
  });
});
