# Dívida Técnica e Pendências — Projeto E-Commerce

Este documento registra decisões conscientes de adiamento tomadas durante os code reviews. Cada item foi avaliado, discutido e deliberadamente agendado para o momento arquiteturalmente correto, em vez de corrigido na hora. Não são esquecimentos — são trade-offs documentados.

Organizado por DESTINO. Toda dívida pendente tem um destino de correção explícito. Dívidas pagas são removidas deste arquivo — o histórico permanece nos PRs.

Última atualização: Fase 4, Bloco 4 concluído (fundamento RabbitMQ).

---

## FASE 4 — ORDER-SERVICE (Blocos 5–8, em andamento)

### Bloco 8 — Eventos assincronos (order.created / order.status_changed)

O 8a publica eventos de forma simples (publish-apos-commit). As fragilidades
abaixo sao conhecidas e aceitas para o 8a; o destino de cada uma esta marcado.

- **[8b-1 PAGO] Entrega at-most-once resolvida com outbox transacional (at-least-once):** o publish acontece DEPOIS do commit, fora da transacao. Se o processo cair entre o commit e o publish — ou o publish falhar — o evento se perde. Destino 8b: outbox transacional (grava o evento na MESMA transacao do pedido; um worker publica e marca como enviado) -> at-least-once.
- **[8b-1 PAGO] Publisher sem auto-reconnect resolvido (o relay reconecta a cada ciclo):** se a conexao com o broker cair APOS o boot, os handles zeram e todo evento e descartado ate reiniciar o order-service. Destino 8b/Fase 7: reconexao automatica com backoff.
- **[8b-2] Consumer nao-idempotente:** handleEvent processa toda mensagem sem deduplicar. Ok no 8a (at-most-once nao reentrega), mas o at-least-once do 8b exige dedup por eventId (o campo ja viaja no payload).
- **[Fase 10] Contrato de topologia duplicado:** EXCHANGE e routing keys estao repetidos em order-service (events/topology.ts) e notification-service (config/topology.ts). Sem pacote compartilhado, ha risco de divergencia. Destino: extrair pacote comum de contratos OU aceitar a duplicacao documentada.
- **[8b-2] Sem dead-letter queue:** payload invalido e descartado com nack(false,false); nao ha DLQ para inspecao/reprocessamento. Destino: configurar DLX/DLQ.
- **[Fase 7] notification-service fora do docker-compose:** roda so via npm run dev; falta Dockerfile, entrada no compose, healthcheck e observabilidade. Destino: containerizar antes do deploy.
- **[Fase 7] Limite de tamanho de mensagem no consumer:** o consumer faz toString()+JSON.parse sem checar msg.content.length; mensagem gigante consome CPU/memoria. O exchange e interno (so o order-service publica), risco baixo agora. Destino: cap de bytes + ACL/limite no broker (review PR #42, 3.2).
- **[Fase 10] Ciclo de vida acoplado a efeitos globais:** start() do notification e o estado do publisher rodam no import, com process.exit embutido e estado de modulo global; dificulta testar ciclo de vida/reconexao. Destino: separar construcao/start/stop e injetar conexao/logger/exit (review PR #42, 5.2).

- **[EXCECAO DE SEGURANCA ACEITA — Fase 7] Token de servico do order-service (role ADMIN):** o order assina um token ADMIN com o segredo compartilhado para chamar reserve/release do inventory. NAO e "divida paga" — e mitigacao aceita. O segredo compartilhado JA permite forjar qualquer token, entao o order usar ADMIN nao amplia o raio de ataque existente. Correcao real: identidade por servico (chaves assimetricas/mTLS) + issuer/audience/scopes (ex.: inventory:reserve). Fase 7. Levantado no review do PR #41.
- **[Fase 10] Processor de reconciliacao:** o estado DURAVEL da saga ja existe (`idempotency_records` com orderId+status, criado ANTES das reservas; `pending_compensations` para releases falhos). Falta o JOB, que deve tratar cada caso sem liberar pedido valido:
  - `pending_compensations` aberta (resolvedAt null): reexecutar `release(orderId)` (idempotente) e marcar resolvedAt.
  - `idempotency_records` preso em PROCESSING: BIFURCAR — se o pedido (orderId) EXISTE, apenas marcar COMPLETED (nao liberar!); se NAO existe, `release(orderId)` + marcar FAILED. (Com order.create+COMPLETED atomicos, PROCESSING-com-pedido nao deveria ocorrer, mas o job trata defensivamente.)
  - `idempotency_records` FAILED: reexecutar `release(orderId)` idempotente (cobre o caso em que ate a gravacao da pendencia falhou).
  Tudo com retry/backoff, metricas e alerta.
- **[Fase 7] Limpeza do carrinho por versao/CAS:** hoje o checkout remove SO os itens comprados por productId (item-level — produtos novos adicionados durante o checkout sobrevivem). Um CAS por versao preservaria tambem mudancas de QUANTIDADE. Exige versionamento no cart-service.

- **Reconciliacao de compensacao da saga (createOrder):** se o `release` de compensacao falhar, o pedido nao e criado mas as reservas podem ficar presas (a falha e logada e o erro original propagado — decisao 2A). Como o `release` e idempotente, um job de limpeza/retry (ou reprocessamento por evento) reconcilia. Destino: Fase 10 (resiliencia/jobs). Tambem: falha ao limpar o carrinho apos o pedido criado e apenas logada (efeito menor).

- **Teste de rollback quando a 2a escrita da transacao falha:** provar que, se a gravacao do historico falhar apos o update do status, nada persiste. Forcar essa falha hoje exigiria constraint artificial (app e banco concordam, nao ha brecha) ou mock intrusivo do proxy `tx` do Prisma. A atomicidade vem da semantica do `$transaction`, e o caminho "valida antes de escrever" ja e testado. Destino: rodada de robustez de testes (Fase 10) ou quando o servico ganhar ponto de injecao de falha. Levantado no review do PR #38.
- **[PAGO — 7b] Origem autenticada de `changedBy`:** o servico valida formato (nao-vazio, <=128) e documenta que a identidade deve vir de contexto autenticado, mas hoje e parametro do chamador. A rota do Bloco 7 passara `req.userId` do JWT. Destino: Bloco 7.

- **[PAGO — 7b] Invariante `total = soma(subtotais)` + criacao transacional do pedido:** o CHECK garante `subtotal = unitPrice*quantity` por item, mas a soma agregada no `orders.total` exige logica transacional. Calcular no servidor e persistir pedido+itens numa unica transacao. Destino: order-service (Bloco 7). Levantado no review do PR #36.

- **[EXCECAO DE SEGURANCA ACEITA — Fase 7] Authz por dono/servico da reserva:** a posse ESTRUTURAL foi paga no 7a (reservas amarradas ao `orderId`; `release(orderId)` so toca o que e do pedido). Porem a AUTORIZACAO nao esta completa: hoje qualquer ADMIN/SELLER autenticado libera qualquer `orderId`, e qualquer papel logado reserva com `orderId` arbitrario. Isso NAO e "divida paga" — e uma exposicao conhecida e deliberadamente aceita para este estagio (sem gateway/identidade de servico). Resolucao: autenticacao servico-a-servico (token interno/mTLS) + vincular `orderId` a claims confiaveis. Destino: Fase 7. O 7b usara token de servico como ponte.
- **[Politica documentada] Drain de `reserved` orfao na migracao do 7a:** a migration zerou `inventory.reserved` onde nao havia linha de `reservation` (o modelo antigo mantinha o contador sem reserva rastreavel). Seguro aqui porque nao ha pedidos reais. Num sistema com dados reais, a estrategia teria que ser backfill (criar reservas a partir do estado antigo), nao drain.
- **Mensageria do order-service (Bloco 8) -- parcialmente paga no 8a:** PAGO no 8a: (a) guard de contrato endurecido no consumer (rejeita schema incorreto, nao so shape minimo); (b) testes automatizados -- publisher (RABBITMQ_URL ausente, no-op sem canal, publish persistente + waitForConfirms, esgotamento de retry, close idempotente) e consumer (evento valido, JSON malformado, schema incorreto, roteamento por tipo, sanitize); (c) encerramento gracioso SIGINT/SIGTERM no order-service e no notification-service. PAGO no 8b-1: at-least-once via outbox + auto-reconnect (relay) + evento nunca abandonado. PENDENTE -> 8b-2: dead-letter queue, classificacao transitorio/permanente + backoff/quarentena, e dedup no consumidor. Levantado nos reviews do PR #35; reconciliado com o split 8a/8b.

---

## FASE 7 — API Gateway e Segurança

- **JWT hardening:** `jwt.verify` com `algorithms`, `issuer`, `audience` explícitos + validar shape do payload antes de confiar no `role`. Aplicar em auth, product, inventory e cart de forma consistente.
- **403 não vazar roles:** retornar 403 genérico, logar `required`/`current` apenas server-side. Hoje os serviços retornam `{ required, current }` no corpo.
- **Autenticação serviço-a-serviço:** token interno/mTLS entre serviços (hoje product→inventory e cart→product consultam endpoints públicos). Modelar identidade de serviço.
- **Separar /health (liveness) de /ready (readiness com check de DB):** quando houver health probes de orquestração consumindo.
- **Paginação no /admin/users do auth-service:** [herdada da Fase 2] quando o auth-service for revisitado.
- **Portas de dev publicadas em 0.0.0.0:** postgres/mongo/redis publicam em todas as interfaces no docker-compose. O rabbitmq já foi restrito a `127.0.0.1` (PR #35); aplicar o mesmo aos demais e usar credenciais fortes por ambiente. Dev-only, baixa.

---

## FASE 7/10 — Infra, Resiliência, Deploy

### Resiliência
- **Timeout configurável no inventory.client + circuit breaker/retry** para falhas transitórias.
- **Validar config no boot do product-service:** garantir `INVENTORY_SERVICE_URL` presente, condicionar o fallback localhost ao ambiente de dev.
- **Logger estruturado:** substituir os `console.warn` do inventory.client (e dos clients do cart) por logger de verdade, com rate limit para não gerar ruído se um serviço ficar instável.
- **Cache stampede / single-flight (product-service):** hoje múltiplas requisições em cache frio vão todas ao banco simultaneamente. Implementar single-flight/lock; quando existir, testar concorrência em cache frio (não testado agora por ser comportamento que vai mudar).
- **Health check do Redis sem timeout (cart-service):** o `/health` do cart faz `getRedisClient().ping()` sem timeout por comando; sob Redis/rede lentos o endpoint pode demorar. Falta também teste de ping pendente/lento. Consolidar junto do hardening de Redis (timeout estrito + circuit breaker).

### Concorrência / atomicidade
- **setStock atômico (inventory-service):** o guard (`quantity < reserved`) e o upsert são operações separadas — há fresta sob concorrência. A constraint CHECK do banco é a rede de segurança atual. Tornar atômico com UPDATE condicional ou isolamento. Risco baixo: setStock é administrativo, não concorrente como reserve.
- **Corrida na validação de estoque do cart (addItem/updateQuantity):** o check-then-write (`HGET/HEXISTS` → `fetchProduct` → `HINCRBY/HSET`) não é atômico; duas escritas concorrentes podem furar o limite de estoque no carrinho. Impacto soft: o carrinho não é a reserva real (order-service é a autoridade). Resolver com MULTI/EXEC ou script Lua + testes de concorrência. Levantado no review do PR #34.
- **Atomicidade escrita+TTL e corrida no PATCH (cart-service):** addItem/updateQuantity fazem escrita e EXPIRE em comandos separados (EXPIRE falha → item sem TTL); e updateQuantity faz HEXISTS e depois HSET (janela de corrida: item removido entre os dois e recriado pelo HSET). Resolver com MULTI/EXEC ou Lua + testes de concorrência. Levantado no review do PR #33.

### Deploy / infra
- **Criação de índices MongoDB em produção:** via script de migração ou passo de deploy documentado, em vez de auto-indexing do Mongoose.
- **Rate limit com store no Redis:** compartilhado entre instâncias do auth-service ao escalar horizontalmente.

### CI / robustez de testes (Fase 10)

- **Velocidade dos testes (ts-jest):** o `ts-jest` recompila E type-checa cada arquivo a cada run, sem cache quente -- a suite unit chega a ~50s sob contencao de maquina. O type-check no jest e redundante (o build com `tsc --noEmit` ja faz a checagem completa). Ganho barato: `isolatedModules: true` no ts-jest (transpila por arquivo, sem type-check cruzado) OU trocar por `@swc/jest`/`esbuild-jest` (transpile puro) -- tipicamente 3-5x mais rapido. Aplicar em order, inventory, cart e product num PR proprio de DX/CI. Fase 10.
- **CI precisa prover as env de teste não versionadas:** o `.env.test` do inventory-service é ignorado pelo git (DATABASE_URL, INVENTORY_PORT, JWT_SECRET de teste). O pipeline terá que setar essas variáveis — em especial `JWT_SECRET` — senão os testes de autorização falham. Vale para qualquer serviço com `.env.test` local.
- **Teste de config do `redis.ts` (REDIS_URL ausente):** provar que `getRedisClient` usa o fallback quando `REDIS_URL` não está definida. Exige mockar o construtor do ioredis. Baixo valor/risco.
- **Teste de integração do `connectDatabase` (inventory-service):** provar que o `catch` chama só a saída sanitizada no `console.error` e dispara `process.exit(1)`. A lógica de segurança já está coberta pela função pura `sanitizeConnectionError` (PR #24); este teste cobre só o encadeamento. Fazer quando o `connectDatabase` ganhar lógica nova (ex.: retry).
- **Fixar versão do MongoDB no `mongodb-memory-server` + cache do binário no CI (product-service):** fixar a versão para reprodutibilidade entre máquinas e configurar cache. Levantado no review do PR #25.
- **Rodar `npm run verify` (build + test) no CI do product-service:** o script já existe localmente; falta automatizá-lo no pipeline. Levantado no review do PR #25.
- **Testes de integração end-to-end com Supertest, incluindo o 429 do rate limit:** [herdada da Fase 2].

---

## REFATORAÇÃO TRANSVERSAL — destino: pass de refatoração de qualidade junto ao hardening da Fase 7

- **Alinhar `database.ts` do inventory ao padrao do order:** hoje o `connectDatabase` do inventory chama `process.exit` na camada de banco (o order passou a lancar erro sanitizado e centralizar o exit no `server.ts`). Baixa.
- **Erros de domínio como classes/enums** em vez de strings (`error.message === 'INSUFFICIENT_STOCK'` / `'ITEM_NAO_ENCONTRADO'`). Afeta inventory, product e cart.
- **Estender o tipo Request do Express** com interface de usuário autenticado, eliminando `(req as any).userId/userRole` em todos os serviços.
- **DTO explícito `ProductWithAvailability`** para o retorno enriquecido do findProductById (hoje é objeto inline sem tipo nomeado).
- **Normalizar base URL** do inventory.client (`new URL()` ou tratar barra final).
- **Mover helpers puros para módulo `utils/` (product-service):** `parsePositiveInt` e `pickAllowedFields` foram exportados para permitir teste unitário, aumentando a superfície pública. Mover para `utils/` dedicado mantém o teste sem expor helpers internos. Levantado no review do PR #25.
- **Precisão monetária (cart-service):** subtotal/total usam `number` (float), com arredondamento para 2 casas como paliativo. Solução correta: representar dinheiro em centavos (inteiro) de forma consistente entre serviços.

---

## PERFORMANCE — destino: quando houver carga real (Fase 7/10)

- **GET /cart faz N chamadas ao product-service (sem batch):** o enriquecimento chama `fetchProduct` por item (em paralelo, mas N requisições). Para carrinhos grandes, criar endpoint batch no product-service (ex.: `GET /products?ids=...`) e reduzir a uma chamada.

---

## BACKLOG DE FEATURES (pós-MVP)

- **Login social via OAuth2 com Google:** [herdada da Fase 2] feature de produto, sem fase definida — retomar no backlog pós-MVP.


### Bloco 8b-1 — estado das dividas apos review do PR #43

Pago e verificado no 8b-1:
- Entrega at-least-once via outbox transacional (evento no mesmo commit do pedido).
- Auto-reconnect do publisher (o relay reconecta a cada ciclo).
- Falha de publicacao NAO abandona o evento (mantem PENDING; retry pelo intervalo do relay).
- Shutdown aguarda o ciclo ativo do relay; start idempotente; ordem deterministica (createdAt, id).

Aberto, com destino:
- **[8b-2 PAGO] Consumer idempotente (dedup por eventId):** a janela publish->markSent permite reentrega (natural do at-least-once). Hoje o consumer e stub que so loga (duplicata = log repetido, inofensivo). A dedup por eventId e PRE-REQUISITO OBRIGATORIO antes de o consumer executar qualquer efeito real (e-mail/push/etc.). [review PR #43, 4.2]
- **[8b-2] Classificacao transitorio/permanente + backoff + quarentena/redrive:** publish falho hoje volta a PENDING e retenta pelo poll (sem backoff exponencial); nao ha quarentena de evento "poison" nem mecanismo de redrive. O enum FAILED existe reservado para isso. [review PR #43, 4.1]
- **[8b-2 PAGO] Dead-letter queue** no consumidor. [review PR #43]
- **[Fase 7] Claim atomico entre instancias do relay (FOR UPDATE SKIP LOCKED / lease):** hoje roda 1 instancia; com multiplas, dois relays publicariam o mesmo evento e as marcacoes de estado poderiam se sobrepor. [review PR #43, 4.3]
- **[Fase 10] Retencao/limpeza da outbox:** SENT/FAILED crescem sem politica e o payload guarda userId/total; definir arquivamento/cleanup e minimizar campos. [review PR #43, 3.1]


### Bloco 8b-2 — estado (consumer confiavel)

Pago e verificado (e2e: mesmo eventId 2x -> processado 1x; payload invalido -> DLQ):
- Consumer idempotente por eventId (Redis SET NX + TTL, claim-first).
- eventId obrigatorio no contrato do consumer.
- Dead-letter queue (DLX fanout -> notifications.orders.dlq): mensagem envenenada vai pra DLQ em vez de sumir.

Aberto, com destino:
- **[follow-up produtor] Classificacao transitorio/permanente + backoff + quarentena/redrive** do relay (head-of-line blocking, achado 4.2 do review do PR #43): hoje o publish falho retenta em intervalo fixo, sem backoff/quarentena.
- **[Fase 7] Migracao de args de fila duravel:** args sao imutaveis no RabbitMQ; adicionar a DLX exigiu deletar a fila antiga (one-time manual). Padronizar via policy/quorum ou script de migracao no deploy.
- **Limite conhecido (semantica 2a):** claim-first tem a janela "claim ok -> crash antes de processar" (efeito perdido). Aceitavel com consumer stub; efeito real transacional seria outra evolucao.


### Bloco 8b-2 — correcoes pos-review (PR #44)

Corrigido:
- **Perda apos claim:** se handleEvent falha DEPOIS do claim, o claim e LIBERADO (DEL) e a mensagem faz requeue -> a reentrega reprocessa. Fases separadas (parse/claim/processa/recupera) em handleDelivery, com teste de todos os ramos.
- **Hot loop no requeue:** atraso (REQUEUE_DELAY_MS) antes do nack(requeue) durante indisponibilidade do store.
- **TTL de dedup** resolvido em runtime e validado (min 1min / max 7d). A garantia e TEMPORAL (janela do TTL), nao efeito unico eterno.
- **eventId** com cap de tamanho (128) no parse.
- **ioredis** alinhado ao cart (^5) + engines.node >=20; .env.example com newlines reais.

Limite remanescente (documentado, aceito com consumer stub):
- **Janela de crash entre o claim e o ack:** se o processo cair nesse meio, a reentrega trata como duplicata sem ter processado. Inerente ao at-least-once sem efeito transacional; para efeito real (e-mail/push) seria necessario efeito+claim atomicos (outbox no consumidor) -> evolucao futura.


### Bloco 8b-2 — correcoes pos-review (2a rodada, PR #44)

- **Falha no release nao e mais engolida:** se o processamento falha e o claim NAO consegue ser liberado, a mensagem vai pra DLQ (preservada) em vez de requeue (que viraria duplicata-ack = perda).
- **Claim com token de propriedade + compare-and-delete (Lua):** releaseEvent so apaga o claim se ainda for deste consumo (nao apaga claim readquirido por outra instancia apos o TTL). Fecha o risco multi-instancia do DEL.
- **Ping no Redis no boot** (fail-fast); REQUEUE_DELAY_MS com minimo (>=50); eventId canonico (rejeita espaco periferico); executeAction testado (ack / nack-dlq / requeue com atraso).

Limite remanescente (documentado): janela de crash do PROCESSO entre o claim e o ack; efeito real futuro exigiria efeito+claim atomicos (outbox no consumidor).
