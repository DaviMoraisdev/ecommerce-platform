# Dívida Técnica e Pendências — Projeto E-Commerce

Este documento registra decisões conscientes de adiamento tomadas durante os code reviews. Cada item foi avaliado, discutido e deliberadamente agendado para o momento arquiteturalmente correto, em vez de corrigido na hora. Não são esquecimentos — são trade-offs documentados.

Organizado por DESTINO. Toda dívida pendente tem um destino de correção explícito. Dívidas pagas são removidas deste arquivo — o histórico permanece nos PRs.

Última atualização: Fase 4, Bloco 4 concluído (fundamento RabbitMQ).

---

## FASE 4 — ORDER-SERVICE (Blocos 5–8, em andamento)

- **Teste de rollback quando a 2a escrita da transacao falha:** provar que, se a gravacao do historico falhar apos o update do status, nada persiste. Forcar essa falha hoje exigiria constraint artificial (app e banco concordam, nao ha brecha) ou mock intrusivo do proxy `tx` do Prisma. A atomicidade vem da semantica do `$transaction`, e o caminho "valida antes de escrever" ja e testado. Destino: rodada de robustez de testes (Fase 10) ou quando o servico ganhar ponto de injecao de falha. Levantado no review do PR #38.
- **Origem autenticada de `changedBy`:** o servico valida formato (nao-vazio, <=128) e documenta que a identidade deve vir de contexto autenticado, mas hoje e parametro do chamador. A rota do Bloco 7 passara `req.userId` do JWT. Destino: Bloco 7.

- **Invariante `total = soma(subtotais)` + criacao transacional do pedido:** o CHECK garante `subtotal = unitPrice*quantity` por item, mas a soma agregada no `orders.total` exige logica transacional. Calcular no servidor e persistir pedido+itens numa unica transacao. Destino: order-service (Bloco 7). Levantado no review do PR #36.

- **[EXCECAO DE SEGURANCA ACEITA — Fase 7] Authz por dono/servico da reserva:** a posse ESTRUTURAL foi paga no 7a (reservas amarradas ao `orderId`; `release(orderId)` so toca o que e do pedido). Porem a AUTORIZACAO nao esta completa: hoje qualquer ADMIN/SELLER autenticado libera qualquer `orderId`, e qualquer papel logado reserva com `orderId` arbitrario. Isso NAO e "divida paga" — e uma exposicao conhecida e deliberadamente aceita para este estagio (sem gateway/identidade de servico). Resolucao: autenticacao servico-a-servico (token interno/mTLS) + vincular `orderId` a claims confiaveis. Destino: Fase 7. O 7b usara token de servico como ponte.
- **[Politica documentada] Drain de `reserved` orfao na migracao do 7a:** a migration zerou `inventory.reserved` onde nao havia linha de `reservation` (o modelo antigo mantinha o contador sem reserva rastreavel). Seguro aqui porque nao ha pedidos reais. Num sistema com dados reais, a estrategia teria que ser backfill (criar reservas a partir do estado antigo), nao drain.
- **Mensageria do order-service (Bloco 8):** o demo RabbitMQ valida só sintaxe (JSON) + shape mínimo. Ao reutilizar o padrão no order-service, exigir: schema/contrato explícito dos eventos (`type/orderId/total/at`), testes automatizados (config ausente, retry/esgotamento, evento válido, JSON malformado, schema incorreto, ack/nack, publisher sem consumer), dead-letter queue para inválidos, encerramento gracioso (`try/finally` + SIGINT/SIGTERM) e retry que distingue falha transitória de permanente. Levantado nos reviews do PR #35.

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
