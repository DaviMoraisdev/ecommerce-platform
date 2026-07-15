import amqp from 'amqplib';

// Conecta ao broker. A URL embute credenciais e porta AMQP:
// amqp://usuario:senha@host:5672. Resolvida em runtime (nao no topo do modulo).
export async function connect() {
  const url =
    process.env.RABBITMQ_URL || 'amqp://admin:rabbitmq123@localhost:5672';
  return amqp.connect(url);
}
