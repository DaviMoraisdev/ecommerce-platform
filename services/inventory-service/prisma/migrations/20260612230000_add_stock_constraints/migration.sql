-- Garante integridade do estoque no nivel do banco
ALTER TABLE "inventory" ADD CONSTRAINT "quantity_nao_negativa" CHECK ("quantity" >= 0);
ALTER TABLE "inventory" ADD CONSTRAINT "reserved_nao_negativa" CHECK ("reserved" >= 0);
ALTER TABLE "inventory" ADD CONSTRAINT "reserved_menor_igual_quantity" CHECK ("reserved" <= "quantity");
