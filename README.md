# ORG Royal AP — Bot Discord v4

Bot Discord.js v14 para filas e apostas de Free Fire, mediação, economia, roleta e lojinha. Na v4, PIX, carteira (moedas e giros), compras, roleta, inventário e rankings de perfis usam o Supabase como fonte de verdade. O dispatcher deduplica interações Discord e os helpers evitam uma segunda resposta inicial quando a API retorna 40060.

## O que mudou na v4

- `InteractionCreate` deduplica por ID antes de qualquer operação assíncrona; o botão PIX abre o modal como primeira resposta e revalida autorização no submit.
- Respostas Discord centralizadas usam `reply` uma única vez e, se o Discord indicar 40060, passam para `followUp` em vez de tentar outro ACK inicial.
- Registro e consulta de PIX, comissão, titular, cidade e autorização continuam exclusivamente no Supabase. O envio de PIX para uma sala lê a chave do Supabase e não grava mais um snapshot em SQLite; as cópias antigas de partidas/auditoria são higienizadas.
- Ajustes de coins/giros/estatísticas, transferências, roleta e compras usam RPCs atômicas com `request_id` idempotente e ledger remoto.
- `/perfil`, `/verp`, `/ranking` e o botão de ranking consultam perfis Supabase; resultados de partidas também atualizam os rankings remotos, com retry idempotente por ID de partida.
- Compras que concedem coins/giros creditam o perfil; resgates PIX/físicos ficam com status `pending`.
- Entregas de cargos da roleta/loja também ficam pendentes no Supabase até a atribuição do Discord ser confirmada; falhas não são descartadas silenciosamente.
- As migrações v4 revogam acesso de `anon`/`authenticated`, ativam RLS nas tabelas persistentes e reservam policies/grants ao backend `service_role`; somente essa role executa as RPCs `SECURITY DEFINER`.

## Instalação e atualização

1. Use Node.js 22+ e execute `npm install`.
2. Copie `.env.example` para `.env` e configure `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID` e `SUPABASE_SERVICE_ROLE_KEY`. O `SUPABASE_URL` do template aponta para o projeto Apzin; mantenha a chave privada apenas no ambiente do servidor/Railway.
3. No SQL Editor do Supabase, aplique as migrações nesta ordem:
   - `supabase/migrations/202611140001_discord_features.sql`
   - `supabase/migrations/202611140002_royal_ap_core.sql`
   - `supabase/migrations/202611150001_supabase_source_of_truth.sql`
   - `supabase/migrations/202611150002_economy_source_of_truth.sql`
   - `supabase/migrations/202611150003_service_role_security.sql`
   - `supabase/migrations/20261116044000_royal_room_sales.sql`
4. Faça backup do banco local atual e execute `npm run migrate:supabase` antes de iniciar o bot v4. O backfill usa uma RPC idempotente para importar valores locais em perfis ausentes/zerados, preserva dados remotos não conflitantes e **aborta sem sobrescrever** quando o mesmo perfil tem valores locais/remotos diferentes; reconcilie esses casos manualmente e execute novamente. Após todas as gravações remotas, limpa chaves PIX locais antigas e snapshots/auditoria.
5. Execute `npm run commands:sync` ou deixe o bot sincronizar os comandos no evento `ready`.
6. Inicie com `npm start`.

`SUPABASE_SERVICE_ROLE_KEY` é segredo exclusivo do servidor. Nunca a envie ao Discord, ao cliente ou ao GitHub. Configure no Railway o `SUPABASE_URL` do projeto Apzin e a chave `service_role` emitida por esse mesmo projeto antes do deploy; uma chave antiga de outro projeto não serve. O ZIP de distribuição não deve conter `.env`, `node_modules`, bancos locais ou arquivos de credenciais.

## Persistência: limites explícitos

PIX, saldo, giros, roleta, loja, inventário e estatísticas usadas nos rankings são persistidos no Supabase; não há fallback econômico em SQLite. Filas, estado operacional das partidas (canais/mensagens, pagamento, sala e sessão Nix), painéis, plantão, blacklist, telagem e alguns logs/configurações continuam em SQLite. `DATABASE_PATH` permanece necessário para esses módulos. Não remova o volume/backup SQLite até concluir uma migração de cutover específica para o fluxo operacional de partidas.

O backfill é para transição. Não o use como sincronização contínua: após o corte, novas alterações econômicas são feitas somente pelas RPCs Supabase, e um arquivo SQLite antigo não deve ser tratado como autoridade para esses valores.

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

Os produtos podem conceder coins, giros, cargos, resgates físicos ou PIX. Compras e giros usam IDs de interação como chaves de idempotência; estoque, saldo, inventário e ledger são processados pelo Supabase.

## Testes e operação

- `npm test` executa testes offline, incluindo a proteção contra 40060 e verificações estáticas das rotas econômicas Supabase.
- `npm run migrate:supabase` exporta o estado legado sem apagar o banco, reconcilia perfis sem sobrescrever conflitos e remove cópias locais de PIX somente depois de confirmar o backfill.
- `npm run commands:sync` publica a lista atual e remove comandos remotos obsoletos conforme a resposta da API do Discord.
- `npm start` abre também o health check HTTP para Railway/Render.

O bot exige o **Server Members Intent** para rastrear convites. A detecção por diferença de usos é tratada como observação; convites simultâneos ou indisponíveis são registrados sem inventar um convidador.

## Central de vendas ROYAL SALA

A migração `20261116044000_royal_room_sales.sql` cria os pedidos Pix, cupons, carteiras, ledger, reservas/uso de salas, eventos de webhook e RPCs transacionais; as tabelas têm RLS e grants/policies somente para `service_role`. A compra Pix é idempotente, o QR e o código copia-e-cola são enviados em resposta efêmera, e o saldo só é creditado após consultar a API autenticada do Mercado Pago e validar status, moeda, valor e referência externa. O webhook assinado é persistido no Supabase e processado pelo worker com retry durável.

Comandos e permissões:

- `/permicompras` — somente `DEV_OWNER_ID`; define no Supabase os cargos autorizados para compra e o canal onde será publicado o painel.
- `/painelcomprar` — dono do bot, proprietário do servidor ou IDs em `CARGOS_SUPER_ADMIN_IDS`; publica no canal configurado.
- `/comprar` — exige um dos cargos definidos por `/permicompras`; publica o painel no canal atual.
- `/cupomcompras criar` e `/cupomcompras desativar` — somente `DEV_OWNER_ID`.
- `/minhassalas` — mostra saldo disponível, reservas, salas criadas hoje e total histórico, consultados no Supabase.
- `/salasreconciliar` — somente dono do bot/Administrador; resolve uma chamada Nix cujo resultado ficou incerto. Não repita a criação enquanto o crédito estiver reservado.

O painel principal tem apenas os botões **Adquirir Sala** e **Ver pacotes de salas**. O menu fixo oferece 1, 5, 10, 20, 50 ou 100 salas; a tarifa-base é R$ 0,03 por sala. O formulário pede quantidade, cupom opcional e e-mail do pagador: o campo de e-mail é necessário porque a API de pagamentos do Mercado Pago exige `payer.email`, e o bot Discord não recebe o e-mail do usuário. A seleção de pacote confirma a quantidade no modal antes de gerar o Pix, permitindo informar e-mail/cupom.

### Variáveis privadas no Railway

Adicione estas variáveis em **Railway → projeto → serviço do bot → Variables** e faça redeploy. Nunca as inclua em `.env.example`, commit, log ou mensagem Discord:

1. `MP_ACCESS_TOKEN` — em [Suas integrações](https://www.mercadopago.com.br/developers/panel/app), selecione a aplicação do bot → **Credenciais** → escolha **Teste** para validar ou **Produção** para cobrar valores reais → copie o **Access Token**. É uma chave privada de backend; não use a Public Key.
2. `MP_WEBHOOK_SECRET` — na mesma aplicação, abra **Webhooks → Configurar notificações**, configure os eventos de pagamento e a URL, salve e revele/copie a assinatura secreta. Use a assinatura do ambiente correspondente. O código valida `x-signature` e `x-request-id` antes de enfileirar a notificação.
3. `MP_WEBHOOK_URL` — URL HTTPS pública exata do serviço Railway, terminada em `/webhooks/mercadopago` (por exemplo, `https://seu-dominio.up.railway.app/webhooks/mercadopago`). Ela também é enviada como `notification_url` na criação Pix; o servidor aceita `GET` para health check e `POST` assinado para eventos.
4. `DEV_OWNER_ID` — ID numérico da conta Discord do dono. Ative **Modo de desenvolvedor** em Discord → Configurações avançadas, clique com o botão direito/toque no perfil do dono → **Copiar ID**.
5. `CARGOS_SUPER_ADMIN_IDS` — IDs de cargos superiores autorizados a publicar `/painelcomprar`, separados por vírgula. Copie cada ID de cargo com Modo de desenvolvedor ligado.
6. `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` — URL e chave `service_role` do projeto Supabase **Apzin**, em **Project Settings → API** (ou **API Keys** no painel atual). A `service_role` é segredo administrativo; nunca use a chave `anon` e nunca a exponha.

Antes do modo produção, confirme no Railway todas as variáveis acima, valide a URL do webhook pelo endpoint `GET`, faça um pagamento de teste com as credenciais de teste/conta de teste e verifique `/minhassalas`. A referência oficial do [Access Token](https://www.mercadopago.com.br/developers/pt/docs/your-integrations/credentials), do [Pix via API](https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-api-payments/create-payment/post) e de [Webhooks/assinatura](https://www.mercadopago.com.br/developers/pt/docs/subscriptions/additional-content/your-integrations/notifications/webhooks) descreve os campos e passos do painel. A aplicação exige credenciais e configuração corretas; nenhum sistema pode prometer disponibilidade ou aprovação de pagamentos “100% sem erros”.
