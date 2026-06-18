# Dívida Técnica e Pendências — Projeto E-Commerce

Este documento registra decisões conscientes de adiamento tomadas durante os code reviews.
Cada item foi avaliado, discutido e deliberadamente agendado para o momento arquiteturalmente
correto, em vez de corrigido na hora. Não são esquecimentos — são trade-offs documentados.

Organizado por DESTINO (onde será resolvido). Atualizado ao final de cada bloco.

Última atualização: Fase 3, Bloco 6 concluído.

---

## BLOCO 8 (Testes da Fase 3) — bloco dedicado de testes

### product-service
- POST /products com token ADMIN e SELLER (201)
- POST /products sem token → 401
- POST /products com BUYER → 403
- Criar/atualizar com preço negativo → 400
- Soft delete: produto some da listagem E do detalhe (GET /:id)
- Update não pode alterar `active`
- ID inválido → 400; produto ausente → 404
- Paginação: default, page/limit custom, limit>50, page/limit inválidos
- Filtro por categoria; busca por texto; search vazia/muito longa
- Formato da resposta paginada (data, page, limit, total, totalPages)

### inventory-service
- /health responde
- Startup falha sem DATABASE_URL
- INVENTORY_PORT inválido falha com erro claro
- Erro de conexão não vaza detalhes sensíveis no log
- Constraints rejeitam: quantity negativo, reserved negativo, reserved > quantity
- Importar o app NÃO sobe o servidor nem conecta ao banco
- **TESTE DE CONCORRÊNCIA OBRIGATÓRIO**: duas reservas simultâneas do último item — só uma deve passar (prova o lock atômico do $executeRaw)
- release com ownership/autorização
- setStock com quantity < reserved
- Payloads inválidos: string, float, null, campos faltando, negativos
- Mapeamento status: 400, 401, 403, 404, 409

### inventory.client (product-service) — integração Bloco 6
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

---

## REFATORAÇÃO DEDICADA (qualidade de código, transversal)

- **Erros de domínio como classes/enums** em vez de strings (`error.message === 'INSUFFICIENT_STOCK'`). Afeta inventory e product.
- **Estender o tipo Request do Express** com interface de usuário autenticado, eliminando `(req as any).userId/userRole` em todos os serviços.
- **DTO explícito `ProductWithAvailability`** para o retorno enriquecido do findProductById (hoje é objeto inline sem tipo nomeado).
- **Normalizar base URL** do inventory.client (new URL() ou tratar barra final).

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