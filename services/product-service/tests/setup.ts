import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Garante JWT_SECRET nos testes ANTES de qualquer import que o leia.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-product-service';

let mongoServer: MongoMemoryServer | undefined;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
});

afterEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
});

afterAll(async () => {
  // Guard: so desconecta/para se chegou a conectar/criar. Se o create falhou,
  // mongoServer fica undefined — sem o guard, o .stop() lancaria e mascararia
  // a causa real do erro de setup.
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});
