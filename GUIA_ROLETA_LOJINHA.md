# Roleta e Lojinha Royal AP

## Antes de colocar no ar

As alterações deste projeto precisam ser implantadas no bot e no banco. Faça backup do projeto Supabase e teste em um servidor de homologação antes de atualizar o bot em produção. Nenhum token, senha ou chave de serviço deve ser colocado no GitHub ou enviado no Discord.

1. No projeto Supabase **Apzin**, aplique as duas novas migrações, nesta ordem:
   - `supabase/migrations/20261118000100_roulette_shop_pro.sql`
   - `supabase/migrations/20261118000200_confirmar_preco_loja.sql`
2. Confira as variáveis do bot já usadas no Railway, principalmente `DISCORD_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e os IDs necessários. Não exponha a chave `service_role` em nenhum painel.
3. Publique a versão atualizada do código no Railway. O bot sincroniza os comandos no início; se necessário, use `npm run commands:sync` em um ambiente seguro com as variáveis configuradas. A sincronização atualiza o escopo configurado (servidor ou global) e remove o antigo subcomando de configuração da roleta; a atualização global pode demorar até uma hora. Se houver registros antigos nos dois escopos, sincronize cada um deles.
4. No Discord, confira as permissões do bot: enviar mensagens e anexos, fixar mensagens quando possível e gerenciar os cargos que deve entregar. A posição do cargo do bot precisa ser superior aos cargos que ele vai conceder.

Aplique o banco antes de ativar os novos componentes: eles dependem das duas migrações. Consulte o histórico e os saldos antes e depois da implantação. Os saldos existentes continuam nas tabelas `royal_*`; não é necessário criar uma segunda carteira.

## Configurar e publicar

1. Use `/configroleta` para criar e gerenciar prêmios, pesos, estoque, canal e intervalo entre giros. O peso é relativo: um prêmio de peso 3, diante de outro elegível de peso 1, terá 3/4 da chance enquanto esses forem os únicos disponíveis. O intervalo padrão é de três segundos; pode ser alterado ou desativado com zero.
2. Use `/config lojinha` para criar itens, preços, tipo de recompensa, estoque, limite por usuário, canal e instruções. Para vender giros, escolha o tipo `spins` e informe a quantidade. Os registros antigos são preservados: quando um item já tiver histórico, crie outro em vez de mudar sua identidade ou recompensa.
3. Publique com `/roleta painel` (ou `/roletapainel`) e `/lojinhapainel`. Os painéis são enviados publicamente no canal configurado ou, caso não haja configuração, no canal atual. O bot tenta fixá-los e informa se não conseguir.
4. Após mudanças em canais, instruções ou prêmios, publique novamente quando quiser atualizar o conteúdo do painel. A republicação não exclui nem desafixa os painéis anteriores automaticamente: confira-os e remova os antigos manualmente, se desejar.
5. Use `/ajuda` para consultar as definições reais dos comandos, incluindo opções, categorias e subcomandos. A ajuda também inclui a central `/resgates`.

Não são criados produtos nem prêmios fictícios: cadastre os itens e seus valores conforme as regras da organização. `/loja addcoins` adiciona moedas e `/addgiros` administra giros. Cada vitória registrada pelos fluxos atualizados concede um COIN; resultados já registrados antes da migração não são creditados novamente.

## Funcionamento e limites

- O painel é público, mas moedas, giros, histórico, catálogo e resultados individuais são mostrados em respostas privadas. Um painel público compartilhado não consegue exibir, ao mesmo tempo, um saldo diferente para cada pessoa.
- A arte do painel é ilustrativa. Ao girar, a resposta privada mostra uma roda animada que desacelera até o prêmio sorteado e registrado no Supabase. As fatias identificam os prêmios, mas não representam suas chances: o sorteio no banco continua respeitando pesos e estoques elegíveis. Se a imagem falhar, o resultado registrado é informado em texto.
- Compras e giros são operações transacionais no Supabase: conferem saldo, estoque e repetição da solicitação. A confirmação da loja também protege contra alterações de preço entre a visualização e o débito.
- Coins e giros são creditados automaticamente. A entrega de cargo é tentada pelo bot; falhas ficam pendentes. Um prêmio do tipo `shop_item` é adicionado ao inventário, mas não executa automaticamente a entrega associada ao produto vinculado.
- PIX e itens físicos geram pendências: o bot **não envia dinheiro nem prova que um pagamento ou produto foi entregue**. Configure um canal de logs para avisos à staff; se o canal não estiver configurado ou o Discord falhar, consulte as pendências diretamente.
- A equipe administradora pode usar `/resgates pendentes` para consultar as pendências e `/resgates concluir` para registrar uma entrega **apenas depois** de concluir o atendimento manual. Esse comando não faz pagamento, envio ou concessão de cargo. A alteração de status e a auditoria são requisições separadas, portanto confira a auditoria se houver falha de comunicação.
- Se o histórico antigo foi alterado antes desta atualização, não é possível reconstruir nomes ou valores que não foram salvos na época. A migração registra o estado disponível e preserva snapshots para os novos giros.

## Verificações locais

- `npm ci` instala as dependências; o projeto usa Node.js 22 ou superior.
- `npm test` executa os testes automatizados do bot e dos novos painéis.
- `npm run test:economia:sql` executa testes de transações e concorrência em um PostgreSQL local temporário. Requer Python 3 e os binários `initdb`, `pg_ctl`, `psql` e `pg_config`; não usa o Supabase de produção.

Os testes locais usam simulações do Discord e um banco descartável: ainda é necessário verificar os fluxos no servidor de homologação após a implantação.
