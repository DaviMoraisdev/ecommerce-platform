# Parecer geral do projeto — outubro de 2026

Base de evidência: varredura do repositório em 2026-10-28, com `main` em
`6bc7d9d`. Tudo nas seções 1 a 6 saiu de comando executado; a seção 7 lista o
que permanece sem verificação e com que comando se verifica.

## 1. Retrato do que existe

528 commits desde 2026-05-24, cinco meses de trabalho. Oito diretórios de
serviço, cinco áreas na raiz (`gateway`, `frontend`, `e2e`, `contracts`,
`experiments`), um `docker-compose.yml` com quatro imagens de infraestrutura
(Postgres 15, Mongo 7, Redis 7, RabbitMQ 3.13) e um workflow de CI com matriz
por serviço.

Produção somada: cerca de 14.800 linhas de TypeScript. Teste somado: cerca de
22.300. A razão global de 1,5 linha de teste por linha de produção é alta, e
quase toda concentrada em um lugar.

## 2. Maturidade por serviço

| Serviço | Produção | Teste | Armazenamento | Migrações | Rotas | No CI |
|---|---|---|---|---|---|---|
| payment-service | 9.513 | 14.772 | Postgres (Prisma) | 9 | 3 | sim |
| order-service | 2.798 | 3.740 | Postgres (Prisma) | 15 | 3 | sim |
| product-service | 664 | 1.196 | Mongo + Redis | 0 | 5 | não |
| cart-service | 570 | 774 | Redis | 0 | 5 | não |
| inventory-service | 505 | 1.265 | Postgres (Prisma) | 5 | 4 | não |
| notification-service | 440 | 309 | Redis | 0 | 0 | não |
| auth-service | 342 | 247 | Postgres (Prisma) | 2 | 5 | não |
| user-service | 0 | 0 | nenhum | 0 | 0 | não |

O payment-service é 64% da produção e 66% do teste do projeto inteiro. Isso não
é crítica: foi decisão deliberada de usar pagamentos como projeto-âncora, e o
resultado se defende. Mas tem três consequências que importam.

A primeira é a assimetria de risco. O auth-service, que guarda todos os outros
serviços, tem 342 linhas de produção e 247 de teste — a única razão
teste/produção abaixo de 1 no projeto, e o único serviço cuja falha compromete
todos os demais ao mesmo tempo. Um bug de validação de token ali vale mais, em
impacto, do que qualquer bug no adapter da Stripe.

A segunda é que cinco serviços com código não têm CI. A matriz do workflow
inclui apenas `order-service` e `payment-service` (`.github/workflows/ci.yml`,
linhas 18 a 23). Um PR que altere auth, cart, inventory, notification ou
product não recebe typecheck, teste nem build automáticos.

A terceira é a divergência de estilo. O payment-service usa composição por
dependências — rotas construídas por função que recebe `deps`, provedores atrás
de uma porta, relógio injetável, fábrica com guarda no boot. Os serviços
anteriores usam singleton de módulo e importação direta de controller. Os dois
padrões convivem no mesmo repositório sem nada que explique por quê.

## 3. Qualidade medida

payment-service: 882 testes unitários em 37 suítes, 171 de integração em 8
suítes, cobertura de 85,23% de linhas, 83,58% de instruções, 83,87% de funções
e 75,64% de ramos (1.087 de 1.437).

order-service: 179 testes unitários em 15 suítes, 71,64% de linhas.

O número que mais informa é o de ramos do payment-service: 350 ramos sem
cobertura em um serviço de dinheiro. Não é alarme — 75% de ramo é número
respeitável, e muitos desses ramos são guardas defensivas que nunca disparam.
Mas é o indicador que vale acompanhar, porque ramo sem teste em código de
pagamento é exatamente onde mora o tipo de bug que o Bloco 9b-3 encontrou: o
caminho de erro do caminho de erro.

O método de teste deste projeto é o ativo mais valioso dele. Teste por
sabotagem com alvo nomeado, forma fechada de objeto, negativa exigindo
contagem, e a regra de não afirmar em artefato durável sem output real. Isso é
prática de equipe sênior, e é o que seria mais difícil de ensinar depois.

## 4. A dívida: o que os 153 registros realmente são

O `TECH_DEBT.md` tem 153 entradas, 41 marcadas como pagas. A distribuição
desmonta a leitura de "112 dívidas abertas":

82 entradas estão em "FASE 5 — critérios herdados entre blocos", que não é
dívida e sim registro de critério que cada bloco novo precisa respeitar. 27
estão em Fase 7 (gateway, segurança, infra), 18 em Fase 10 (resiliência e
qualidade) e 9 em refatoração transversal — trabalho real, endereçado a fases
que ainda não começaram. As 17 restantes se dividem entre limites aceitos com
gatilho, decisões documentadas sem trabalho pendente, exceções de segurança
aceitas, performance e backlog.

O documento acumula duas funções, registro de dívida e registro de critério, e
isso torna o tamanho dele enganoso para quem olha de fora. A limpeza das
entradas pagas já está prevista no Bloco 10; vale separar os critérios
herdados para um arquivo próprio no mesmo passo.

## 5. Lacunas estruturais

Três diretórios vazios. `gateway` e `frontend` têm zero arquivo fora de
`node_modules`; `user-service` tem zero linha de código. São casca criada na
estrutura inicial do monorepo e nunca preenchida. Para um projeto de portfólio
isso é pior que não existir: quem abre o repositório vê oito serviços e um
gateway, e encontra três vazios.

Contratos de evento parciais. `contracts/` versiona dois eventos
(`payment.expired.v1` e `payment.refunded.v1`). Os demais eventos do fluxo
payment-order trafegam sem contrato versionado ao lado.

O `.env` de `experiments/rabbitmq-demo/` não está rastreado e está coberto pela
regra `.env` do `.gitignore` (linha 12), confirmado por `git ls-files
--error-unmatch` e `git check-ignore -v`. Não é exposição de segredo.

`e2e` existe e é substancial: seis suítes, incluindo `happy-path`,
`concurrency`, `payment` e `auth-journey`. Não está no CI e não foi executado
nesta varredura.

## 6. Implantação: onde o sistema vai rodar

Confirmado por comando: não existe nenhum Dockerfile no repositório
(`find . -name 'Dockerfile*'` sem resultado) e o `docker-compose.yml` não tem
nenhuma diretiva `build:`. O compose sobe as quatro dependências de
infraestrutura e nada mais.

Então o obstáculo não é escolher onde hospedar: não existe artefato
implantável. Somando a isso o gateway vazio e o frontend vazio, não há hoje
porta única pela qual um usuário externo entre no sistema, nem interface para
ele usar.

A ordem técnica que isso impõe, antes de qualquer discussão de provedor:
Dockerfile por serviço, o gateway deixando de ser casca, configuração por
variável de ambiente validada no boot (o payment-service já faz isso, e o
padrão está pronto para copiar), migrações rodando no deploy, e
observabilidade mínima. Só depois disso a escolha entre uma VPS, um PaaS
gerenciado ou um orquestrador passa a ser decisão com consequência real.

Para a análise geral de bugs e lógica das fases finais, o material existe e
está no lugar certo: o `e2e` com fluxo completo e concorrência é a base natural
dela, e hoje está subaproveitado.

## 7. O que permanece sem verificação

Contagem de testes dos cinco serviços menores e do `e2e` — só payment e order
foram executados nesta varredura. E se as suítes do `e2e` passam hoje.

## 8. Recomendações classificadas

Essencial agora: decidir o destino dos três diretórios vazios, ou entram no
roadmap com fase definida, ou saem do repositório.

Essencial agora: levar os cinco serviços fora do CI para a matriz, ao menos com
`typecheck` e teste unitário, que não precisam de banco e por isso saem quase
de graça. A integração deles pode esperar, porque exige Mongo e Redis no
workflow.

Pode esperar, com data: nivelar o auth-service ao padrão de teste do
payment-service. Não precisa de 882 casos; precisa cobrir expiração,
assinatura inválida, troca de algoritmo, refresh reutilizado e escalada de
papel. É a maior assimetria risco/cobertura do projeto.

Pode esperar: separar o `TECH_DEBT.md` em dívida e critérios herdados, junto da
limpeza das entradas pagas, no Bloco 10.

Pode esperar: trazer o `e2e` para o CI, mesmo em job separado e tolerante a
falha no início.

Não necessário neste estágio: unificar o estilo dos serviços antigos com o
padrão de composição do payment-service. A inconsistência é visível, mas
refatorar seis serviços estáveis por uniformidade estética não agrega
aprendizado novo nem reduz risco agora. Vale no pass de qualidade da Fase 7, e
já está registrado lá.

## 9. A pergunta de prioridade

Terminar a Fase 5 como planejado (9c, Bloco 10, PDF), ou interromper para
nivelar a base antes de empilhar mais complexidade no serviço que já é dois
terços do projeto.

Recomendação: terminar a Fase 5, porque ela está a dois blocos do fim e parar
no meio desperdiça contexto, e resolver os diretórios vazios e o CI dos cinco
serviços agora, porque nenhum dos dois depende de fase, os dois são baratos, e
os dois são visíveis para quem avalia o repositório.
