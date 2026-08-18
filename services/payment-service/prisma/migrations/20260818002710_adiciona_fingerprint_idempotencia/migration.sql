-- Vincula cada claim de idempotencia a requisicao que a criou.
-- Ver o comentario do modelo em schema.prisma (achado 4.4 do review do PR #52).
--
-- A PRIMEIRA versao desta migration fazia `DELETE FROM idempotency_records`
-- incondicional, justificado por um comentario afirmando que nao havia producao
-- e que so existia uma claim de smoke. O segundo review recusou, com razao:
-- migration e artefato que roda em OUTRAS maquinas e DEPOIS. Comentario nao e
-- precondicao. Se houvesse claim COMPLETED, sua chave voltaria a ser aceita como
-- nova e uma operacao financeira concluida poderia se repetir.
--
-- Esta versao nao depende de nenhuma premissa sobre o ambiente.

-- 1. Coluna nullable, para permitir o backfill.
ALTER TABLE "idempotency_records" ADD COLUMN "requestFingerprint" TEXT;

-- 2. Backfill do que E recuperavel. Toda claim com paymentId conhece seu pedido
--    pelo Payment referenciado, entao o fingerprint pode ser RECALCULADO com a
--    mesma receita do servico: sha256("v1:" || orderId), em hexadecimal.
UPDATE "idempotency_records" AS ir
SET "requestFingerprint" = encode(sha256(convert_to('v1:' || p."orderId", 'UTF8')), 'hex')
FROM "payments" AS p
WHERE ir."paymentId" = p."id";

-- 3. Claims SEM paymentId nunca chegaram a criar pagamento: nenhum efeito
--    financeiro aconteceu por elas, e o orderId nao e recuperavel. Descartar e
--    seguro, e o pior efeito e uma chave antiga voltar a ser aceita como nova.
DELETE FROM "idempotency_records"
WHERE "requestFingerprint" IS NULL AND "paymentId" IS NULL;

-- 4. PRECONDICAO EXECUTAVEL. Se sobrou nulo, existe claim com paymentId cujo
--    Payment nao foi encontrado — estado que as FKs deveriam impedir. Aborta a
--    migration inteira em vez de decidir sozinha o que fazer com dado
--    financeiro.
DO $$
DECLARE restantes INTEGER;
BEGIN
  SELECT count(*) INTO restantes
  FROM "idempotency_records" WHERE "requestFingerprint" IS NULL;

  IF restantes > 0 THEN
    RAISE EXCEPTION
      'ABORTADO: % claim(s) sem fingerprint recuperavel. Investigar antes de migrar.',
      restantes;
  END IF;
END $$;

-- 5. Agora sim, obrigatoria.
ALTER TABLE "idempotency_records" ALTER COLUMN "requestFingerprint" SET NOT NULL;
