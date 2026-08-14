# Dívida Técnica e Pendências — Projeto E-Commerce

Registro de decisões conscientes de adiamento, avaliadas nos code reviews e agendadas para o momento arquiteturalmente correto. Não são esquecimentos — são trade-offs documentados.

Organizado por **destino**. Só pendências: dívidas pagas são removidas daqui (o histórico permanece nos PRs).

Última atualização: **Fase 5 em andamento** (Blocos 1 e 2 concluídos).

---

## Limites conhecidos e aceitos (com gatilho de correção)

Trade-offs aceitos cujo **gatilho** de correção está explícito — não são trabalho agendado por data.

- **Janela de crash claim-first (notification-service):** se o processo cair entre o `claim` e o `ack`, a reentrega é tratada como duplicata sem processar o efeito. Inerente ao at-least-once sem efeito transacional. **Gatilho:** quando o consumer deixar de ser stub e ganhar efeito real (e-mail/push), é obrigatório adotar efeito+claim atômicos (outbox no consumidor). Destino: **evolução do notification-service (Fase 6+/pós-MVP)**.
- **Premissa de 2 casas decimais (payment-service):** `src/domain/money.ts` assume 100 centavos por unidade monetária. Verdadeiro para BRL, falso para JPY (0 casas) e dinares (3). Seguro enquanto `Currency = 'BRL'`. **Gatilho:** suporte a segunda moeda.
- **Porta de pagamento sem passo de autenticação adicional (3DS/SCA):** A porta PaymentProvider nao expressa autenticacao adicional — `ChargeResult` não tem campo de próxima ação (redirect, desafio). O fluxo assume cartão tokenizado e captura automática. **Gatilho:** exigência de 3D Secure, SCA (Europa) ou qualquer método que precise de interação extra do cliente. Custo: variante nova em `ChargeResult` e ajuste em todos os consumidores.

---


## Decisões e procedimentos documentados (sem trabalho pendente)

Registros de decisão — não há tarefa a fazer, apenas contexto para o futuro.

- **`diagnostics: false` no Jest e DELIBERADO (todos os serviços):** o Jest transpila sem type-check, o que deixou a suíte do payment ~3,4× mais rápida (26,1s → 7,8s). **Não reativar.** O type-check não desapareceu: saiu do Jest e virou passo próprio. Semântica atual dos comandos — `npm test` = `typecheck + test:fast` (**padrão seguro**, ~5,3s); `npm run test:fast` = só o Jest, sem type-check (loop interno, uso consciente); `npm run verify` = `test + build`; `npm run verify:integration` = `typecheck + test:integration`. Comprovado nas duas direções: com erro de tipo injetado, `npm test` falha e `test:fast` passa.
- **Duplicacao deliberada de tooling de teste entre servicos:** a guarda de banco (`tests/helpers/testDbGuard.ts`), o script de migration (`scripts/migrate-test-db.ts`) e os testes de ambos existem em **cópia idêntica** em payment, order e inventory. Dentro de cada serviço a política é única — migration e testes importam a mesma guarda. Entre serviços, é cópia. **Aceito**, pela mesma razão do `database-error.ts`: duplicar *ferramenta* entre serviços é o preço da independência, e o que é dívida é duplicar **contrato** (como `topology.ts`), onde divergência silenciosa vira incidente. Pacote compartilhado exigiria build e versionamento de monorepo — Fase 7. **Custo aceito:** correção no invólucro precisa ser aplicada em três lugares.
- **Drain de `reserved` órfão na migração do 7a:** a migration zerou `inventory.reserved` sem `reservation` (modelo antigo). Seguro por não haver pedidos reais; **com dados reais a estratégia seria backfill, não drain**.
- **Redrive da DLQ respeita o TTL do claim:** um redrive `DLQ -> fila principal` antes do TTL expirar é visto como duplicata (ack sem reprocessar). **Procedimento:** redrive só após o TTL, ou limpar `notif:evt:<eventId>` antes.

---

## Exceções de segurança aceitas (→ Fase 7)

- **Token de serviço ADMIN (order → inventory):** o order assina um token ADMIN com o segredo compartilhado para chamar `reserve/release`. Mitigação aceita, não dívida paga: o segredo compartilhado já permite forjar qualquer token, então usar ADMIN não amplia o raio de ataque. Correção real: identidade por serviço (mTLS/chaves assimétricas) + issuer/audience/scopes (ex.: `inventory:reserve`). (PR #41.)
- **Authz por dono/serviço da reserva:** a posse **estrutural** foi paga no 7a (reservas amarradas ao `orderId`; `release(orderId)` só toca o que é do pedido). A **autorização** ainda é incompleta: qualquer ADMIN/SELLER libera qualquer `orderId`; qualquer papel logado reserva com `orderId` arbitrário. Exposição conhecida e aceita para este estágio. Correção: auth serviço-a-serviço + `orderId` vindo de claims confiáveis.

---

## FASE 5 — fechar no Bloco 10 (dentro desta fase)




## FASE 5 — critérios herdados entre blocos


Compromissos assumidos em um bloco que **outro bloco** desta fase tem de cumprir. Antes
viviam apenas em conversa e em descrição de PR — inclusive um controle de segurança.
Mesmo ciclo das dívidas: removidos daqui quando entregues.


### Bloco 3 — `POST /payments`
- **A fábrica de provedor deve RECUSAR `fake` fora de dev/teste.** `PAYMENT_PROVIDER=fake` em produção significaria que qualquer token mágico aprova uma cobrança — pagamento sempre bem-sucedido, sem dinheiro nenhum. Falhar no boot, com teste. **É controle de segurança, não conveniência.**
- **Shutdown gracioso:** `disconnectDatabase()` em `SIGTERM`/`SIGINT`. Hoje cada respawn do `ts-node-dev` pode deixar conexão pendurada.
- **`PAYMENT_PROVIDER` e `PAYMENT_WEBHOOK_SECRET`** no config, com valor **vazio** no `.env.example` (nunca um segredo que funcione).
- **Reintroduzir `getPrisma`** no mesmo commit do primeiro consumidor — removido por não ter uso.


### Bloco 4 — Webhook e inbox
- **Política fail-closed do `providerCreatedAt` nulo:** evento sem timestamp de origem não altera estado de pagamento; vai para o inbox como `IGNORED`. Já registrado como `it.todo` na suíte de integração do payment.
- **`express.json()` NÃO pode alcançar a rota de webhook** — a assinatura HMAC é sobre os bytes exatos. Montar a rota com `express.raw()` antes do parser global.
- **Cap de tamanho do `rawBody`** na rota (`express.raw({ limit })`).
- **Sanitização em escrita** do payload do inbox e das mensagens de erro.


### Bloco 5 — Integração payment ↔ order
- **Primeiro consumer do order-service:** idempotência por `eventId` + DLQ, no padrão do notification-service. Hoje o order só produz eventos.


### Bloco 6 — Reconciliação e expiração
- **Definir TTL e limite de tentativas da janela de retentativa.** O estoque fica reservado durante toda a janela; é decisão de negócio com efeito em disponibilidade. Referência inicial: 15 min e 3 tentativas.


### Bloco 9 — Stripe e hardening
- **Rodar a suíte de contrato (`payment-provider.contract.ts`) contra a Stripe.** É o que valida a abstração da porta.
- **Sanitização de log**, rate limit no webhook, escopo PCI documentado.


### Bloco 10 — Fechamento
- **Finalizar o README do payment-service e revisar o README da raiz.** Ambos foram *criados/marcados* no PR de manutenção pré-Bloco 3, com o estado daquele momento. O que falta e a revisão final: descrever os endpoints, o fluxo completo e trocar o marcador 🟡 por ✅ quando a fase fechar.
- **PDF de revisão da fase** em `docs/phase-reviews/phase-05.pdf`.



## FASE 7 — Gateway, Segurança e Infra

### Segurança
- **JWT hardening:** `jwt.verify` com `algorithms`/`issuer`/`audience` explícitos + validar shape do payload antes de confiar no `role`. Aplicar em auth, product, inventory e cart. **Nota:** a forca do segredo ja foi tratada — cart, order, inventory e product recusam placeholder conhecido em qualquer ambiente e exigem 32+ caracteres em producao. O que resta nesta entrada e outra coisa: `algorithms`/`issuer`/`audience` explicitos no `jwt.verify` e validacao do shape do payload antes de confiar no `role`.
- **`auth-service` sem validacao de ambiente no boot:** e o unico dos cinco que usam JWT sem modulo de config — le `process.env.JWT_SECRET as string` direto em `src/utils/jwt.ts`, sem checar presenca, placeholder ou tamanho. Com a variavel ausente, o `as string` entrega `undefined` ao `jwt.sign`, que falha em tempo de requisicao em vez de no boot. Aplicar a mesma regra dos outros quatro. (Descoberto ao tratar o achado de placeholder no PR de manutencao.)
- **403 genérico:** não vazar `required`/`current` no corpo (hoje alguns serviços retornam). Logar só server-side.
- **Autenticação serviço-a-serviço:** token interno/mTLS entre serviços (product→inventory, cart→product, order→inventory). Modelar identidade de serviço.
- **Separar `/health` (liveness) de `/ready` (readiness com check de DB):** quando houver health probes de orquestração.
- **Paginação no `/admin/users` (auth-service):** [herdada da Fase 2].
- **Portas de dev em 0.0.0.0:** postgres/mongo/redis publicam em todas as interfaces (rabbitmq já restrito a 127.0.0.1). Restringir + credenciais fortes por ambiente. Dev-only, baixa.

### Infra / containerização
- **payment-service no docker-compose:** nasceu fora do compose (só `npm run dev`), mesmo estado do notification-service. Dockerfile, entrada no compose e healthcheck. Tratar junto com o item do notification-service, abaixo.
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
- **Retenção/limpeza da outbox:** (ver o item de retenção do inbox, acima) `SENT`/`FAILED` crescem sem política; o payload guarda userId/total. Definir arquivamento/cleanup e minimizar campos.
- **Backoff/quarentena/redrive no relay da outbox (produtor):** o publish falho volta a `PENDING` e é retentado em intervalo fixo (sem backoff exponencial, sem quarentena de "poison" nem redrive) — um evento inpublicável causaria head-of-line blocking. Eventos são bem-formados (produtor próprio) → risco baixo hoje; necessário sob carga real. Enum `FAILED` reservado. (PR #43/#44.)
- **Limpeza do carrinho por versão/CAS:** hoje o checkout remove só os itens comprados por productId; um CAS por versão preservaria mudanças de quantidade. Exige versionamento no cart.

### Contratos / arquitetura
- **Contrato de topologia compartilhado:** EXCHANGE e routing keys duplicados em order (`events/topology.ts`) e notification (`config/topology.ts`). Pacote comum ou aceitar a duplicação.
- **Ciclo de vida acoplado a efeitos globais:** `start()`/estado do publisher rodam no import, com `process.exit` embutido e estado de módulo global. Separar construção/start/stop + injetar conexão/logger/exit.

### Qualidade de testes / CI
- **CI prover env de teste:** `.env.test` não é versionado (`JWT_SECRET` etc.); o pipeline precisa setar, senão os testes de autorização falham. **O pipeline deve rodar `npm run verify`** (inclui type-check e build) **e `npm run verify:integration`** onde houver suíte separada — `npm test` sozinho não cobre build nem integração.
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
- **Precisão monetária:** representar dinheiro em centavos (inteiro), consistente entre serviços (hoje float com arredondamento em cart, product e order). **O payment-service JA usa centavos inteiros** (`src/domain/money.ts`) — não é alvo desta refatoração.

---

## Performance (→ carga real, Fase 7/10)

- **GET /cart faz N chamadas ao product (sem batch):** criar endpoint batch (`GET /products?ids=...`) e reduzir a uma chamada.

---

## Backlog de features (pós-MVP)

- **Login social via OAuth2 (Google):** [herdada da Fase 2] — sem fase definida.
