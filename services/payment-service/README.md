# payment-service

Servico de pagamentos (Fase 5, em construcao). PostgreSQL via Prisma.

**Estado:** Blocos 1 e 2 concluidos — dominio monetario, schema com invariantes e a
porta do provedor. Ainda **nao ha endpoint de negocio**: apenas `/health`.

## Rodar (dev)

1. Na raiz: `docker compose up -d postgres`
2. `cp .env.example .env` e ajuste as credenciais.
3. Criar o banco:
   `docker exec ecommerce-postgres psql -U <usuario> -c "CREATE DATABASE payment_db;"`
4. `npm install && npx prisma migrate deploy`
5. `npm run dev` — sobe na porta de `PAYMENT_PORT` (padrao 3007)

O boot **conecta ao banco antes de abrir a porta**: credencial invalida derruba o
processo com erro sanitizado, em vez de responder `/health` 200 sem persistencia
utilizavel.

## Dinheiro e sempre centavo inteiro

`src/domain/money.ts` e a unica representacao monetaria do servico. `toCents()`
**rejeita** qualquer valor que nao caiba exatamente em duas casas decimais — inclusive
float ja corrompido (`0.1 + 0.2`) e notacao cientifica. Nunca arredonda.

Motivo: `Math.round(1.005 * 100)` devolve 100, nao 101, porque `1.005 * 100` e
`100.4999...` em binario. E todo gateway de pagamento trabalha em centavos inteiros.

Limite conhecido: a premissa de 100 centavos por unidade e valida para BRL e falsa para
JPY (0 casas) e dinares (3). Registrado em `docs/TECH_DEBT.md`.

## Camadas

```
src/
|-- domain/
|   `-- money.ts                    centavos inteiros, conversao que rejeita imprecisao
|-- providers/
|   |-- payment-provider.port.ts    A PORTA: interface, tipos de dominio, erros
|   `-- fake/                       adapter deterministico para dev e teste
|-- config/
|   |-- env.ts                      loadConfig() puro e testavel, lanca ConfigError
|   |-- database.ts                 nao le o ambiente; recebe a URL ja validada
|   `-- database-error.ts           sanitiza erro de conexao (a senha nunca vai ao log)
|-- bootstrap.ts                    ordem: config -> conexao -> listen (testada)
`-- server.ts                       unico ponto do servico com process.exit
```

### A porta do provedor

`payment-provider.port.ts` usa vocabulario do **dominio**, nao do provedor. Se aparecer
`payment_intent_id` ou `client_secret`, a abstracao vazou — sao termos da Stripe.

O adapter e o unico lugar que conhece o provedor real: formato de erro, vocabulario e
formato de webhook morrem ali (camada anticorrupcao). O adapter da Stripe entra no
Bloco 9 e roda a **mesma suite de contrato** que o Fake
(`tests/unit/providers/payment-provider.contract.ts`) — e o que garante que trocar de
provedor nao muda a logica de negocio.

Tres regras que a porta impoe:

- **O cartao nunca passa por este servico.** `createCharge` recebe
  `paymentMethodToken`, gerado no navegador pelo proprio provedor. Nunca PAN, CVV ou
  validade. Aceitar PAN jogaria o projeto no escopo mais caro de auditoria PCI-DSS.
- **Recusa de cartao e resultado, nao excecao.** `state: 'DECLINED'` com `declineCode`.
  Somente falha tecnica lanca, e o erro carrega `retryable` como dado.
- **Duas camadas de idempotencia.** A nossa (`Idempotency-Key` HTTP) protege o banco; a
  do provedor (`idempotencyKey` na porta) protege o dinheiro — se a chamada der timeout
  e retentarmos, a primeira pode ter chegado.

### Invariantes no banco

A migration cria 11 CHECK constraints e 2 foreign keys com `Restrict`. As centrais:

| Constraint | Regra |
|---|---|
| `payment_refunded_dentro_do_capturado` | `0 <= refunded <= captured` |
| `payment_captured_dentro_do_total` | `0 <= captured <= amount` |
| `payment_currency_suportada` | `currency = 'BRL'` |
| `idempotency_completed_exige_pagamento` | `COMPLETED` exige `paymentId` |

Constraint e **rede de seguranca**, nao mecanismo primario: o compare-and-swap na
aplicacao vem nos Blocos 5 e 7. Os nomes sao explicitos para que a mensagem de erro
identifique o que foi violado sem consulta ao schema — e para que o teste possa asserir
o nome.

## Variaveis de ambiente

Ver `.env.example` (execucao) e `.env.test.example` (testes). Nenhum dos dois contem
segredo que funcione: chave secreta entra sempre com valor vazio ou placeholder.

## Testes

- `npm test` — unitarios. Nao tocam o banco; seguros em qualquer ambiente.
- `npm run test:integration` — integracao contra banco **isolado**.
- `npm run typecheck` — `tsc --noEmit` cobrindo `src/` **e** `tests/`.
- `npm run verify` — `typecheck + build + test`. **Comando de referencia antes de commit.**

`npm test` nao verifica tipos: o Jest roda com `diagnostics: false` para transpilar sem
type-check, o que deixa a suite ~3,4x mais rapida. Erro de tipo aparece no `typecheck`,
nao no `test` — por isso o `verify` existe e por isso ele e o gate, nao o `test`.

### Pre-requisitos da suite de integracao

1. `cp .env.test.example .env.test` (mantenha `ALLOW_TEST_DB_RESET=true`)
2. Criar o banco:
   `docker exec ecommerce-postgres psql -U <usuario> -c "CREATE DATABASE payment_test_db;"`
3. Aplicar as migrations no banco de teste:
   `( set -a; . ./.env.test; set +a; npx prisma migrate deploy )`
4. `npm run test:integration`

### A guarda de banco de teste

Os testes de integracao executam `deleteMany()`. `tests/helpers/testDbGuard.ts` aborta a
suite se **qualquer** das quatro barreiras falhar:

1. nome **exato** do banco, lido do `pathname` da URL — `test` no meio do nome ou dentro
   da senha nao vale;
2. `NODE_ENV=test`;
3. `ALLOW_TEST_DB_RESET=true` — consentimento **positivo** de quem configurou o ambiente;
4. host local, salvo `ALLOW_REMOTE_TEST_DB=true`.

A guarda roda em `tests/setup.integration.ts` (cobertura estrutural: arquivo novo ja
nasce protegido) **e** no `beforeAll` do arquivo destrutivo (defesa em profundidade: a
config do Jest pode ser trocada por linha de comando).

`ALLOW_REMOTE_TEST_DB` desliga **apenas** a checagem de host. Nome do banco, `NODE_ENV`
e o opt-in continuam obrigatorios.
