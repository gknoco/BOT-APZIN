# Roleta e Lojinha Royal AP

## Antes de colocar no ar

As alterações deste projeto precisam ser implantadas no bot e no banco. Faça backup do projeto Supabase e teste em um servidor de homologação antes de atualizar o bot em produção. Nenhum token, senha ou chave de serviço deve ser colocado no GitHub ou enviado no Discord.

1. Em homologação isolada, pare e drene todas as versões antigas e atendimentos em andamento; faça backup. Aplique as migrações pendentes em ordem cronológica, inclusive:
   - `supabase/migrations/20261118000100_roulette_shop_pro.sql`
   - `supabase/migrations/20261118000200_confirmar_preco_loja.sql`
   - `supabase/migrations/20261120002002_eco01_eco02_shop_intentions.sql`
   - `supabase/migrations/20261120002003_eco03_rescue_claim.sql`
   Siga o [runbook de corte e reconciliação](docs/runbooks/rescue-claim-cutover.md) antes de repetir o procedimento no ambiente real.
2. Confira as variáveis do bot já usadas no Railway, principalmente `DISCORD_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e os IDs necessários. Não exponha a chave `service_role` em nenhum painel.
3. Publique a versão atualizada do código no Railway. O bot sincroniza os comandos no início; se necessário, use `npm run commands:sync` em um ambiente seguro com as variáveis configuradas. A sincronização atualiza o escopo configurado (servidor ou global) e remove o antigo subcomando de configuração da roleta; a atualização global pode demorar até uma hora. Se houver registros antigos nos dois escopos, sincronize cada um deles.
4. No Discord, confira as permissões do bot: enviar mensagens e anexos, fixar mensagens quando possível e gerenciar os cargos que deve entregar. A posição do cargo do bot precisa ser superior aos cargos que ele vai conceder.

Aplique o banco antes de ativar os novos componentes: eles dependem de todas as migrações acima. Consulte o histórico e os saldos antes e depois da implantação. Os saldos existentes continuam nas tabelas `royal_*`; não é necessário criar uma segunda carteira.

## Configurar e publicar

1. Use `/configroleta` para criar e gerenciar prêmios, pesos, estoque, canal e intervalo entre giros. O peso é relativo: um prêmio de peso 3, diante de outro elegível de peso 1, terá 3/4 da chance enquanto esses forem os únicos disponíveis. O intervalo padrão é de três segundos; pode ser alterado ou desativado com zero.
2. Use `/config lojinha` para criar itens, preços, tipo de recompensa, estoque, limite por usuário, canal e instruções. Para vender giros, escolha o tipo `spins` e informe a quantidade. Os registros antigos são preservados: quando um item já tiver histórico, crie outro em vez de mudar sua identidade ou recompensa.
3. Publique com `/roleta painel` e `/lojinhapainel`. Os painéis são enviados publicamente no canal configurado ou, caso não haja configuração, no canal atual. O bot tenta fixá-los e informa se não conseguir.
4. Após mudanças em canais, instruções ou prêmios, publique novamente quando quiser atualizar o conteúdo do painel. A republicação não exclui nem desafixa os painéis anteriores automaticamente: confira-os e remova os antigos manualmente, se desejar.
5. Use `/ajuda` para consultar as definições reais dos comandos, incluindo opções, categorias e subcomandos. A ajuda também inclui a central `/resgates`.

Não são criados produtos nem prêmios fictícios: cadastre os itens e seus valores conforme as regras da organização. `/loja addcoins` adiciona Royal Coins e `/addgiros` administra giros. Cada vitória registrada pelos fluxos atualizados concede um COIN; resultados já registrados antes da migração não são creditados novamente.

## Funcionamento e limites

- O painel é público, mas Royal Coins, giros, histórico, catálogo e resultados individuais são mostrados em respostas privadas. Um painel público compartilhado não consegue exibir, ao mesmo tempo, um saldo diferente para cada pessoa.
- A arte do painel é ilustrativa. Ao girar, a resposta privada mostra uma roda animada que desacelera até o prêmio sorteado e registrado no Supabase. As fatias identificam os prêmios, mas não representam suas chances: o sorteio no banco continua respeitando pesos e estoques elegíveis. Se a imagem falhar, o resultado registrado é informado em texto.
- Compras e giros são operações transacionais no Supabase: conferem saldo, estoque e repetição da solicitação. A confirmação da loja também protege contra alterações de preço entre a visualização e o débito.
- Coins e giros são creditados automaticamente. A entrega de cargo é tentada pelo bot; falhas ficam pendentes. Um prêmio do tipo `shop_item` é adicionado ao inventário, mas não executa automaticamente a entrega associada ao produto vinculado.
- PIX e itens físicos geram pendências: o bot **não envia dinheiro nem prova que um pagamento ou produto foi entregue**. Configure um canal de logs para avisos à staff; se o canal não estiver configurado ou o Discord falhar, consulte as pendências diretamente.
- A equipe usa `/resgates pendentes` para consultar e `/resgates iniciar` para reservar o protocolo antes de qualquer atendimento. Apenas o titular usa `/resgates concluir` depois da entrega manual; a reserva não expira e não confirma a entrega externa. Em falhas, replays ou pendências legadas, não repita o efeito: reconcilie conforme `docs/runbooks/rescue-claim-cutover.md`. Status, conclusão e auditoria são transacionais; os comandos não pagam, enviam ou concedem cargos.
- Se o histórico antigo foi alterado antes desta atualização, não é possível reconstruir nomes ou valores que não foram salvos na época. A migração registra o estado disponível e preserva snapshots para os novos giros.

## Verificações locais

- `npm ci` instala as dependências; o projeto requer Node.js 22.13.0 ou superior.
- `npm test` executa os testes automatizados do bot e dos novos painéis.
- `npm run test:economia:sql` executa testes de transações e concorrência em um PostgreSQL local temporário. Requer Python 3 e os binários `initdb`, `pg_ctl`, `psql` e `pg_config`; não usa o Supabase de produção.

Os testes locais usam simulações do Discord e um banco descartável: ainda é necessário verificar os fluxos no servidor de homologação após a implantação.

### Intenções e termos da compra (ECO-01/ECO-02)

A migração `20261120002002_eco01_eco02_shop_intentions.sql` e o código da loja devem ser implantados como unidade, após as migrações anteriores. Num ambiente de homologação isolado, pare **todas** as instâncias antigas da aplicação, aplique a migração e inicie apenas a versão atualizada. O comando `/lojinha comprar` agora abre uma prévia; o botão privado confirma a intenção, que expira em 15 minutos. Repetir o mesmo botão não compra ou entrega de novo; uma nova prévia cria uma nova intenção. Botões antigos de confirmação deixam de funcionar: abra novamente o catálogo. Não há fallback para as RPCs antigas no novo fluxo Discord.

O banco congela preço, nome, descrição, identificador, tipo/valor da recompensa e metadados no momento da compra. Alterações de preço/termos após a prévia exigem nova confirmação, e estoque/saldo/limite são verificados na transação. A edição da identidade/recompensa de um item com histórico é recusada no banco, mesmo sob concorrência com compra ou roleta; preço e estoque continuam editáveis. A administração e a entrega de cargos consultam os termos congelados.

Registros anteriores à migração não continham todos os termos originais: apenas o preço registrado é histórico. O restante é preenchido com o cadastro disponível na migração e marcado `legacy_current`; confira documentação original antes de cumprir esses resgates. Registros legados com referência de produto em outro servidor não são reconstruídos nem exibidos como elegíveis.

As funções SQL legadas continuam internas para as funções `SECURITY DEFINER`, mas deixam de ser executáveis por `service_role`; escritas diretas em compras e intenções também são bloqueadas. A migração falha se roles herdadas ou proprietárias preservarem esses acessos: remova as permissões ou ajuste o proprietário mediante procedimento administrativo e repita o corte. Integrações externas antigas devem migrar para as RPCs de intenção antes da implantação. Administradores SQL, owners e superusuários privilegiados continuam capazes de alterar permissões e dados; proteja e audite esse acesso. A concessão de cargo é externa ao banco: se o processo cair após confirmar, a compra pode permanecer pendente e deve ser revisada pela administração; um replay não repete a concessão. Intenções expiradas/consumidas são persistidas para preservar idempotência; planeje retenção e manutenção segura antes de grande volume.

Teste isolado (sem Supabase de produção): `python3 testes/eco01_eco02_shop_postgres.py`. Requer executáveis PostgreSQL locais (`pg_config`, `initdb`, `pg_ctl`, `psql`) e roda por socket privado, sem escutar rede.

### Reserva persistente e testes conjuntos (ECO-03)

A migração ECO-03 deve vir depois de ECO-01/ECO-02, na mesma janela de corte. Pendências anteriores são marcadas para revisão; o claim da loja usa o snapshot imutável, e a reserva é comum à entrega automática e ao atendimento manual. Repetições ou falhas ambíguas exigem reconciliação, não autorizam repetir o efeito externo. Rode também `python3 testes/rescue_claim_sql.py`; ambos os testes SQL aplicam as duas migrações e exercitam as RPCs em PostgreSQL local, com concorrência real.
