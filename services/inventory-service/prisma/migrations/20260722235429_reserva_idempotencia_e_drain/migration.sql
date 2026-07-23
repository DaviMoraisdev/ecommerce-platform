-- Idempotencia: no maximo UMA reserva ACTIVE por (pedido, produto).
-- Um retry do mesmo reserve nao cria duplicata; a corrida perde no create e reverte.
CREATE UNIQUE INDEX "reservations_order_product_active_key"
  ON "reservations" ("orderId", "productId")
  WHERE status = 'ACTIVE'::"ReservationStatus";

-- Reconciliacao (drain): o modelo antigo mantinha reserved no contador SEM linha
-- de reservation. Como releaseByOrder so libera via reservation, esses valores
-- ficariam orfaos e nunca liberaveis. Nao ha pedidos reais ainda, entao zeramos
-- o reserved orfao. Politica documentada no PR #39.
UPDATE "inventory" SET reserved = 0
  WHERE "productId" NOT IN (
    SELECT "productId" FROM "reservations" WHERE status = 'ACTIVE'::"ReservationStatus"
  );
