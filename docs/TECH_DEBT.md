# Dívida Técnica e Pendências — Projeto E-Commerce

Registro de decisões conscientes de adiamento, avaliadas nos code reviews e agendadas para o momento arquiteturalmente correto. Não são esquecimentos — são trade-offs documentados.

Organizado por **destino**. Só pendências: dívidas pagas são removidas daqui (o histórico permanece nos PRs).

Última atualização: **Fase 5 em andamento** (Blocos 1 e 2 concluídos; Bloco 3 em PR).

---

## Limites conhecidos e aceitos (com gatilho de correção)

Trade-offs aceitos cujo **gatilho** de correção está explícito — não são trabalho agendado por data.

- **Janela de crash claim-first (notification-service):** se o processo cair entre o `claim` e o `ack`, a reentrega é tratada como duplicata sem processar o efeito. Inerente ao at-least-once sem efeito transacional. **Gatilho:** quando o consumer deixar de ser stub e ganhar efeito real (e-mail/push), é obrigatório adotar efeito+claim atômicos (outbox no consumidor). Destino: **evolução do notification-service (Fase 6+/pós-MVP)**.
- **Premissa de 2 casas decimais (payment-service):** `src/domain/money.ts` assume 100 centavos por unidade monetária. Verdadeiro para BRL, falso para JPY (0 casas) e dinares (3). Seguro enquanto `Currency = 'BRL'`. **Gatilho:** suporte a segunda moeda.
- **`Number()` aceita hexadecimal e exponencial em `parseTimeout` e `parseMinutos` (payment-service):** `PAYMENT_WINDOW_MINUTES=0x10` vira 16 e `1e3` vira 1000. Documentado em teste, não corrigido: hexadecimal num `.env` não é acidente plausível, e um parser próprio só para isso é código a mais para manter. **Gatilho:** se um dos dois for endurecido, os dois vão juntos — corrigir só um cria divergência silenciosa entre parsers irmãos.
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

- **Token do usuário trafega por HTTP entre payment e order.** Levantado no review do PR #52 (achado 3.2): `parseUrlDeServico` aceita `http:` e `https:`, e o `OrderClient` repassa o `Authorization` do usuário para o endereço configurado. Se HTTP for usado sem camada externa segura, o JWT pode ser interceptado. **Não corrigido exigindo HTTPS**, e o motivo é de topologia: `http://` entre serviços dentro de um cluster com mTLS de malha é o padrão normal, e exigir `https` em produção quebraria justamente a arquitetura que a Fase 7 vai montar. A decisão correta é junto do gateway/malha: ou exigir HTTPS, ou exigir e **documentar** mTLS comprovado. Mesmo raciocínio do token de serviço ADMIN acima.

- **Token de serviço ADMIN (order → inventory):** o order assina um token ADMIN com o segredo compartilhado para chamar `reserve/release`. Mitigação aceita, não dívida paga: o segredo compartilhado já permite forjar qualquer token, então usar ADMIN não amplia o raio de ataque. Correção real: identidade por serviço (mTLS/chaves assimétricas) + issuer/audience/scopes (ex.: `inventory:reserve`). (PR #41.)
- **Authz por dono/serviço da reserva:** a posse **estrutural** foi paga no 7a (reservas amarradas ao `orderId`; `release(orderId)` só toca o que é do pedido). A **autorização** ainda é incompleta: qualquer ADMIN/SELLER libera qualquer `orderId`; qualquer papel logado reserva com `orderId` arbitrário. Exposição conhecida e aceita para este estágio. Correção: auth serviço-a-serviço + `orderId` vindo de claims confiáveis.

---

## FASE 5 — fechar no Bloco 10 (dentro desta fase)




## FASE 5 — critérios herdados entre blocos


Compromissos assumidos em um bloco que **outro bloco** desta fase tem de cumprir. Antes
viviam apenas em conversa e em descrição de PR — inclusive um controle de segurança.
Mesmo ciclo das dívidas: removidos daqui quando entregues.


### Procedimento — verificacao de ciclo de vida
- **Verificacao de ciclo de vida exige binario compilado, porta livre e liveness.** Teste unitario com dependencia injetada nao cobre a FIACAO no ponto de entrada. Duas tentativas no Bloco 3a foram invalidadas: `npx`/`npm run dev` sao wrappers e o `kill` atinge o wrapper, nao o processo; e um orfao de execucao anterior na mesma porta faz o `curl` responder por outro processo. Procedimento: `npm run build` + `node dist/server.js`, conferir que a porta estava livre, checar liveness antes do `curl`, e so entao enviar o sinal.

### Bloco 4 - Webhook e inbox

As cinco entradas abaixo foram PAGAS no PR do Bloco 4. Cada uma registra o
caso que a cobre e a sabotagem que prova que o caso pega o defeito: remover o
mecanismo derruba aquele caso, e somente ele. A REMOCAO destas linhas e escopo
do PR de manutencao do Bloco 10, junto com as demais dividas pagas da fase.

- [PAGO] **Politica fail-closed do `providerCreatedAt` nulo.** Evento sem timestamp de origem vai ao inbox como `IGNORED` e nao altera estado do pagamento.
  Prova: CASO 9 em `tests/integration/webhook.integration.test.ts`; sabotagem S3 (remover a guarda) derruba somente o CASO 9. A obrigacao registrada como `it.todo` em `schema-constraints.integration.test.ts` foi cumprida pelo CASO 9, em `webhook.integration.test.ts`; o `it.todo` foi substituido por um ponteiro para ele.
- [PAGO] **`express.json()` NAO alcanca a rota de webhook.** O `express.raw({ type, limit })` vive dentro do `webhookRouter`, e o router e montado antes do parser global em `src/app.ts`, para que o corpo cru nunca vaze para outra rota.
  Prova: CASO 5; sabotagem S11 (re-serializar o corpo antes de verificar a assinatura) derruba somente o CASO 5. S10 (remover a montagem) derruba todos os casos da suite, o que confirma que a rota e sustentada por toda a suite.
- [PAGO] **Cap de tamanho do `rawBody`.** `LIMITE_CORPO_WEBHOOK = 64kb`, acima dos 10kb do JSON global porque payload de provedor carrega a cobranca inteira, e abaixo do que serviria como vetor de exaustao de memoria.
  Prova: CASO 16 (413 e zero linha de inbox); sabotagem S12 (subir o teto para 10mb) derruba somente o CASO 16.
- [PAGO] **Sanitizacao em escrita** do payload do inbox e das mensagens de erro.
  Implementada por DENYLIST e nao por allowlist: o inbox existe para preservar evidencia de campos que o provedor mande e nos nao conhecamos (`fake.wire` guarda `bruto` por esse motivo), e allowlist apagaria exatamente isso. Teto de profundidade 8 e de 100 itens por array. `lastError` nunca recebe a mensagem original do erro, que carrega nome de tabela e coluna.
  Prova: CASO 17; sabotagem S13 (gravar `evento.raw` sem sanitizar) derruba somente o CASO 17.
- [PAGO] **`CANCELED` com trilha de transacao coerente** (achado 4.6 do review do PR #52). A `AUTHORIZE` que estiver em `PENDING` e fechada como `FAILED` + `failureCode = PROVIDER_CANCELED`. Sem migracao de enum: `failureCode` ja carrega a distincao, e `TransactionStatus` continua com tres valores.
  Prova: CASO 13; sabotagem S6 (nao fechar a autorizacao) derruba somente o CASO 13.

Dois defeitos que a suite adversarial encontrou ANTES de existirem em producao,
e que nao estavam na lista original do bloco:

- `podeTransicionar(X, X)` devolve `true` de proposito, porque replay nao e transicao. Sem curto-circuito quando o estado alvo ja e o atual, dois eventos DISTINTOS reportando o mesmo estado criariam uma segunda linha `CAPTURE`, e a trilha diria que o dinheiro foi capturado duas vezes. Coberto pelo CASO 7, sabotagem S1.
- Colisao no `@@unique` do inbox nao pode ser tratada como duplicata incondicional: uma linha `RECEIVED` ou `FAILED` significa que o efeito NUNCA aconteceu, e responder 200 prenderia o pagamento para sempre por uma falha transitoria. Coberto pelo CASO 8, sabotagem S2.
- A guarda `Buffer.isBuffer` na rota estava sem NENHUM teste. Descoberta pela sabotagem S9, que nao derrubou nada. Coberta pelo CASO 15.
- `payment.succeeded` nao validava o valor capturado contra o cobrado, embora o `POST /payments` faca isso em `assertValoresCoerentes`. Assinatura valida prova ORIGEM, nao COERENCIA. Coberto pelo CASO 18, sabotagem S14.
- `refund.succeeded` nao validava o reembolso contra o `capturedAmountCents` do NOSSO banco. Invariante distinta da do `fake.wire`, que so compara campos do payload entre si e nao conhece o nosso estado. Coberto pelo CASO 19, sabotagem S15.

### Bloco 5 — Integração payment ↔ order
- **Primeiro consumer do order-service:** idempotência por `eventId` + DLQ, no padrão do notification-service. Hoje o order só produz eventos.


### Bloco 6 — Reconciliação e expiração
- **Recuperar chave de idempotencia presa em PROCESSING.** Quando `createCharge` falha de forma TRANSIENTE (timeout, 5xx), o dinheiro pode ter se movido — a resposta se perdeu, nao necessariamente o efeito. O servico deliberadamente NAO marca a chave como FAILED, porque isso liberaria nova tentativa com `attemptCount + 1` e chave de provedor nova, causando SEGUNDA COBRANCA. O custo: a chave fica presa em PROCESSING e o cliente nao consegue pagar aquele pedido ate a reconciliacao rodar. **O job deste bloco e obrigatorio para fechar o ciclo:** repetir `createCharge` com a chave DERIVADA (`paymentId:attemptCount`) devolve a cobranca original, e o desfecho pode ser gravado.
- **Definir TTL e limite de tentativas da janela de retentativa.**
- **DECISÃO EM ABERTO: congelar a resposta do replay.** Levantado no review do PR #52 (achado 4.4, segunda metade). O vínculo requisição↔chave foi pago no Bloco 3 (coluna `requestFingerprint`), mas o replay ainda **lê o `Payment` vivo** em vez de devolver uma resposta congelada. Consequência: uma chave cuja tentativa foi recusada passa a devolver `CAPTURED` depois que **outra** chave efetuar tentativa bem-sucedida no mesmo pedido. Há contra-argumento real — refletir o estado atual é mais útil ao cliente em vários casos — então é decisão de produto, não defeito óbvio. Custo se adotado: coluna de resposta serializada e política de retenção. O estoque fica reservado durante toda a janela; é decisão de negócio com efeito em disponibilidade. Referência inicial: 15 min e 3 tentativas.
- **Modelo do contador de tentativas.** Hoje `attempts` conta apenas TENTATIVAS QUE FALHARAM com excecao. Desfechos retentaveis (`providerRef` ainda desconhecido, contencao no CAS) devolvem 503 sem incrementar, entao um teto baseado so nesta coluna nao controlaria esse tipo de reentrega. Definir no mesmo bloco do teto: ou separar `failedAttempts` de `deliveryAttempts`, ou basear a quarentena em idade do `receivedAt`. Levantado na 2a rodada de review (achado 4.2).
- **`attempts` do inbox sem teto.** Um evento que falha de forma DETERMINISTICA (bug no handler, ou dado que nunca vai validar) e reprocessado a cada reentrega do provedor. Hoje `WebhookEvent.attempts` apenas conta; nao ha quarentena nem parada. Definir teto e destino (parking/DLQ) junto com o job deste bloco, que ja vai varrer `RECEIVED` orfao e `IGNORED`. Levantado ao desenhar o handler do Bloco 4.
- **Ordenacao fina entre eventos de MESMO tipo.** A defesa contra evento fora de ordem no Bloco 4 e a maquina de estados: evento que nao encontra transicao permitida vira `IGNORED`. Isso basta enquanto cada estado e alcancado uma vez, mas nao distingue dois eventos do mesmo tipo com `providerCreatedAt` diferentes. Custo: coluna `lastProviderEventAt` no `Payment` e comparacao antes do compare-and-swap. Fica neste bloco porque e o que ja mexe em reconciliacao.
- **Claim de posse na linha do inbox.** Duas entregas CONCORRENTES do mesmo evento colidem no `@@unique`; a segunda encontra a linha em `RECEIVED`/`FAILED` e prossegue com o MESMO `registro.id`. O compare-and-swap protege o efeito financeiro, a releitura apos CAS perdido evita `IGNORED` indevido, e o `updateMany` condicionado a `RECEIVED`/`FAILED` impede que uma execucao que falha sobrescreva o `PROCESSED` da outra. RISCO RESIDUAL: duas execucoes ainda compartilham a mesma linha, entao conclusoes concorrentes podem gravar uma por cima da outra — trilha imprecisa, nunca duplicacao de dinheiro. Correcao definitiva: claim atomico com estado `PROCESSING` ou coluna de lease/token, e conclusao condicionada a posse. Exige migracao. Levantado nas duas rodadas de review do PR do Bloco 4.


### Bloco 8 — Bateria de testes
- **Provar ROLLBACK de escrita parcial no `$transaction` de `persistirTentativa`.** O que já está provado: o duble de Prisma cobre ordem das operações e decisões, e a integração cobre os `CHECK`, o `@unique` de `orderId` e concorrência real. O que **não** está provado: que uma falha *depois* de uma escrita bem-sucedida dentro da mesma transação desfaz a anterior. No teste de concorrência a falha acontece no primeiro `create`, então não há escrita prévia para desfazer. Exige injetar falha no meio da transação — por exemplo forçar violação de `CHECK` no `paymentTransaction.create` após o `payment.update` de `attemptCount`, e conferir que o contador volta ao valor anterior.
- **Cobrir o `getPrisma` sem `connectDatabase` prévio.** O caminho de erro existe e tem mensagem explícita, mas nenhum teste o exercita.


### Bloco 9 — Stripe e hardening
- **Rodar a suíte de contrato (`payment-provider.contract.ts`) contra a Stripe.** É o que valida a abstração da porta.
- **Sanitização de log**, rate limit no webhook, escopo PCI documentado.
- **Webhook confia no payload assinado em vez de re-buscar via `getCharge`.** O handler do Bloco 4 usa `state` e `capturedAmountCents` do corpo verificado por HMAC. A assinatura prova autenticidade dos bytes, entao o valor e autentico enquanto o segredo estiver integro, e a obsolescencia ja e coberta pela maquina de estados. Com provedor real, re-buscar o snapshot antes de aplicar efeito financeiro e o hardening esperado. A coerencia de valor contra `Payment.amountCents` ja e verificada hoje.
- **Nenhum log em 401/400 na rota de webhook.** Assinatura forjada e evento invalido sao recusados em silencio: zero observabilidade de tentativa de forja. Entra junto do rate limit ja registrado nesta secao, com log sanitizado (nunca o corpo, nunca o cabecalho de assinatura). Levantado no review do PR do Bloco 4.
- **Revisitar o REQUISITO de gravar `raw` no inbox.** Cinco rodadas de review encontraram defeito na sanitizacao do payload bruto: aliases PCI, estrutura aninhada, colisao de normalizacao, heranca de prototipo. O filtro esta correto hoje e provado por sabotagem, mas a alternativa estrutural e nao gravar `raw` e sim o `WebhookEventPayload` ja validado — sem dado desconhecido, nao ha o que filtrar. Nao foi feito no Bloco 4 porque contraria decisao explicita do Bloco 3 (o `fake.wire` guarda `bruto` para preservar campo extra, e o schema documenta o payload como evidencia para reprocessamento). Se aparecer uma sexta rodada de defeito nesse filtro, a correcao certa e revisitar o requisito, nao o filtro.


### Bloco 10 — Fechamento
- **Finalizar o README do payment-service e revisar o README da raiz.** Ambos foram *criados/marcados* no PR de manutenção pré-Bloco 3, com o estado daquele momento. O que falta e a revisão final: descrever os endpoints, o fluxo completo e trocar o marcador 🟡 por ✅ quando a fase fechar.
- **PDF de revisão da fase** em `docs/phase-reviews/phase-05.pdf`.
- **Avaliar subir `lib` para `es2022` no tsconfig do payment-service.** Hoje `Array.prototype.at` não compila, e o teste teve de usar aritmética de índice. O Node 22 suporta. Mudança de configuração que afeta todo o serviço e pode revelar outros erros — não entra em PR de feature para não misturar escopo.
- **`WebhookEvent.lastError` guarda tambem o MOTIVO de `IGNORED`,** que nao e erro. O nome da coluna e mais estreito que o uso real. Renomear para `lastReason` custa migracao; entra junto da limpeza das dividas pagas, para nao gastar migracao isolada no meio da fase.



### Gatilho - captura em duas fases (fora da Fase 5)
- **Linha `VOID` quando `CANCELED` chega sobre autorizacao ja SUCEDIDA.** O handler do webhook fecha a `AUTHORIZE` em `PENDING` como `FAILED` + `PROVIDER_CANCELED`. O ramo em que a autorizacao ja sucedeu exigiria uma linha `VOID`, e ele nao existe hoje porque `AUTHORIZED` nao tem produtor: `mapearEstadoDoProvedor` nao mapeia nenhum `ChargeState` para ele, por decisao de captura automatica (decisao 10 da fase). Implementar agora seria codigo morto. Gatilho: quando a captura em duas fases entrar, no fluxo de expedicao.


## FASE 7 — Gateway, Segurança e Infra

### Segurança
- **JWT hardening — `issuer`/`audience` e shape do payload.** O que resta aqui e apenas isto: `jwt.verify` com `issuer` e `audience` explicitos, e validacao do shape do payload antes de confiar no `role`. A forca do segredo **ja foi paga** (cart, order, inventory e product recusam placeholder em qualquer ambiente e exigem 32+ caracteres em producao), e o `algorithms` explicito **ja existe no payment-service** desde o Bloco 3, junto da validacao de claims. Falta aplicar `algorithms` em auth, product, inventory e cart, e `issuer`/`audience` nos cinco. **Exposicao hoje:** o segredo e compartilhado, entao um token emitido para outro destino e aceito por qualquer servico — mas quem tem o segredo ja forja qualquer token, o mesmo raciocinio da excecao do token de servico ADMIN. Passa a importar quando existir identidade por servico, e a correcao e conjunta com escopos. (Levantado no quarto review do PR #52.)
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
- **Não existe CI neste repositório.** Levantado indiretamente no review do PR #52: o `statusCheckRollup` do PR vem **vazio**, e o revisor registrou por três vezes que "não é possível confirmar apenas com base no diff se os testes foram executados". Hoje a única evidência de que a bateria passou é o output colado na descrição do PR — que é palavra do autor, não verificação independente. Mínimo necessário: workflow rodando `npm run verify` e `npm run verify:integration` com Postgres de serviço, por serviço alterado.
- **CI prover env de teste:** `.env.test` não é versionado (`JWT_SECRET` etc.); o pipeline precisa setar, senão os testes de autorização falham. **O pipeline deve rodar `npm run verify`** (inclui type-check e build) **e `npm run verify:integration`** onde houver suíte separada — `npm test` sozinho não cobre build nem integração.
- **Teste de config do `redis.ts`** (fallback quando `REDIS_URL` ausente).
- **Teste de integração do `connectDatabase` (inventory):** `catch` sanitizado + `process.exit(1)`.
- **Fixar versão do MongoDB no `mongodb-memory-server` + cache no CI (product).**
- **Rodar `npm run verify` (build+test) no CI (product).**
- **Testes e2e com Supertest incl. 429 do rate limit** [herdada da Fase 2].
- **Teste de rollback quando a 2ª escrita da transação falha (order):** exige ponto de injeção de falha (a atomicidade vem do `$transaction`; o caminho "valida antes de escrever" já é testado).

---

## Refatoração transversal (→ Fase 7, pass de qualidade)
- **`PaymentService` concentra invariantes demais.** Levantado no review do PR #52 (achado 5.2): a classe reúne claim idempotente, autorização por posse, validação monetária, controle de concorrência, persistência, tradução de dependências, estado financeiro e composição da resposta. Não é observação estética — é o **diagnóstico da causa** dos achados 4.1, 4.2 e 4.5, que viviam nas interações entre esses invariantes e não dentro de nenhum deles. Separar a aquisição atômica da tentativa, a classificação do resultado do provedor e o armazenamento/replay idempotente em componentes menores. Fazer **depois** dos invariantes corrigidos, nunca junto.


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
