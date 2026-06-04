import dotenv from 'dotenv';
dotenv.config();
import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const SALT_ROUNDS = 10;

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME;

  if (!email || !password || !name) {
    console.error('ADMIN_EMAIL, ADMIN_PASSWORD e ADMIN_NAME sao obrigatorios no .env');
    process.exit(1);
  }

  // Idempotente: so cria se nao existir nenhum ADMIN
  const existingAdmin = await prisma.user.findFirst({
    where: { role: 'ADMIN' },
  });

  if (existingAdmin) {
    console.log('Admin ja existe:', existingAdmin.email);
    return;
  }

  const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

  const admin = await prisma.user.create({
    data: {
      email,
      password: hashedPassword,
      name,
      role: 'ADMIN',
    },
  });

  console.log('Admin criado com sucesso:', admin.email);
}

main()
  .catch((e) => {
    console.error('Erro ao rodar seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
