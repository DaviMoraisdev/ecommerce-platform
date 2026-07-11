// loadConfig exige JWT_SECRET em qualquer ambiente. Garante valor nos testes.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test_secret_para_jest';
