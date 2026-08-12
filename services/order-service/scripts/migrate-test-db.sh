#!/usr/bin/env bash
#
# Aplica migrations no banco de TESTE, falhando de forma FECHADA.
#
# O padrao antigo era:
#   ( set -a; . ./.env.test; set +a; npx prisma migrate deploy )
#
# Ele nao e seguro: os comandos sao separados por ";", entao se o source do
# .env.test falhar (arquivo ausente, sem permissao), o migrate deploy AINDA roda
# — usando o DATABASE_URL herdado do ambiente. Isso pode aplicar migration no
# banco de desenvolvimento.
#
# Aqui: aborta se o arquivo nao existe, se DATABASE_URL esta ausente, ou se o
# banco alvo nao e exatamente o de teste. Mesmo criterio da guarda em
# tests/helpers/testDbGuard.ts, aplicado a migration.

set -euo pipefail

ESPERADO="order_test_db"
ARQUIVO=".env.test"

if [ ! -f "$ARQUIVO" ]; then
  echo "ABORTADO: $ARQUIVO nao encontrado. Copie de .env.test.example." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "./$ARQUIVO"
set +a

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ABORTADO: DATABASE_URL ausente em $ARQUIVO." >&2
  exit 1
fi

# Nome do banco = ultimo segmento do path, sem query string.
NOME="$(printf '%s' "$DATABASE_URL" | sed -E 's|.*/([^/?]+)(\?.*)?$|\1|')"

if [ "$NOME" != "$ESPERADO" ]; then
  # Nao imprime a URL: ela contem a senha.
  echo "ABORTADO: banco alvo e \"$NOME\", esperado \"$ESPERADO\"." >&2
  exit 1
fi

echo "Aplicando migrations em $ESPERADO..."
npx prisma migrate deploy
