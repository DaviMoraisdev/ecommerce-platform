#!/usr/bin/env bash
# Prova a migration do fingerprint contra registros PREEXISTENTES.
#
# Pedido no segundo review do PR #52. A migration nao pode depender de premissa
# sobre o ambiente, entao precisa ser exercitada num banco descartavel com os
# tres tipos de claim que podem existir antes dela.
#
# Nunca imprime credenciais.
set -euo pipefail
cd "$(dirname "$0")/.."

eval "$(node -e "
require('dotenv').config({quiet:true});
const u = new URL(process.env.DATABASE_URL);
console.log('PGUSER=' + u.username);
console.log('PGPASSWORD=' + u.password);
console.log('PGHOST_DB=' + u.pathname.slice(1));
" | sed 's/^/export /')"

SCRATCH=payment_migration_check
PSQL="docker compose -f ../../docker-compose.yml exec -T -e PGPASSWORD=$PGPASSWORD postgres psql -v ON_ERROR_STOP=1 -U $PGUSER"

echo "--- banco descartavel: $SCRATCH ---"
$PSQL -d postgres -c "DROP DATABASE IF EXISTS $SCRATCH;" >/dev/null
$PSQL -d postgres -c "CREATE DATABASE $SCRATCH;" >/dev/null

echo "--- aplica as migrations ANTERIORES a do fingerprint ---"
for dir in $(ls -d prisma/migrations/*/ | sort); do
  case "$dir" in *fingerprint*) continue;; esac
  echo "    $(basename "$dir")"
  $PSQL -d $SCRATCH < "$dir/migration.sql" >/dev/null
done

echo "--- semeia os TRES tipos de claim que podem existir ---"
$PSQL -d $SCRATCH >/dev/null <<'SQL'
INSERT INTO "payments" (id,"orderId","userId",status,"amountCents",currency,provider,"expiresAt","updatedAt")
VALUES ('pay-a','ord-alpha','usr-1','CAPTURED',12990,'BRL','fake', now() + interval '15 min', now()),
       ('pay-b','ord-beta','usr-1','PROCESSING',5000,'BRL','fake', now() + interval '15 min', now());

INSERT INTO "idempotency_records" (id,"userId",key,"paymentId",status,"updatedAt")
VALUES ('rec-completed','usr-1','chave-concluida','pay-a','COMPLETED', now()),
       ('rec-processing','usr-1','chave-em-voo','pay-b','PROCESSING', now()),
       ('rec-orfa','usr-1','chave-sem-pagamento',NULL,'FAILED', now());
SQL

echo "--- aplica a migration do fingerprint ---"
$PSQL -d $SCRATCH < prisma/migrations/*fingerprint*/migration.sql >/dev/null
echo "    aplicada sem abortar"

echo "--- resultado ---"
$PSQL -d $SCRATCH -c "SELECT id, COALESCE(\"paymentId\",'(sem pagamento)') AS pagamento, status, \"requestFingerprint\" FROM \"idempotency_records\" ORDER BY id;"

echo "--- a coluna aceita NULL? (esperado: NAO) ---"
# is_nullable devolve a string 'NO' quando a coluna e NOT NULL, o que se le como
# reprovacao quando o rotulo pergunta "ficou NOT NULL?". Traduzido para nao
# depender de interpretacao.
NULAVEL=$($PSQL -d $SCRATCH -tAc "SELECT is_nullable FROM information_schema.columns WHERE table_name='idempotency_records' AND column_name='requestFingerprint';" | tr -d '[:space:]')
if [ "$NULAVEL" = "NO" ]; then echo "    NAO — coluna obrigatoria, correto"; else echo "    SIM — a migration NAO tornou a coluna obrigatoria"; exit 1; fi

echo "--- o fingerprint do backfill bate com a receita do servico? ---"
NO_BANCO=$($PSQL -d $SCRATCH -tAc "SELECT \"requestFingerprint\" FROM \"idempotency_records\" WHERE id='rec-completed';" | tr -d '[:space:]')
NO_NODE=$(node -e "console.log(require('node:crypto').createHash('sha256').update('v1:ord-alpha').digest('hex'))")
echo "    banco: $NO_BANCO"
echo "    node : $NO_NODE"
[ "$NO_BANCO" = "$NO_NODE" ] && echo "    IGUAIS" || { echo "    DIVERGEM — backfill invalido"; exit 1; }

echo "--- a claim orfa (sem pagamento) foi removida? ---"
$PSQL -d $SCRATCH -tAc "SELECT count(*) FROM \"idempotency_records\" WHERE id='rec-orfa';"

$PSQL -d postgres -c "DROP DATABASE $SCRATCH;" >/dev/null
echo "--- banco descartavel removido ---"
