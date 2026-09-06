# Contratos de evento entre servicos

Fixtures LIDAS pelas suites dos dois lados de cada evento.

Nao resolvem a duplicacao de codigo entre produtor e consumidor (registrada no
TECH_DEBT, Fase 10: extrair para pacote compartilhado). Resolvem o problema que
importa antes disso: hoje o payload e reimplementado em cada servico, e um campo
renomeado de um lado passa nos DOIS conjuntos de teste e so falha em producao.

Com a fixture, o produtor prova que GERA exatamente este JSON e o consumidor
prova que o ACEITA. Renomear um campo quebra um dos dois lados.

Achados 5.1 e 6.3 da 1a rodada de review do PR #61.
