import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Garante JWT_SECRET nos testes ANTES de qualquer import que o leia.
// O authMiddleware usa process.env.JWT_SECRET para verificar tokens; os
// testes geram tokens com este mesmo segredo.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-product-service';

let mongoServer: MongoMemoryServer;

// Sobe um MongoDB efemero em memoria e conecta o Mongoose nele.
// Isolamento estrutural: este banco nao e o de desenvolvimento — ele so
// existe durante os testes e e descartado no fim.
beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
});

// Limpa todas as collections entre cada teste, garantindo que um teste
// nao veja dados criados por outro (independencia entre testes).
afterEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
});

// Desconecta e derruba o servidor em memoria ao fim de tudo,
// evitando handles abertos que deixariam o Jest pendurado.
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});
