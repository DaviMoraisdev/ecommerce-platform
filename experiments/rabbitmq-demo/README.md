# RabbitMQ - Demo (Fase 4, Bloco 4)

Fundamento isolado de mensageria. Prova o fluxo
producer -> exchange -> binding -> queue -> consumer, sem logica de negocio.
O order-service (Blocos 5-8) vai reusar este padrao de conexao/publish.

## Rodar
1. Na raiz do repo: `docker compose up -d rabbitmq`
2. Aqui: `npm install`
3. Terminal 1: `npm run consume`  |  Terminal 2: `npm run publish`
4. UI de gestao: http://localhost:15672

## Conceitos
- Exchange: o producer publica AQUI, nunca direto na fila. Tipo `topic`
  roteia por padrao de routing key.
- Routing key / binding: `order.created` casa com o binding `order.*`
  (`*` = exatamente uma palavra).
- Queue: onde a mensagem espera o consumer.
- durable (exchange/fila) + persistent (mensagem): sobrevivem a restart do broker.
- ack: o consumer confirma o processamento; sem ack, o broker reentrega.
  prefetch(1) evita empilhar mensagens num consumer ocupado.
- Confirm channel + waitForConfirms: o publisher espera o broker confirmar
  o recebimento antes de fechar a conexao.
