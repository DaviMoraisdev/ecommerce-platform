-- Constraints CHECK (Prisma nao expressa CHECK no schema; aplicadas via SQL).
ALTER TABLE "orders" ADD CONSTRAINT "total_nao_negativo" CHECK ("total" >= 0);
ALTER TABLE "order_items" ADD CONSTRAINT "quantity_positiva" CHECK ("quantity" > 0);
ALTER TABLE "order_items" ADD CONSTRAINT "unitprice_nao_negativo" CHECK ("unitPrice" >= 0);
ALTER TABLE "order_items" ADD CONSTRAINT "subtotal_nao_negativo" CHECK ("subtotal" >= 0);
