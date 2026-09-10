# Migração vazia — o nome NÃO descreve o que ela faz

Esta migração é um **no-op**. O `CHECK` que o nome promete foi aplicado na
migração anterior, `20260910135858_adiciona_reembolso_no_pedido`, junto do
`ALTER TYPE` e do `ADD COLUMN`.

## Como isso aconteceu

O CHECK foi acrescentado à migração anterior **antes** de ela ser aplicada. Eu
li o estado do arquivo fora de ordem, concluí que o CHECK não estava lá, e criei
esta migração para corrigir algo que já estava correto. Como o schema não tinha
mudado, o Prisma gerou um arquivo vazio.

## Por que ela não foi removida

Ela já foi aplicada, e o Prisma grava o checksum do `migration.sql` em
`_prisma_migrations`. Editar o arquivo quebraria o próximo `migrate` em toda
base que já a aplicou. Remover a pasta exigiria apagar a linha correspondente na
tabela de controle dos dois bancos — cirurgia manual desproporcional para um
arquivo de 30 bytes sem efeito.

Esta nota fica ao lado do `.sql` porque o Prisma só verifica o `.sql`: arquivos
extras na pasta são ignorados.

## Regra que sai daqui

Migração aplicada é **imutável**. Se o conteúdo estiver errado depois de rodar,
a saída é sempre uma migração nova — nunca editar a anterior. E antes de criar
uma migração corretiva, **ler o arquivo que se pretende corrigir**.
