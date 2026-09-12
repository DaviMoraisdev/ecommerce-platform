// Contrato de mensageria do order-service — lado CONSUMIDOR.
//
// O exchange e a routing key sao propriedade do payment-service: este arquivo
// e copia do contrato dele. Divida ja registrada (TECH_DEBT, Fase 10: extrair
// para pacote compartilhado). Manter os dois lados em sincronia.
//
// Separado de topology.ts de proposito: aquele e o lado PRODUTOR (exchange
// "orders"). Misturar os dois num arquivo so faria parecer que o order e dono
// do exchange "payments", e ele nao e.
export const EXCHANGE_PAGAMENTOS = 'payments';
export const EXCHANGE_PAGAMENTOS_TYPE = 'topic';

// Binding ESTRITO, nao "payment.*".
// Com binding largo, um evento ainda sem consumidor chega aqui sem
// handler, e as duas saidas sao ruins: ack-e-ignora e perda silenciosa, DLQ
// empilha operacao normal numa fila de erro. Com binding estrito o evento nao
// roteia — e o publisher do payment tem mandatory + basic.return, entao ele
// fica PENDING e LOGADO na origem. Falha visivel em quem publica e melhor que
// silencio em quem consome.
export const BINDING_PAYMENT_CAPTURED = 'payment.captured';

// Bloco 6f. SEGUNDO binding na MESMA fila, e nao fila nova: o consumidor ja
// tem DLQ, classificacao de erro, teto de tentativas e sanitizacao de log —
// duplicar tudo isso para um segundo tipo de evento seria duplicar codigo cuja
// unica prova sao os casos C.
//
// O binding continua ESTRITO. O custo aceito e head-of-line blocking ENTRE os
// tipos: um payment.expired malformado ocupa o slot do prefetch(1) e segura as
// capturas atras dele. Mitigado pelo teto de tentativas (vai para DLQ) e pelo
// volume baixo de expiracao. Fila separada por tipo fica registrada como
// gatilho, se aparecer poison message real.
export const BINDING_PAYMENT_EXPIRED = 'payment.expired';

// Bloco 7b. TERCEIRO binding na mesma fila, pelo mesmo argumento do segundo.
//
// O head-of-line blocking entre tipos cresce com cada binding somado a fila, e
// este e o terceiro — o gatilho de "fila separada por tipo" fica mais perto.
// Continua aceito porque o volume de reembolso e menor que o de expiracao, e
// porque a alternativa hoje seria triplicar DLQ, classificacao de erro, teto de
// tentativas e sanitizacao de log.
//
// O binding tem de existir ANTES de o produtor publicar: o publisher usa
// mandatory + basic.return, entao evento emitido sem binding volta como nao
// roteavel e fica PENDING na outbox. Licao do 6f, onde a expiracao ficou
// desligada por exatamente isso.
//
// Ate o Bloco 7b a garantia era por CODIGO: a PAYMENT_REFUND_ENABLED mantinha
// a rota inexistente. Ela foi REMOVIDA no proprio 7b, quando este consumidor
// passou a existir. A ordem virou PROCEDIMENTO, registrado no TECH_DEBT em
// "Decisoes e procedimentos documentados": order-service primeiro, com os tres
// bindings e topologia validada; payment depois.
export const BINDING_PAYMENT_REFUNDED = 'payment.refunded';

export const QUEUE_PAGAMENTOS = 'orders.payments';
export const DLX_PAGAMENTOS = 'orders.payments.dlx';
export const DLQ_PAGAMENTOS = 'orders.payments.dlq';
