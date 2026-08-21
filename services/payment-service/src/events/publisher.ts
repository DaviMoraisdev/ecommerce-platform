/** STUB do Bloco 5a. Assinatura ja definitiva: a URL vem do loadConfig. */
export function initEventPublisher(url: string): Promise<void> {
  void url;
  return Promise.reject(new Error('initEventPublisher: nao implementado (Bloco 5a)'));
}

export function isPublisherReady(): boolean {
  return false;
}

export async function publish(routingKey: string, payload: object): Promise<boolean> {
  void routingKey;
  void payload;
  throw new Error('publish: nao implementado (Bloco 5a)');
}

export async function closeEventPublisher(): Promise<void> {
  /* nada a fechar enquanto nao ha conexao */
}
