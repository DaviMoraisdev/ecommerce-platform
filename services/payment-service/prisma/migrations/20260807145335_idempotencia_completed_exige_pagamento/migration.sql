-- Item 4.1 da revisao do PR #47.
--
-- A tabela de idempotencia existe para que uma requisicao repetida receba o
-- MESMO resultado da primeira, em vez de causar uma segunda cobranca. Um
-- registro COMPLETED sem paymentId significaria "processamento concluido, mas
-- sem resultado para devolver": o replay nao teria o que retornar, e o fluxo
-- financeiro ficaria travado sem caminho de recuperacao.
--
-- PROCESSING e FAILED aceitam paymentId nulo por desenho: no claim-first a
-- chave e reivindicada antes de o pagamento existir, e a falha pode ocorrer
-- antes ou depois da criacao.
ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_completed_exige_pagamento"
  CHECK ("status" <> 'COMPLETED' OR "paymentId" IS NOT NULL);
