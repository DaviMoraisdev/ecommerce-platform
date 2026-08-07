# Dívida Técnica e Pendências — Projeto E-Commerce

Registro de decisões conscientes de adiamento, avaliadas nos code reviews e agendadas para o momento arquiteturalmente correto. Não são esquecimentos — são trade-offs documentados.

Organizado por **destino**. Só pendências: dívidas pagas são removidas daqui (o histórico permanece nos PRs).

Última atualização: **Fase 4 concluída** (Bloco 10 — fechamento).

---

## Limites conhecidos e aceitos (com gatilho de correção)

Trade-offs aceitos cujo **gatilho** de correção está explícito — não são trabalho agendado por data.

- **Janela de crash claim-first (notification-service):** se o processo cair entre o `claim` e o `ack`, a reentrega é tratada como duplicata sem processar o efeito. Inerente ao at-least-once sem efeito transacional. **Gatilho:** quando o consumer deixar de ser stub e ganhar efeito real (e-mail/push), é obrigatório adotar efeito+claim atômicos (outbox no consumidor). Destino: **evolução do notification-service (Fase 6+/pós-MVP)**.

---

- **Premissa de 2 casas decimais (payment-service):** `src/domain/money.ts` assume 100 centavos por unidade monetária. Verdadeiro para BRL, falso para JPY (0 casas) e dinares (3). Seguro enquanto `Currency = 'BRL'`. **Gatilho:** suporte a segunda moeda.


## Decisões e procedimentos documentados (sem trabalho pendente)

Registros de decisão — não há tarefa a fazer, apenas contexto para o futuro.

- **Drain de `reserved` órfão na migração do 7a:** a migration zerou `inventory.reserved` sem `reservation` (modelo antigo). Seguro por não haver pedidos reais; **com dados reais a estratégia seria backfill, não drain**.
- **Redrive da DLQ respeita o TTL do claim:** um redrive `DLQ -> fila principal` antes do TTL expirar é visto como duplicata (ack sem reprocessar). **Procedimento:** redrive só após o TTL, ou limpar `notif:evt:<eventId>` antes.

---

## Exceções de segurança aceitas (→ Fase 7)

- **Token de serviço ADMIN (order → inventory):** o order assina um token ADMIN com o segredo compartilhado para chamar `reserve/release`. Mitigação aceita, não dívida paga: o segredo compartilhado já permite forjar qualquer token, então usar ADMIN não amplia o raio de ataque. Correção real: identidade por serviço (mTLS/chaves assimétricas) + issuer/audience/scopes (ex.: `inventory:reserve`). (PR #41.)
- **Authz por dono/serviço da reserva:** a posse **estrutural** foi paga no 7a (reservas amarradas ao `orderId`; `release(orderId)` só toca o que é do pedido). A **autorização** ainda é incompleta: qualquer ADMIN/SELLER libera qualquer `orderId`; qualquer papel logado reserva com `orderId` arbitrário. Exposição conhecida e aceita para este estágio. Correção: auth serviço-a-serviço + `orderId` vindo de claims confiáveis.

---

## FASE 5 — fechar no Bloco 10 (dentro desta fase)



- **`.env` da raiz defasado em relação ao container:** a credencial do `.env` da raiz não é a que o Postgres em execução aceita; os serviços usam outra. O `docker compose down -v` documentado no README recriaria o volume com a senha da raiz e **quebraria todos os serviços de uma vez**. Alinhar raiz e serviços, e validar no boot.
- **`.env.example` ausente em `inventory-service` e `product-service`:** ambos concluídos, nenhum documenta as variáveis necessárias. Ninguém consegue subi-los em máquina nova, e as portas deles só são descobríveis lendo o código. Viola a regra do projeto de `.env.example` sempre versionado.


## FASE 7 — Gateway, Segurança e Infra

### Segurança
- **JWT hardening:** `jwt.verify` com `algorithms`/`issuer`/`audience` explícitos + validar shape do payload antes de confiar no `role`. Aplicar em auth, product, inventory e cart.
- **403 genérico:** não vazar `required`/`current` no corpo (hoje alguns serviços retornam). Logar só server-side.
- **Autenticação serviço-a-serviço:** token interno/mTLS entre serviços (product→inventory, cart→product, order→inventory). Modelar identidade de serviço.
- **Separar `/health` (liveness) de `/ready` (readiness com check de DB):** quando houver health probes de orquestração.
- **Paginação no `/admin/users` (auth-service):** [herdada da Fase 2].
- **Portas de dev em 0.0.0.0:** postgres/mongo/redis publicam em todas as interfaces (rabbitmq já restrito a 127.0.0.1). Restringir + credenciais fortes por ambiente. Dev-only, baixa.

### Infra / containerização
- **payment-service no docker-compose:** nasceu fora do compose (só `npm run dev`), mesmo estado do notification-service. Dockerfile, entrada no compose e healthcheck. Tratar junto com o item acima.
- **notification-service no docker-compose:** Dockerfile, entrada no compose, healthcheck e observabilidade (hoje só `npm run dev`).
- **Migração de args de fila durável (RabbitMQ):** args são imutáveis; adicionar a DLX exigiu deletar a fila (one-time manual). Padronizar via policy/quorum ou script de deploy.
- **Automatizar o e2e via docker-compose:** a suíte `e2e/` (Bloco 9) roda contra o stack local subido manualmente (auth, product, inventory, cart, order, notification + infra). Containerizar permite rodar no CI.
- **Limite de tamanho de mensagem no consumer:** `toString()+JSON.parse` sem checar `msg.content.length`. Cap de bytes + ACL/limite no broker. (Exchange interno, risco baixo hoje.)
- **Claim atômico entre instâncias do relay (`FOR UPDATE SKIP LOCKED`/lease):** hoje 1 instância; com múltiplas, dois relays publicariam o mesmo evento. Antes de escalar horizontalmente.
- **DLQ do notification — parking queue e classificação:** hoje payload inválido e falha de recuperação caem na mesma DLQ (distinção só no log). Follow-up: parking queue com atraso/metadados + classificação por header, para facilitar redrive e triagem.

### Resiliência
- **Timeout configurável + circuit breaker/retry no `inventory.client`** para falhas transitórias.
- **Validar config no boot do product-service:** garantir `INVENTORY_SERVICE_URL`; fallback localhost só em dev.
- **Logger estruturado:** substituir os `console.warn` dos clients por logger de verdade, com rate limit.
- **Cache stampede / single-flight (product-service):** requisições em cache frio vão todas ao banco; implementar single-flight + teste de concorrência.
- **Health do Redis (cart-service) com timeout por comando + circuit breaker** + teste de ping lento/pendente.

### Concorrência / atomicidade
- **setStock atômico (inventory):** guard (`quantity < reserved`) + upsert são separados (CHECK do banco é a rede atual). UPDATE condicional ou isolamento. Baixa (setStock é administrativo).
- **Corrida no cart (addItem/updateQuantity):** check-then-write não atômico + escrita e `EXPIRE` em comandos separados (janelas de corrida). MULTI/EXEC ou Lua + testes de concorrência. (PRs #33/#34.)

### Deploy
- **Índices MongoDB em produção** via script de migração/deploy (não auto-indexing do Mongoose).
- **Rate limit com store no Redis** compartilhado entre instâncias do auth ao escalar.

---

## FASE 10 — Resiliência avançada, jobs e qualidade

### Jobs / reconciliação

- **Retenção e minimização do inbox de webhooks (`payment-service`):** `webhook_events.payload` guarda o JSON íntegro do provedor, e `lastError`/`failureMessage` guardam texto arbitrário. Payload de gateway pode conter dados pessoais (nome, últimos dígitos, e-mail) e mensagens de erro podem carregar segredo. Definir campos permitidos, política de expiração e arquivamento. Tratar junto com a retenção da outbox. *(Item 3.2 da revisão do PR #47. A sanitização em escrita é critério de aceite dos Blocos 4 e 9, dentro da fase; aqui fica só a retenção.)*

- **Processor de reconciliação da saga:** o estado durável já existe (`idempotency_records` com orderId+status; `pending_compensations`). Falta o JOB, tratando cada caso sem liberar pedido válido:
  - `pending_compensations` aberta → reexecutar `release(orderId)` (idempotente) + marcar `resolvedAt`.
  - `idempotency_records` em `PROCESSING` → **bifurcar**: se o pedido existe, marcar `COMPLETED` (não liberar!); se não, `release` + `FAILED`.
  - `idempotency_records` `FAILED` → reexecutar `release(orderId)`.
  Tudo com retry/backoff, métricas e alerta.
- **Retenção/limpeza da outbox:** [ver também o item de inbox abaixo] `SENT`/`FAILED` crescem sem política; o payload guarda userId/total. Definir arquivamento/cleanup e minimizar campos.
- **Backoff/quarentena/redrive no relay da outbox (produtor):** o publish falho volta a `PENDING` e é retentado em intervalo fixo (sem backoff exponencial, sem quarentena de "poison" nem redrive) — um evento inpublicável causaria head-of-line blocking. Eventos são bem-formados (produtor próprio) → risco baixo hoje; necessário sob carga real. Enum `FAILED` reservado. (PR #43/#44.)
- **Limpeza do carrinho por versão/CAS:** hoje o checkout remove só os itens comprados por productId; um CAS por versão preservaria mudanças de quantidade. Exige versionamento no cart.

### Contratos / arquitetura
- **Contrato de topologia compartilhado:** EXCHANGE e routing keys duplicados em order (`events/topology.ts`) e notification (`config/topology.ts`). Pacote comum ou aceitar a duplicação.
- **Ciclo de vida acoplado a efeitos globais:** `start()`/estado do publisher rodam no import, com `process.exit` embutido e estado de módulo global. Separar construção/start/stop + injetar conexão/logger/exit.

### Qualidade de testes / CI
- **`inventory-service` com uma unica config de Jest:** unit e integração compartilham `jest.config.ts`, então a guarda de banco de teste se aplica a todos os testes, inclusive os que não tocam o banco. Funciona, mas acopla teste puro a configuração de infraestrutura. Separar em `jest.integration.config.ts` como nos demais serviços.
- **Velocidade dos testes (ts-jest):** recompila+type-checa cada arquivo por run (o build já faz o type-check). `isolatedModules: true` ou `@swc/jest`/`esbuild-jest` → 3–5× mais rápido. Aplicar em order/inventory/cart/product.
- **CI prover env de teste:** `.env.test` não é versionado (`JWT_SECRET` etc.); o pipeline precisa setar, senão os testes de autorização falham.
- **Teste de config do `redis.ts`** (fallback quando `REDIS_URL` ausente).
- **Teste de integração do `connectDatabase` (inventory):** `catch` sanitizado + `process.exit(1)`.
- **Fixar versão do MongoDB no `mongodb-memory-server` + cache no CI (product).**
- **Rodar `npm run verify` (build+test) no CI (product).**
- **Testes e2e com Supertest incl. 429 do rate limit** [herdada da Fase 2].
- **Teste de rollback quando a 2ª escrita da transação falha (order):** exige ponto de injeção de falha (a atomicidade vem do `$transaction`; o caminho "valida antes de escrever" já é testado).

---

## Refatoração transversal (→ Fase 7, pass de qualidade)


- **Alinhar `database.ts` do inventory ao padrão do order:** exit centralizado no `server.ts`, não na camada de banco.
- **Erros de domínio como classes/enums** em vez de strings (inventory, product, cart).
- **Estender o tipo `Request` do Express** com usuário autenticado, eliminando `(req as any).userId/userRole`.
- **DTO explícito `ProductWithAvailability`** para o retorno enriquecido do `findProductById`.
- **Normalizar base URL do `inventory.client`** (`new URL()` ou tratar barra final).
- **Mover helpers puros para `utils/` (product):** `parsePositiveInt`, `pickAllowedFields`.
- **Precisão monetária:** representar dinheiro em centavos (inteiro), consistente entre serviços (hoje float com arredondamento).

---

## Performance (→ carga real, Fase 7/10)

- **GET /cart faz N chamadas ao product (sem batch):** criar endpoint batch (`GET /products?ids=...`) e reduzir a uma chamada.

---

## Backlog de features (pós-MVP)

- **Login social via OAuth2 (Google):** [herdada da Fase 2] — sem fase definida.
