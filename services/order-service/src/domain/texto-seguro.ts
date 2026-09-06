/**
 * Saneamento de texto vindo de FORA antes de log ou persistencia.
 *
 * Extraido do consumidor no Bloco 6f (achado 3.2 da 1a rodada do PR #61): a
 * pendencia de compensacao gravava `err.message` cru em `reason`, e mensagem
 * de cliente HTTP costuma trazer URL com credencial no userinfo, corpo de
 * resposta e quebra de linha (que forja linha de log).
 *
 * Modulo de dominio, e nao do transporte: persistencia nao deve depender do
 * modulo de mensageria so para sanear texto.
 */

// Conteudo vindo do broker entra em log. Duas defesas distintas:
//  - caractere de controle: CR/LF permite forjar linha de log falsa;
//  - credencial: err.message de biblioteca costuma trazer a URL do broker
//    inteira, com a senha dentro do userinfo.
// A redacao e por token, sem regex: regex sobre entrada nao controlada e
// superficie de ReDoS e sempre deixa um caso escapar. Mesma abordagem do
// motivoSeguro do payment-service.
export function sanitizarParaLog(s: string): string {
  let semControle = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    semControle += code < 32 || code === 127 ? '?' : ch;
  }
  const redigido = semControle
    .split(' ')
    .map((parte) => (parte.includes('://') ? '[uri redigida]' : parte))
    .join(' ');
  return redigido.length > 200 ? redigido.slice(0, 200) + '...' : redigido;
}
