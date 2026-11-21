# ORG Royal AP — Bot Discord v4

Bot Discord.js v14 para filas e apostas de Free Fire, mediação, economia, roleta e lojinha. Toda a persistência usa exclusivamente o Supabase: filas, partidas, painéis, plantão, blacklist, telagem, configurações, auditoria, PIX, carteira (Royal Coins e giros), compras, roleta, inventário e rankings. O dispatcher deduplica interações Discord e os helpers evitam uma segunda resposta inicial quando a API retorna 40060.

## O que mudou na v4

- `InteractionCreate` deduplica por ID antes de qualquer operação assíncrona; o botão PIX abre o modal como primeira resposta e revalida autorização no submit.
- Respostas Discord centralizadas usam `reply` uma única vez e, se o Discord indicar 40060, passam para `followUp` em vez de tentar outro ACK inicial.
- Registro e consulta de PIX, comissão, titular, cidade e autorização continuam exclusivamente no Supabase. O envio de PIX para uma sala lê a chave do Supabase e não grava snapshots locais. A importação manual omite chaves antigas das cópias de partidas/auditoria enviadas à nuvem, sem modificar o backup original.
- Ajustes de coins/giros/estatísticas, transferências, roleta e compras usam RPCs atômicas com `request_id` idempotente e ledger remoto.
- `/perfil`, `/verp`, `/ranking` e o botão de ranking consultam perfis Supabase; resultados de partidas também atualizam os rankings remotos, com retry idempotente por ID de partida.
- Compras que concedem coins/giros creditam o perfil; resgates PIX/físicos ficam com status `pending`.
- Entregas de cargos da roleta/loja também ficam pendentes no Supabase até a atribuição do Discord ser confirmada; falhas não são descartadas silenciosamente.
- As migrações v4 revogam acesso de `anon`/`authenticated`, ativam RLS nas tabelas persistentes e reservam policies/grants ao backend `service_role`; somente essa role executa as RPCs `SECURITY DEFINER`.
- `/ajuda` é gerado a partir do registro real de comandos e os organiza por categoria; o modal valida o e-mail Pix, o botão **Copia e Cola** responde em privado e o painel de `/comprar` expira após 30 minutos; o comportamento pré-existente de `/painelcomprar` foi preservado.
- `/configcanal1`, `/configcanal2`, `/logs`, `/boombot setlog`, `/boombot setcategoria`, canais/cargos/modo de mediadores e configurações `/conectar` são gravados em `discord_configuracoes` sem espelho ou fallback local; os mediadores consultam as configurações persistidas na nuvem.
- A remoção resiliente trata mensagens inexistentes (Discord `10008`) sem interromper `/clearall`; falhas de canal inexistente (`10003`) nas boas-vindas/saídas não geram avisos repetidos.

## Instalação e atualização

1. Use Node.js **22.12.0 ou superior** e execute `npm ci`. O importador legado usa `node:sqlite`; `npm run migrate:supabase` aplica automaticamente `--experimental-sqlite`, necessária no Node 22.12.
2. Copie `.env.example` para `.env` e configure `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID` e `SUPABASE_SERVICE_ROLE_KEY`. O `SUPABASE_URL` do template aponta para o projeto Apzin; mantenha a chave privada apenas no ambiente do servidor/Railway.
3. Em um banco novo, aplique no SQL Editor do Supabase **todas** as migrações de `supabase/migrations`, em ordem pelo nome. No repositório atual, a sequência é:
   - `supabase/migrations/202611140001_discord_features.sql`
   - `supabase/migrations/202611140002_royal_ap_core.sql`
   - `supabase/migrations/202611150001_supabase_source_of_truth.sql`
   - `supabase/migrations/202611150002_economy_source_of_truth.sql`
   - `supabase/migrations/202611150003_service_role_security.sql`
   - `supabase/migrations/20261116044000_royal_room_sales.sql`
   - `supabase/migrations/20261116060000_operational_supabase.sql`
   - `supabase/migrations/20261116060001_operational_panels.sql`
   - `supabase/migrations/20261117001100_royal_wallet_topups.sql`
   - `supabase/migrations/20261117010700_royal_infinite_rooms.sql`
   - `supabase/migrations/20261117014100_royal_wallet_statement.sql`
   - `supabase/migrations/20261117120228_royal_wallet_room_purchases.sql`
   - `supabase/migrations/20261118000100_roulette_shop_pro.sql`
   - `supabase/migrations/20261118000200_confirmar_preco_loja.sql`
   - `supabase/migrations/20261118010000_royal_room_admin_grants.sql`
   - `supabase/migrations/20261118014500_official_queue_banner.sql`
   - `supabase/migrations/20261118015000_official_queue_avatar.sql`
   - `supabase/migrations/20261118070000_fixed_mediator_fee.sql`
   - `supabase/migrations/20261118080000_invite_tracker_counters.sql`
   - `supabase/migrations/20261118090000_ss_duty_panels.sql`
   - `supabase/migrations/20261119000100_mediator_room_quotas.sql`
   - `supabase/migrations/20261119000200_mediator_initial_quota_once.sql`
   - `supabase/migrations/20261119000300_sync_mediator_room_quota.sql`
   - `supabase/migrations/20261119000500_royal_room_initial_redemption.sql`
   - `supabase/migrations/20261120000100_wallet_topup_refund_protection.sql`
   - `supabase/migrations/20261120000200_atomic_initial_room_redemption.sql`
   - `supabase/migrations/20261120000300_blacklist_queues_atomic.sql`
   - `supabase/migrations/20261120000400_match_readiness_manual_room.sql`
   - `supabase/migrations/20261120001000_filas_exclusao_ids_seguras.sql`
   - `supabase/migrations/20261120002001_pag04_direct_room_refunds.sql`
   - `supabase/migrations/20261120002002_eco01_eco02_shop_intentions.sql`
   - `supabase/migrations/20261120002003_eco03_rescue_claim.sql`
   - `supabase/migrations/20261120002004_fil08_match_outbox.sql`

   Em banco já existente, faça backup e confira o histórico **e o schema real** antes de aplicar somente as migrações ainda necessárias, em ordem, sem reaplicar indiscriminadamente migrações antigas. Arquivos executados manualmente no SQL Editor podem não constar no histórico gerenciado; os dois scripts de imagem de fila alteram a configuração de um servidor específico. Confira também se foram adicionados arquivos posteriores à lista acima e aplique-os antes do deploy. A execução manual no SQL Editor não registra automaticamente a migração no histórico da CLI.
   Para o corte das novas migrações, pare e drene todas as instâncias antigas, atendimentos e integrações incompatíveis; siga os roteiros de [estorno de compra direta](docs/runbooks/direct-room-refund-review.md), [resgates](docs/runbooks/rescue-claim-cutover.md) e [encerramento de partidas](docs/runbooks/fil08-encerramento-outbox.md) e o [guia da lojinha](GUIA_ROLETA_LOJINHA.md). Faça backup, audite permissões e integrações, aplique as migrações em ordem e só depois inicie o novo código e registre os comandos slash. Não misture versões durante o corte.
   Para o corte das migrações de resgate e blacklist, **pare todas as instâncias antigas do bot antes de aplicá-las** e só inicie instâncias com o novo código depois: o resgate legado podia escrever diretamente na carteira e não deve disputar com a fotografia de revisão. Confira o schema e o backup antes do corte. A migração de blacklist também remove jogadores bloqueados já presentes em filas; republique ou atualize os painéis afetados no Discord após o corte.
   A migração `20261120000400` também altera o contrato das RPCs de prontidão e sala manual: aplique-a com instâncias antigas paradas e reinicie somente com este código. Não misture versões durante o corte.
   Carteiras anteriores sem resgate comprovado são encaminhadas para revisão em `royal_room_initial_redemption_reviews`: o resgate inicial fica bloqueado até a administração investigar pedidos, ledger e histórico e resolver o caso de forma auditável. Isso não altera nem reduz o saldo existente. Se não for possível comprovar a origem, mantenha a revisão e não crie evidências ou créditos artificiais.
   Siga o [roteiro de corte e reconciliação](docs/runbooks/initial-room-redemption-cutover.md) para verificar privilégios, integrações e histórico antes de instalar as migrações.
4. Se você tem dados de uma versão SQLite, pare o bot antigo, faça um backup consistente (incluindo transações do WAL) e execute `npm run migrate:supabase -- --sqlite /caminho/backup.db --origem servidor-royal` antes de iniciar esta versão. O backfill importa filas, partidas, jogadores e confirmações antigas, painéis, plantão, blacklist, configurações, telagem e históricos; o arquivo original fica **somente leitura**. Dados remotos existentes nunca são sobrescritos; perfis usam uma RPC idempotente que preenche valores zerados e **aborta em conflitos**. Mantenha a mesma `--origem` para snapshots do mesmo banco. Não execute as versões antiga e nova simultaneamente. Sem backup legado, pule esta etapa; o runtime nunca cria ou abre `.db`.
5. Execute `npm run commands:sync` ou deixe o bot sincronizar os comandos no evento `ready`.
6. Inicie com `npm start`.

`SUPABASE_SERVICE_ROLE_KEY` é segredo exclusivo do servidor. Nunca a envie ao Discord, ao cliente ou ao GitHub. Configure no Railway o `SUPABASE_URL` do projeto Apzin e a chave `service_role` emitida por esse mesmo projeto antes do deploy; uma chave antiga de outro projeto não serve. O ZIP de distribuição não deve conter `.env`, `node_modules`, bancos locais ou arquivos de credenciais.

## Encerramento de partidas (FIL-08)

A migração `20261120002004_fil08_match_outbox.sql` confirma resultado/W.O. ou cancelamento, prêmio em coins, estatísticas, auditoria e intenções de aviso transacionalmente. O consumidor da outbox é iniciado com o bot. Avisos Discord podem atrasar ou duplicar; históricos sem marcador econômico exigem revisão antes de crédito. Valores em reais e Pix continuam externos ao bot. Veja o [roteiro de encerramento e reconciliação](docs/runbooks/fil08-encerramento-outbox.md).

## Persistência exclusivamente Supabase

Não existe fallback nem espelho SQLite no runtime. `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` são obrigatórios; `DATABASE_PATH` e volumes de banco local não são utilizados. A leitura de `versiculos.json` fornece apenas o catálogo estático para seed, não armazena estado operacional.

As tabelas `royal_filas`, `royal_fila_reservas`, `royal_partidas`, `royal_partida_jogadores`, `royal_partida_go`, `royal_paineis`, `royal_mensagens_painel`, `royal_plantao`, `royal_blacklist`, `royal_telagem_links`, `royal_telagens` e `royal_logs_dm` preservam o estado operacional na nuvem. Operações críticas de fila, criação/confirmacão/finalização de partidas, GO e reserva de telagem usam RPCs transacionais. Economia e vendas mantêm suas tabelas e RPCs anteriores, sem redefinir preços, pacotes ou regras financeiras.

A formação usa reserva durável: enquanto pendente, os capitães não reentram em outra fila da mesma guild. A partida e a conclusão da reserva são atômicas e uma RPC de cancelamento sela o fencing antes de restaurar posições elegíveis. Falhas incertas não causam recolocação automática; a administração pode reconciliar após reinício. Outras inscrições dos capitães são suspensas durante a reserva e removidas ao concluir a partida. As assinaturas antigas de reserva/criação deixam de funcionar no corte. O Discord não é transacional e pode deixar canal órfão. Consulte [reservas e reconciliação](docs/runbooks/contencao-pareamento-blacklist.md).

Após o pagamento, o mediador responsável usa o comando oficial externo para criar a sala e registra manualmente seu ID e senha em **Informar ID e senha** no cartão da partida. Somente jogadores/capitães cadastrados podem usar **Estou pronto**, no cartão atual e no canal e servidor da partida. A RPC existente registra uma confirmação por jogador e, quando todos confirmam, passa o estado interno para `em_andamento`. Isso **não inicia nem confirma o início real da sala Nix**: a operação de início é feita externamente pelo comando oficial. Resultado e W.O. continuam disponíveis. A migração `20261120000400_match_readiness_manual_room.sql` é necessária antes de publicar esta versão; cartões ativos são atualizados na inicialização, quando acessíveis ao bot.

O mediador responsável, autorizado pelos cargos da guild, pode corrigir ID/senha **antes da primeira prontidão**. Após qualquer prontidão registrada, uma correção com dados diferentes é bloqueada sem apagar confirmações; se necessário, cancele e refaça a partida. Um reenvio com ID/senha idênticos continua permitido após a prontidão e também após o início, para reconciliação. A versão carregada pelo botão e pelo formulário impede que um cartão antigo sobrescreva uma correção; o reenvio idêntico é a exceção segura.

Se o retorno do banco ou a atualização do Discord falhar, não crie outra sala. Confira o cartão e confirme com a administração quais credenciais são atuais antes de qualquer reenvio; só reenvie os mesmos dados se ainda forem os que devem valer. Se o cartão não estiver acessível ou houver divergência, peça à administração para verificar e reconciliar. A verificação posterior da versão e do conteúdo descreve o estado no momento da consulta, não garante que ele não mudará depois. Uma edição pode ter sido aceita mesmo quando a resposta falha; edições de múltiplas instâncias não têm ordenação garantida no Discord. A fila local de edição apenas serializa dentro de uma instância, não garante entrega exatamente uma vez nem que o cartão permanecerá atualizado. Confira sempre o cartão antes de prosseguir e mantenha instâncias antigas paradas durante o corte.

Configurações de boas-vindas/saída, auditoria, categorias, mediadores e integrações usam `discord_configuracoes` como única fonte de verdade. A persistência remota precisa concluir com sucesso antes de confirmar uma configuração. Credenciais de `/conectar` continuam privadas; a listagem mostra apenas se estão configuradas.

O backfill é uma transição manual, não uma sincronização contínua. Guarde os backups existentes até verificar que todas as linhas foram importadas e que não houve conflitos. A migração de código/schema não copia automaticamente arquivos de um servidor Railway ao qual esta tarefa não tem acesso.

## Configurando prêmios e loja

Para adicionar prêmio à roleta:

```sql
insert into public.royal_roulette_prizes
  (guild_id, name, reward_type, reward_value, weight)
values
  ('ID_DO_SERVIDOR', '50 Coins', 'coins', '50', 60),
  ('ID_DO_SERVIDOR', 'Giro bônus', 'spins', '1', 25),
  ('ID_DO_SERVIDOR', 'Cargo VIP', 'role', 'ID_DO_CARGO', 15);
```

Para adicionar produto:

```sql
insert into public.royal_shop_items
  (guild_id, slug, name, description, price, reward_type, reward_value, stock)
values
  ('ID_DO_SERVIDOR', 'acai', 'Copão de Açaí', 'Resgate físico com a ADM', 500, 'physical', 'acai-copao', null);
```

Os produtos podem conceder coins, giros, cargos, resgates físicos ou PIX. Cada prévia de compra cria uma intenção única e expira em 15 minutos; seu botão é idempotente mesmo com novos cliques. Estoque, saldo, termos, inventário e ledger são processados pelo Supabase. Para corte e limitações dos registros antigos, consulte o [guia da lojinha](GUIA_ROLETA_LOJINHA.md).

## Testes e operação

- `npm test` executa as suítes offline de regressão, compras, comandos, serviços e persistência Supabase, sem gerar cobranças reais nem iniciar o bot.
- `npm run test:economia:sql` e `npm run test:auditoria:sql` executam testes em PostgreSQL temporário local; exigem PostgreSQL com `initdb`, `pg_ctl` e `psql`, além de Python 3. Não acessam o Supabase de produção.
- `npm run test:pag04:sql`, `npm run test:resgates:sql`, `npm run test:match:sql` e `npm run test:prontidao:sql` também executam testes em PostgreSQL local temporário.
- `npm run test:prontidao:sql` testa cliques e publicação manual concorrentes em PostgreSQL temporário usando `pg_virtualenv`; não acessa o banco remoto.
- `npm run migrate:supabase -- --sqlite /caminho/backup.db --origem servidor-royal` importa o estado legado em modo somente leitura, preservando dados remotos e abortando conflitos de perfis.
- `npm run commands:sync` publica a lista atual e remove comandos remotos obsoletos conforme a resposta da API do Discord.
- `npm start` abre também o health check HTTP para Railway/Render.

### Build Nixpacks e aviso de configuração do npm

O `nixpacks.toml` configura a fase de instalação com `cmds` (lista de comandos, conforme a [referência do Nixpacks](https://nixpacks.com/docs/configuration/file)), executando `env -u NPM_CONFIG_PRODUCTION -u npm_config_production npm ci --omit=dev --engine-strict`, e inicia com `node index.js`. Não há script `build` no `package.json`. Para desenvolvimento e testes, use `npm ci` com as configurações normais; se `NODE_ENV=production` estiver definido, `npm ci --include=dev` inclui as dependências de teste. O `--omit=dev` é apenas para a instalação de produção, não para `npm test`.

O aviso `npm warn config production Use --omit=dev instead` pode vir da flag antiga `--production`, das variáveis `NPM_CONFIG_PRODUCTION`/`npm_config_production` ou de `production=true` em algum `.npmrc`. Nas instalações de produção, substitua a flag por `--omit=dev`. Acrescentar `--omit=dev` não elimina o aviso se uma variável legada continuar herdada: o `env -u` acima remove ambas **somente para esse comando de instalação**. `NODE_ENV=production` é uma configuração distinta e não precisa ser removida por causa desse aviso.

Se o aviso persistir no Railway, confira em qual etapa do log ele aparece e verifique as variáveis do serviço e eventuais comandos de build/start personalizados ou arquivos de configuração npm externos. Variáveis como `NIXPACKS_INSTALL_CMD` e `NIXPACKS_START_CMD` também podem sobrescrever comandos do arquivo. Remova a opção ou variável legada na origem apropriada após verificar seu uso por outros processos; não exponha valores de segredos. Outros comandos npm, incluindo `npm start`, também podem emitir o aviso ao herdar essa variável. Configurações do painel, etapas anteriores ou comandos externos não são controlados pelo `nixpacks.toml`; um redeploy e a inspeção dos logs do serviço são necessários para confirmar o resultado.

O bot exige o **Server Members Intent** para rastrear convites. A detecção por diferença de usos é tratada como observação; convites simultâneos ou indisponíveis são registrados sem inventar um convidador.

## Central de vendas ROYAL SALA

A migração `20261116044000_royal_room_sales.sql` cria os pedidos Pix, cupons, carteiras, ledger, reservas/uso de salas, eventos de webhook e RPCs transacionais; as tabelas têm RLS e grants/policies somente para `service_role`. A compra Pix é idempotente, o QR e o código copia-e-cola são enviados em resposta efêmera, e o saldo só é creditado após consultar a API autenticada do Mercado Pago e validar status, moeda, valor e referência externa. O webhook assinado é persistido no Supabase e processado pelo worker com retry durável.

Comandos e permissões:

- `/permicompras` — somente `DEV_OWNER_ID`; define no Supabase os cargos autorizados para a Central de Compras.
- `/painelcomprar` — dono do bot, proprietário do servidor ou IDs em `CARGOS_SUPER_ADMIN_IDS`; publica e fixa o painel no canal atual, registra esse canal no Supabase e mantém a mensagem pública permanente.
- `/recarga` — Administrador ou proprietário do servidor; publica e fixa o painel principal da carteira para toda a staff. Navegação para **Sala Infinita** e **Extrato** abre painéis efêmeros independentes e nunca altera a mensagem pública. O painel Sala Infinita usa o banner oficial e os botões **⬅️ Voltar**, **📅 Semanal R$ 5,00** e **💎 Mensal R$ 13,00**; os planos acumulam validade no Supabase por servidor/usuário e as criações elegíveis consultam essa assinatura. **Extrato** mostra saldo, entradas, saídas e as seis movimentações mais recentes consultando a RPC `royal_wallet_statement` somente para o `guild_id` e `user_id` de quem clicou; **Voltar** retorna ao painel privado e **Atualizar extrato** recarrega seus dados. **Gerar Pix** abre um modal privado para valor e e-mail. O canal do painel principal fica registrado em `discord_configuracoes` no Supabase (`canal_recarga`).
- `/comprar` — exige um dos cargos definidos por `/permicompras`; abre o painel somente para quem executou, com expiração após 30 minutos.
- `/setcargo cargo:<cargo>` — Administrador ou proprietário do servidor; atribui o cargo escolhido a todos os membros (humanos e bots) e apresenta relatório de resultados.
- `/cupomcompras criar` e `/cupomcompras desativar` — somente `DEV_OWNER_ID`.
- `/minhassalas` — qualquer membro pode consultar privadamente o próprio saldo, reservas e histórico no Supabase; o `guild_id` e o `user_id` são obtidos da interação.

O painel principal mantém o visual original e os botões **Adquirir Sala** e **Ver pacotes de salas**. **Adquirir Sala** abre o formulário direto; **Ver pacotes de salas** responde em privado apenas com o embed “Escolha seu pacote”, uma instrução curta para usar o menu abaixo e o select, sem lista de preços no corpo do embed nem botões adicionais. O select usa o placeholder `Escolha seu pacote de salas...` e lista os pacotes com carrinho, quantidade e preço total. Essa resposta é efêmera e expira em 30 minutos. O formulário pede quantidade, cupom opcional e e-mail do pagador, exigido pela API do Mercado Pago.

Após gerar o Pix, o pedido e o código ficam persistidos no Supabase. **Copia e Cola** devolve em resposta efêmera apenas o payload Pix bruto dentro de um bloco de código, sem texto introdutório; o botão **Verificar pagamento** consulta o Mercado Pago. Os créditos só podem ser liberados para o `user_id` e o `guild_id` associados à ordem. A validação verifica o formato do e-mail informado, não sua propriedade. Os painéis temporários de `/comprar` e **Ver pacotes de salas** expiram após 30 minutos; `/painelcomprar` publica e fixa uma mensagem permanente no canal onde foi executado, registrando o canal no Supabase.

### Carteira digital e recargas

A migração `20261117001100_royal_wallet_topups.sql` adiciona `royal_wallet_topups`, `royal_wallet_balances` e um ledger em centavos, com RLS e privilégios exclusivos do backend `service_role`. O botão **Gerar Pix** aceita valores positivos de até duas casas decimais, cria o pedido persistente antes de chamar a API Production do Mercado Pago e mostra o QR e o código Copia e Cola em resposta efêmera. O bônus de 10% anunciado no banner é creditado a partir de R$ 10,00 (arredondado ao centavo mais próximo); o valor da cobrança Pix continua exatamente igual ao informado. **Verificar pagamento** consulta o pagamento autenticado e o crédito é aplicado por RPC transacional somente após conferir status aprovado, valor exato pago, moeda BRL, método Pix, referência externa e titular (`guild_id` + `user_id`); rechecagens não creditam duas vezes. A confirmação mostra bônus e saldo monetário persistente. Nesta etapa, a cobrança de salas do fluxo existente `/comprar` ainda segue seu próprio Pix e não consome automaticamente esse saldo, até a regra de uso/dedução ser definida.

A migração `20261117014100_royal_wallet_statement.sql` adiciona a RPC `royal_wallet_statement`, disponível somente para `service_role`, que agrega entradas/saídas de todo o ledger e retorna até seis linhas recentes, filtradas simultaneamente pelo servidor e pelo usuário Discord. A mensagem efêmera usa o banner oficial do Extrato, mas os valores reais exibidos no embed vêm do Supabase; a atualização recarrega os dados da própria conta.

### Assinatura Sala Infinita

A migração `20261117010700_royal_infinite_rooms.sql` cria pedidos de assinatura e a tabela Supabase `royal_infinite_subscriptions`. O checkout semanal custa R$ 5,00 por 7 dias; o mensal custa R$ 13,00 por 30 dias. As datas de validade se acumulam a partir da maior entre a validade ativa e o momento atual. A aprovação só é aplicada uma vez, em RPC transacional após validar pagamento aprovado, referência do pedido, valor fixo, moeda BRL, método Pix e ID do pagamento. O Pix e a validade ficam associados ao servidor e ao usuário Discord que pagou; os botões de código/consulta também filtram por essa identidade. Somente os cargos autorizados para criar salas podem comprar o plano.

Para a criação automática de salas, a RPC Supabase `royal_room_reserve_room` consulta `premium_until > now()` para o mesmo `guild_id` e `user_id` dentro da transação. Quando ativa, ela registra a reserva com `credit_charged=false`, não desconta salas da carteira, e a liquidação/reconciliação preserva essa marca mesmo se o plano expirar enquanto uma chamada Nix está pendente. Usuários sem assinatura continuam usando os créditos avulsos normalmente. O controle premium nunca aceita uma flag de privilégio enviada pelo bot.

### Variáveis privadas no Railway

Adicione estas variáveis em **Railway → projeto → serviço do bot → Variables** e faça redeploy. Nunca as inclua em `.env.example`, commit, log ou mensagem Discord:

1. `MP_ACCESS_TOKEN` — em [Suas integrações](https://www.mercadopago.com.br/developers/panel/app), selecione a aplicação do bot → **Credenciais** → escolha **Teste** para validar ou **Produção** para cobrar valores reais → copie o **Access Token**. É uma chave privada de backend; não use a Public Key.
2. `MP_WEBHOOK_SECRET` — na mesma aplicação, abra **Webhooks → Configurar notificações**, configure os eventos de pagamento e a URL, salve e revele/copie a assinatura secreta. Use a assinatura do ambiente correspondente. O código valida `x-signature` e `x-request-id` antes de enfileirar a notificação.
3. `MP_WEBHOOK_URL` — URL HTTPS pública exata do serviço Railway, terminada em `/webhooks/mercadopago` (por exemplo, `https://seu-dominio.up.railway.app/webhooks/mercadopago`). Ela também é enviada como `notification_url` na criação Pix; o servidor aceita `GET` para health check e `POST` assinado para eventos.
4. `DEV_OWNER_ID` — ID numérico da conta Discord do dono. Ative **Modo de desenvolvedor** em Discord → Configurações avançadas, clique com o botão direito/toque no perfil do dono → **Copiar ID**.
5. `CARGOS_SUPER_ADMIN_IDS` — IDs de cargos superiores autorizados a publicar `/painelcomprar`, separados por vírgula. Copie cada ID de cargo com Modo de desenvolvedor ligado.
6. `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` — URL e chave `service_role` do projeto Supabase **Apzin**, em **Project Settings → API** (ou **API Keys** no painel atual). A `service_role` é segredo administrativo; nunca use a chave `anon` e nunca a exponha.

Antes do modo produção, confirme no Railway todas as variáveis acima, valide a URL do webhook pelo endpoint `GET`, faça um pagamento de teste com as credenciais de teste/conta de teste e verifique `/minhassalas`. A referência oficial do [Access Token](https://www.mercadopago.com.br/developers/pt/docs/your-integrations/credentials), do [Pix via API](https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-api-payments/create-payment/post) e de [Webhooks/assinatura](https://www.mercadopago.com.br/developers/pt/docs/subscriptions/additional-content/your-integrations/notifications/webhooks) descreve os campos e passos do painel. A aplicação exige credenciais e configuração corretas; nenhum sistema pode prometer disponibilidade ou aprovação de pagamentos “100% sem erros”.

### Checklist final do Railway

1. Conecte o serviço à branch `main` do repositório `gknoco/BOT-APZIN` e use Node.js 22.12.0 ou superior. Quando a configuração Nixpacks do repositório é utilizada sem sobrescritas, o início executa `node index.js`; os comandos são sincronizados no evento `ready` (ou rode `npm run commands:sync` após configurar `CLIENT_ID`).
2. O runtime não necessita de volume SQLite nem de `DATABASE_PATH`. Se há um banco antigo no Railway, preserve o volume/backup até concluir o backfill manual e conferir os dados remotos; não apague o histórico antigo apenas por atualizar o código.
3. Cadastre `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID` (opcional para sincronização imediata), `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` do projeto Apzin. Não configure a chave `anon`/public.
4. Para vendas, acrescente `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `MP_WEBHOOK_URL`, `DEV_OWNER_ID` e `CARGOS_SUPER_ADMIN_IDS`. `NIX_API_KEY`/`NIX_API_URL` são necessários para criação automática das salas; `CATEGORIA_FILAS_ID`, `CARGO_ADMIN_ID`, `CARGO_STAFF_ID` e `CARGO_MEDIADOR_ID` definem a operação normal.
5. Aplique todas as migrações listadas acima no Supabase antes de publicar o serviço. Depois do primeiro `ready`, confira o health check, `/ajuda`, `/logs` e os canais de boas-vindas; teste um Pix no ambiente de teste do Mercado Pago antes de mudar para credenciais reais.
6. Nunca faça commit de `.env`, tokens, banco SQLite ou backups. Use o `.env.example` apenas como referência e cadastre valores privados no painel Railway.
