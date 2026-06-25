import dotenv from 'dotenv';
dotenv.config({ path: '.env.test' });

// SALVAGUARDA: recusa rodar os testes se o banco nao for claramente de teste.
// Testes criam e deletam registros — rodar contra um banco real seria destrutivo.
// Exigimos que a DATABASE_URL contenha 'test' no nome do banco.
const dbUrl = process.env.DATABASE_URL || '';

if (!dbUrl) {
  throw new Error(
    'DATABASE_URL ausente. Os testes precisam de um banco de teste configurado.'
  );
}

// Extrai o nome do banco (depois da ultima barra, antes de query params)
const dbName = dbUrl.split('/').pop()?.split('?')[0] || '';

if (!dbName.includes('test')) {
  throw new Error(
    `RECUSANDO rodar testes: o banco '${dbName}' nao parece ser de teste. ` +
    `Configure DATABASE_URL para um banco com 'test' no nome (ex: inventory_test_db) ` +
    `para evitar perda de dados.`
  );
}
