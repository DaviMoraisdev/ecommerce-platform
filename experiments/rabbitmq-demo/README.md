# RabbitMQ - Demo (Fase 4, Bloco 4)

Fundamento isolado de mensageria. Prova o fluxo
producer -> exchange -> binding -> queue -> consumer, sem logica de negocio.
O order-service (Blocos 5-8) vai reusar este padrao de conexao/publish.

## Rodar
1. Na raiz do repo: `docker compose up -d rabbitmq` (aguarde ficar healthy:
   `docker compose ps rabbitmq`).
2. Aqui: `cp .env.example .env` e ajuste a senha do RABBITMQ_URL para bater
   com RABBITMQ_PASSWORD do `.env` da raiz.
3. `npm install`
4. `npm run check` (valida a conexao antes de tudo).
5. Terminal 1: `npm run consume`  |  Terminal 2: `npm run publish`
6. UI de gestao: http://localhost:15672

## Conceitos
- Exchange: o producer publica AQUI, nunca direto na fila. Tipo `topic`
  roteia por padrao de routing key.
- Routing key / binding: `order.created` casa com `order.*` (`*` = uma palavra).
- Queue: onde a mensagem espera o consumer.
- durable (exchange/fila) + persistent (mensagem): sobrevivem a restart do broker.
- ack: o consumer confirma o processamento; sem ack, o broker reentrega.
  prefetch(1) evita empilhar. Payload invalido -> nack sem requeue.
- Confirm channel + waitForConfirms: o publisher espera a confirmacao do broker.
  A topologia e declarada dos dois lados, entao a mensagem e roteavel mesmo se
  o consumer ainda nao subiu (a fila duravel a retem).
