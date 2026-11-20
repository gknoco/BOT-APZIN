# Reservas de fila e reconciliação

A migration `20261120000300_blacklist_queues_atomic.sql` cria um registro durável por tentativa, com os IDs da reserva e da partida, escopo, participantes, posições originais, canal vinculado e estado. A reserva remove temporariamente **todas** as inscrições dos capitães em filas da mesma guild, não apenas a fila que fechou. Enquanto estiver `reservada`, entradas diretas, importação e a RPC não permitem nova inscrição desses capitães na mesma guild. Outras guilds são independentes. Quando a partida conclui, essas outras inscrições também deixam de existir; o bot não oferece entrada automática nelas. A exclusividade termina ao concluir ou cancelar a reserva: isso não é um bloqueio para impedir a participação em outra partida já ativa.

A blacklist continua removendo usuários das filas ativas. Se alguém for bloqueado entre reserva e criação, a criação é recusada e a reserva fica pendente. Não há cancelamento nem recolocação automática ao receber erro. A importação conta como `bloqueados` tanto usuários na blacklist quanto em reserva pendente, para não inseri-los; revise-os depois de reconciliar.

O processo gera e registra no log o ID da reserva e da partida **antes** do primeiro pedido. As RPCs de reserva, vínculo do canal e criação são repetidas uma vez com os mesmos argumentos, não com uma chave nova. Se persistir falha de rede, consulta vazia não prova que um pedido anterior terminou. Reservas pendentes sobrevivem ao reinício; não há temporizador que as libere. O tópico do canal Discord contém o ID da reserva, para ajudar a encontrar canais cuja resposta de criação foi perdida. Essa operação externa não é transacional: ainda pode haver canal órfão e a publicação de mensagem não é exatamente uma vez.

## Corte e privilégios

Pare todas as instâncias antigas antes de aplicar a migration e deixe-as paradas até que somente o novo código seja executado. As assinaturas antigas de `royal_operacional_reservar_fila` e `royal_operacional_criar_partida` são recusadas e não concedidas ao `service_role`. Clientes e scripts externos precisam migrar para as novas assinaturas: uma versão antiga não conseguirá formar partidas. A função `royal_blacklist_fila_lock()` mantém o bloqueio global e requer `READ COMMITTED`; operações diretas que tomem `SELECT FOR UPDATE` devem obter primeiro esse lock. O bloqueio global serializa guilds e pode diminuir throughput. Escritores privilegiados devem respeitar as RPCs e não alterar manualmente as tabelas ou desabilitar triggers.

A migration `20261120001000_filas_exclusao_ids_seguras.sql` também é necessária em bancos que já aplicaram a versão anterior da 003. Ela instala as RPCs de remoção para filas e blacklist, protege os IDs das inscrições reservadas e audita grants herdados. Se detectar colisão já existente entre IDs de filas ativas e reservas pendentes, ou entre reservas pendentes, a migration aborta: não apague inscrições nem renumere posições automaticamente; um administrador deve reconciliar os dados antes do corte. A instalação e a auditoria locais não comprovam os privilégios efetivos em outro ambiente.

Todos os clientes devem usar `royal_operacional_remover_filas` e `royal_operacional_remover_blacklist` para exclusões concorrentes. Um `DELETE` direto pode iniciar com snapshot anterior à espera do trigger e não enxergar uma inserção confirmada durante essa espera. Se uma operação administrativa necessariamente usar SQL direto, ela deve abrir transação `READ COMMITTED`, executar `SELECT public.royal_blacklist_fila_lock()` como **comando separado antes** do `DELETE` e de qualquer lock de linha, e só então executar o `DELETE` e confirmar a transação. Um CTE ou chamada ao lock na mesma instrução do `DELETE` não corrige o snapshot. Triggers protegem IDs reservados mesmo em inserções/atualizações diretas; o proprietário/superusuário capaz de desativá-los continua fora dessa garantia.

Não recue manualmente a sequência de IDs. Se isso acontecer e uma identidade gerada colidir com um ID suspenso, a inserção ou o lote falha sem comprometer a reserva; reconcilie/avance a sequência antes de repetir. As IDs e os horários originais continuam necessários para restaurar a ordem FIFO.

A tabela de reservas é legível pelo `service_role`, mas não gravável diretamente por ele. Mantenha os estados terminais e tombstones: apagá-los, restaurar um backup antigo ou reexecutar uma migration antiga por cima da nova pode permitir um pedido atrasado ou chave antiga, invalidando o fencing. Não execute versões antigas depois do corte. Proteja os dados de participantes e limite o acesso administrativo. Testes locais não substituem a validação de grants e configurações no ambiente real.

## Reconciliação administrativa

Use acesso administrativo restrito ao banco e verifique a guild. Identifique a reserva pelo log `[fluxo] reserva iniciada` ou pelo tópico Discord. As consultas a seguir são exemplos para um console SQL seguro; substitua os dois valores com parâmetros preparados, não concatene entrada de usuário.

```sql
SELECT id, partida_id, guild_id, modo, preco, gelo, quantidade, estado,
       jogadores, canal_id, criado_em, atualizado_em
FROM public.royal_fila_reservas
WHERE guild_id = :guild_id AND id = :reserva_id;
-- Para uma lista de pendências, use LIMIT e paginação por criado_em/id.
```

1. Se `concluida`, verifique a partida pelo `partida_id` e o canal vinculado. **Não cancele para reintroduzir**, não crie uma segunda partida e não exclua o canal. A RPC de cancelamento também retorna `concluida` sem recolocar. A publicação/edição da mensagem Discord é separada; verifique o canal antes de agir para evitar mensagens repetidas.
2. Se `reservada`, procure canal pelo tópico com o ID da reserva e revise participantes, blacklist e logs. Se o canal correto está vinculado e ainda se deseja formar a partida, repita a nova `royal_operacional_criar_partida` com **o mesmo** ID de reserva, partida, escopo, canal e a mesma lista ordenada de jogadores/times. Use como JSON válido a lista com `user_id` do primeiro e `time` 1 e `user_id` do segundo e `time` 2; verifique previamente o conteúdo. Se a resposta se perder, repita os mesmos parâmetros. Não inicie outra seleção para os mesmos capitães.
Se o canal foi localizado pelo tópico mas ainda não está vinculado, após conferir que é o canal correto e pertence à guild, um administrador pode vincular o mesmo ID e então repetir a criação. Os valores e `:jogadores` (JSON ordenado) devem ser conferidos contra o registro; não gere IDs novos:

```sql
SELECT public.royal_operacional_vincular_canal_reserva(:reserva_id, :guild_id, :canal_id);
SELECT public.royal_operacional_criar_partida(
  :reserva_id, :partida_id, :guild_id, :modo, :preco, :gelo, :canal_id, :jogadores::jsonb
);
```

3. Se não se deseja prosseguir, ou não é possível verificar o canal, chame a RPC abaixo. Ela espera por qualquer transação que já tenha o lock; se a criação venceu, retorna `concluida`. Se o cancelamento vencer, grava `cancelada` **antes** de restaurar as inscrições e impede até criação/reserva atrasada que chegue depois. Reintroduz apenas linhas originais elegíveis, preservando `entrou_em` e ID para FIFO; usuários em blacklist ou outra reserva pendente são omitidos. Se a resposta se perder, chame novamente a mesma RPC e confirme o estado. Nunca conclua que houve liberação apenas pelo timeout.

```sql
SELECT public.royal_operacional_cancelar_reserva(:reserva_id, :guild_id);
```

4. Se não existir registro, mas o log mostra o ID gerado, a mesma RPC cria um tombstone `cancelada` para essa guild, vedando inclusive uma reserva ainda em trânsito. Uma consulta vazia **sem** esse fencing não é suficiente. Um ID ausente também impede reconciliar automaticamente a tentativa; escale e não prometa recuperação.
5. Atualize os painéis das filas afetadas após cancelamento. Trate canais órfãos manualmente apenas depois de confirmar o estado; uma criação Discord cujo retorno foi perdido pode surgir mais tarde. Não presuma que cancelar uma reserva cancele a operação HTTP do Discord.

`insuficiente` é terminal para a chave: não houve seleção; para uma nova tentativa é necessário outro ID. `cancelada` também é terminal e não pode ser reutilizada. Nunca apague esses registros por conta própria.
