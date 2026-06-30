# Dívida Técnica e Pendências — Projeto E-Commerce

Este documento registra decisões conscientes de adiamento tomadas durante os code reviews.
Cada item foi avaliado, discutido e deliberadamente agendado para o momento arquiteturalmente
correto, em vez de corrigido na hora. Não são esquecimentos — são trade-offs documentados.

Organizado por DESTINO (onde será resolvido). Atualizado ao final de cada bloco.

Última atualização: Fase 3, Bloco 8b concluído (PR #25).

---

## BLOCO 8 (Testes da Fase 3) — bloco dedicado de testes

Legenda: ✅ concluído · (sem marca) pendente · sufixo (8a/8b/8c) indica o sub-bloco.

### product-service (Bloco 8b — CONCLUÍDO, PR #25)
- ✅ POST /products com token ADMIN e SELLER (201) (8b — product.create)
- ✅ POST /products sem token → 401 (8b — product.create)
- ✅ POST /products com BUYER → 403 (8b — product.create)
- ✅ Criar/atualizar com preço negativo → 400 (8b — product.create / product.update-delete)
- ✅ Soft delete: produto some da listagem E do detalhe (GET /:id) (8b — product.update-delete)
- ✅ Update não pode alterar `active` (8b — product.update-delete, + unitário pickAllowedFields)
- ✅ ID inválido → 400; produto ausente → 404 (8b — product.update-delete)
- ✅ Paginação: default, page/limit custom, limit>50, page/limit inválidos (8b — product.list)
- ✅ Filtro por categoria; busca por texto; search vazia/muito longa (8b — product.list)
- ✅ Formato da resposta paginada (data, page, limit, total, totalPages) (8b — product.list)
- ✅ Update/Delete com SELLER → 200 (8b — product.update-delete, correção review PR #25)
- ✅ authMiddleware rejeita token malformado, expirado e com segredo errado → 401 (8b — auth.middleware, correção review PR #25)
- ✅ GET /health responde (8b — health, correção review PR #25)

### inventory-service (Bloco 8a — CONCLUÍDO, exceto itens de camada HTTP → 8c)
- ✅ /health responde (8a — suíte estrutura)
- ✅ Startup falha sem DATABASE_URL (8a — suíte env)
- ✅ INVENTORY_PORT inválido falha com erro claro (8a — suíte env)
- ✅ Erro de conexão não vaza detalhes sensíveis no log (PR #24) — `sanitizeConnectionError` em módulo puro (`config/database-error.ts`) com allowlist de nomes de erro; a saída é limitada a um conjunto controlado, nunca confia no conteúdo do erro. Função 100% testada (`.message` e `.name` maliciosos). Teste do encadeamento de `connectDatabase` (console.error + process.exit) diferido → ver Fase 7/10.
- ✅ Constraints rejeitam: quantity negativo, reserved negativo, reserved > quantity (8a — suíte estrutura, verificação por nome de constraint)
- ✅ Importar o app NÃO sobe o servidor nem conecta ao banco (8a — suíte estrutura, separação app/server)
- ✅ **TESTE DE CONCORRÊNCIA OBRIGATÓRIO**: duas reservas simultâneas do último item — só uma deve passar (8a — suíte concorrência, prova o lock atômico do $executeRaw)
- ✅ setStock com quantity < reserved (8a — suíte stock.service, QUANTITY_BELOW_RESERVED)
- ✅ Payloads inválidos: string, float, null, campos faltando, negativos (8a — suíte stock.service, validação numérica)
- release com ownership/autorização → **PENDENTE (8c)**: lógica do `releaseStock` coberta no 8a, mas a autorização na camada de rota (ADMIN/SELLER) é teste HTTP. Ownership real (validar de quem é a reserva) é dívida do order-service (ver seção própria).
- Mapeamento status: 400, 401, 403, 404, 409 → **PENDENTE (8c)**: o service lança os erros corretos (provado no 8a); falta provar a tradução para status HTTP na camada de rota.

### inventory.client (product-service) — integração Bloco 6 (Bloco 8c — pendente)
- fetchAvailability: sucesso, 404, non-OK, timeout/abort, erro de rede, JSON inválido, schema inválido, `available` negativo
- Encoding de productId na URL
- findProductById: produto ausente (null), com availability, com availability null (inventory fora)
- Contrato/tipo da nova resposta do detalhe do produto

---

## FASE 7 (API Gateway e Segurança) — hardening transversal a TODOS os serviços

- **JWT hardening:** jwt.verify com `algorithms`, `issuer`, `audience` explícitos + validar shape do payload antes de confiar no `role`. Aplicar em auth, product e inventory de forma consistente.
- **403 não vazar roles:** retornar 403 genérico, logar required/current role apenas server-side. Hoje todos os serviços retornam `{ required, current }` no corpo.
- **Autenticação serviço-a-serviço:** token interno/mTLS entre product e inventory (hoje a consulta de disponibilidade é pública). Modelar identidade de serviço.
- **Separar /health (liveness) de /ready (readiness com check de DB):** quando houver health probes de orquestração consumindo.

---

## FASE 7/10 (Infra, Resiliência, Deploy)

- **Timeout configurável no inventory.client** + circuit breaker/retry para falhas transitórias (resiliência avançada).
- **Validar config no boot do product-service:** garantir INVENTORY_SERVICE_URL presente, condicionar fallback localhost ao ambiente de dev.
- **Criação de índices MongoDB em produção:** via script de migração ou passo de deploy documentado, em vez de auto-indexing do Mongoose.
- **Rate limit com store no Redis:** compartilhado entre instâncias do auth-service ao escalar horizontalmente.
- **Logger estruturado:** substituir os console.warn do inventory.client por logger de verdade, com rate limit para não gerar ruído se o inventory ficar instável.
- **Teste de integração do `connectDatabase` (inventory-service):** provar que o `catch` chama só a saída sanitizada no `console.error` e dispara `process.exit(1)`. Exige mock de `process.exit` + spy de `console.error` + forçar `$connect` a falhar. A lógica de segurança já está coberta pela função pura `sanitizeConnectionError` (PR #24); este teste cobre apenas o encadeamento, de baixo risco de regressão. Fazer quando o `connectDatabase` ganhar lógica nova (ex.: retry) ou na rodada de robustez de testes.
- **Fixar versão do MongoDB no `mongodb-memory-server` + cache do binário no CI (product-service):** hoje o `MongoMemoryServer.create()` baixa a versão padrão sem fixar, e sem CI ainda não há cache do binário. Quando o pipeline (Fase 10) existir, fixar a versão para reprodutibilidade entre máquinas e configurar cache para não rebaixar o binário a cada run. Levantado no review do PR #25.

---

## REFATORAÇÃO DEDICADA (qualidade de código, transversal)

- **Erros de domínio como classes/enums** em vez de strings (`error.message === 'INSUFFICIENT_STOCK'`). Afeta inventory e product.
- **Estender o tipo Request do Express** com interface de usuário autenticado, eliminando `(req as any).userId/userRole` em todos os serviços.
- **DTO explícito `ProductWithAvailability`** para o retorno enriquecido do findProductById (hoje é objeto inline sem tipo nomeado).
- **Normalizar base URL** do inventory.client (new URL() ou tratar barra final).
- **Mover helpers puros para módulo `utils/` (product-service):** `parsePositiveInt` (controller) e `pickAllowedFields` (service) foram exportados para permitir teste unitário, aumentando a superfície pública dos módulos. Mover para um `utils/` dedicado mantém o teste sem expor helpers internos do controller/service. Levantado no review do PR #25; export atual é trade-off aceitável até lá.

---

## ORDER-SERVICE (Fase 4) — quando existir

- **Release de estoque com ownership real:** amarrar cada reserva a um ID de pedido/usuário e validar posse antes de liberar. Hoje release está restrito a ADMIN/SELLER como mitigação, mas não valida de quem é a reserva.

---

## REFATORAÇÃO FUTURA (risco baixo, registrado)

- **setStock atômico:** hoje o guard (quantity < reserved) e o upsert são operações separadas — há fresta sob concorrência. A constraint CHECK do banco é a rede de segurança atual. Tornar atômico com UPDATE condicional ou isolamento. Risco baixo: setStock é administrativo, não concorrente como reserve.

---

## DÍVIDAS HERDADAS DA FASE 2 (registradas, retomar quando fizer sentido)

- Testes de integração end-to-end com Supertest, incluindo o 429 do rate limit
- Paginação no endpoint /admin/users do auth-service
- Login social via OAuth2 com Google