-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'REEMBOLSADO';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "refundedTotal" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Rede de seguranca no BANCO, nao so no codigo (mesma disciplina dos CHECK do
-- payment-service). Total estornado negativo nao e estado que a aplicacao possa
-- produzir por caminho valido, entao o banco recusa.
--
-- NAO ha CHECK `refundedTotal <= total`: captura PARCIAL e cenario planejado
-- (gatilho registrado na Fase 5), e nele o total do pedido diverge
-- legitimamente do valor capturado. Constraint que hoje parece obvia viraria
-- bloqueio para um caminho que o roadmap ja preve.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_refunded_total_nao_negativo" CHECK ("refundedTotal" >= 0);
