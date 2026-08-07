-- AlterTable
ALTER TABLE "idempotency_records" ALTER COLUMN "paymentId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================
-- Alinhamento entre o dominio TypeScript e as garantias do banco.
-- Motivado pela revisao do PR #47 (itens 4.2 e 4.3).
-- ============================================================

-- 4.2: "char_length = 3" aceitava 'abc', '123' e espacos. O dominio suporta
-- exclusivamente BRL (src/config/env.ts: type Currency = 'BRL'). Restringir a
-- allowlist real. Quando houver segunda moeda, esta constraint muda junto —
-- e isso e desejavel: forca a decisao a passar por migration revisada.
ALTER TABLE "payments" DROP CONSTRAINT "payment_currency_iso4217";

ALTER TABLE "payments"
  ADD CONSTRAINT "payment_currency_suportada"
  CHECK ("currency" = 'BRL');

-- 4.3: o teto existia so no TypeScript (MAX_AMOUNT_CENTS em src/domain/money.ts).
-- Qualquer escrita que nao passe por assertValidCents burlava a regra.
-- ATENCAO: o valor 1000000000 DEVE espelhar MAX_AMOUNT_CENTS. Ha teste de
-- integracao que amarra os dois — se divergirem, a suite quebra.
--
-- Teto aplicado apenas nas duas raizes independentes: captured e refunded ja
-- estao limitados por transitividade (refunded <= captured <= amount <= teto).
ALTER TABLE "payments"
  ADD CONSTRAINT "payment_amount_dentro_do_teto"
  CHECK ("amountCents" <= 1000000000);

ALTER TABLE "payment_transactions"
  ADD CONSTRAINT "transaction_amount_dentro_do_teto"
  CHECK ("amountCents" <= 1000000000);
