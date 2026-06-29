import mongoose from 'mongoose';

// Teste-fumaca: nao testa regra de negocio. So confirma que a infra de teste
// funciona — que o Mongo em memoria subiu e o Mongoose conectou. Se isto passa,
// a fundacao esta pronta para os testes de verdade.
describe('infra de teste', () => {
  it('conecta ao Mongo em memoria', () => {
    // readyState 1 = connected
    expect(mongoose.connection.readyState).toBe(1);
  });

  it('consegue escrever e ler uma collection efemera', async () => {
    const Temp = mongoose.connection.collection('smoke_test');
    await Temp.insertOne({ ok: true });
    const found = await Temp.findOne({ ok: true });
    expect(found?.ok).toBe(true);
  });
});
