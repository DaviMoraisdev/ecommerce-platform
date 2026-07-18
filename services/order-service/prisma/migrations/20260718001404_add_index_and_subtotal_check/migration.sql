-- CreateIndex
CREATE INDEX "order_items_orderId_idx" ON "order_items"("orderId");

-- Invariante por item: subtotal = unitPrice * quantity (numeric exato).
-- (total = soma dos itens exige logica transacional -> Bloco 7.)
ALTER TABLE "order_items" ADD CONSTRAINT "subtotal_consistente" CHECK ("subtotal" = "unitPrice" * "quantity");
