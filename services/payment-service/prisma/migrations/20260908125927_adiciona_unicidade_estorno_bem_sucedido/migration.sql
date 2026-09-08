-- Convergencia entre os DOIS escritores de estorno (achado 4.2 do review do PR #62).
--
-- O endpoint de reembolso e o handler de refund.succeeded aplicam o mesmo
-- estorno por caminhos diferentes. Se o webhook vence a corrida, o endpoint
-- perde o CAS, recarrega um total que JA inclui o proprio estorno e soma de
-- novo — contabilidade dobrada, em silencio, no caminho feliz.
--
-- A defesa vive no BANCO, nao em JavaScript: invariante financeiro guardado so
-- por codigo e invariante que a proxima refatoracao apaga.
--
-- O predicado precisa dos DOIS filtros. So `type = 'REFUND'` quebraria o
-- caminho legitimo do PROCESSING, que grava uma linha PENDING com a mesma
-- referencia antes de o webhook confirmar com a linha SUCCEEDED. Restrito a
-- SUCCEEDED, sobra exatamente o invariante que interessa: no maximo um estorno
-- BEM-SUCEDIDO por referencia de estorno.
CREATE UNIQUE INDEX "payment_transactions_estorno_bem_sucedido_unico"
  ON "payment_transactions" ("providerRef")
  WHERE "type" = 'REFUND' AND "status" = 'SUCCEEDED';
