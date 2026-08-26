-- AlterTable
ALTER TABLE "idempotency_records" ADD COLUMN     "completedResponse" JSONB;

-- Bloco 6a. Idempotencia estrita: a mesma requisicao devolve a MESMA resposta.
--
-- Irmao do idempotency_completed_exige_pagamento: um registro COMPLETED sem
-- resposta congelada significaria "concluido, mas sem o que devolver no
-- replay". A diferenca e que aquele nasceu com a tabela e este chega depois,
-- sobre linhas que ja existem.
--
-- NOT VALID e deliberado, nao atalho. Um CHECK comum verifica TODA a tabela na
-- criacao e falharia em qualquer banco com COMPLETED anterior a esta migration
-- — o mesmo modo de falha que uma revisao apontou noutra migration deste
-- projeto. Com NOT VALID a restricao vale para toda linha INSERIDA OU ALTERADA
-- a partir de agora; as antigas ficam de fora ate um VALIDATE CONSTRAINT
-- posterior, apos backfill.
--
-- Enquanto isso, o replay trata linha legada (COMPLETED sem resposta) num ramo
-- EXPLICITO que reconstroi a partir do Payment vivo e loga. Comportamento
-- antigo, declarado, nunca silencioso.
ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_completed_exige_resposta"
  CHECK ("status" <> 'COMPLETED' OR "completedResponse" IS NOT NULL)
  NOT VALID;
