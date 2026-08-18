-- Coluna OBRIGATORIA: toda claim registra qual requisicao a criou.
-- Ver o comentario do modelo em schema.prisma (achado 4.4 do review do PR #52).
--
-- O DELETE abaixo e DELIBERADO, nao gerado pelo Prisma. Justificativa:
--
--   1. idempotency_records e estado de claim TRANSITORIO, nao trilha financeira.
--      A trilha e payments + payment_transactions, que esta migration nao toca.
--   2. Nao existe deployment de producao deste servico.
--   3. A unica linha presente veio do smoke manual do Bloco 3: a claim foi
--      marcada FAILED porque o order-service estava fora do ar.
--   4. O pior efeito de perde-la e uma Idempotency-Key antiga voltar a ser
--      aceita como nova — sem consequencia financeira, porque nenhum pagamento
--      chegou a ser criado por ela.
--
-- A FK idempotency_records -> payments e Restrict no sentido OPOSTO: apagar o
-- registro filho nao afeta nenhum pagamento.
DELETE FROM "idempotency_records";

-- AlterTable
ALTER TABLE "idempotency_records" ADD COLUMN "requestFingerprint" TEXT NOT NULL;
