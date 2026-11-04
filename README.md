# Radar Invest — plataforma de investimentos (SaaS)

Cripto, ações da B3, FIIs e ações dos EUA num painel só, com:

- **Gráficos profissionais** (velas, volume, médias 9/21/200, Bollinger, RSI, MACD) e preço **ao vivo** de cripto (WebSocket da Binance).
- **Sinais de compra e venda** com placar de −100 a +100, motivos em português, stop e alvo pela volatilidade (ATR)
  e **acerto histórico**: quantas vezes aquele mesmo sinal, naquele ativo, foi seguido de movimento a favor.
- **Backtest** de 5 estratégias com taxa, stop e alvo, comparando com "comprar e segurar".
- **Scanner** dos ativos mais negociados de cada mercado.
- **Radar de lançamentos**: moedas novas na Binance e ativos novos na B3, com aviso.
- **FIIs**: ranking por dividend yield de 12 meses, P/VP, liquidez e simulador de renda mensal.
- **Robôs** (simulado ou dinheiro real) com stop, alvo, perda máxima diária e "vender agora". A estratégia **Inteligente**
  identifica alta confirmada e compra; identifica queda e vende. Com **stop móvel**, o stop sobe junto com o preço e protege o lucro.
- **Alertas de preço** ("avise quando passar de X" ou "quando cair 5%"), conferidos a cada 20 segundos.
- **Copy trade**: o administrador publica estratégias e cada cliente as copia na própria corretora, com o próprio valor e stop.
- **Avisos** na plataforma e no **Telegram**.
- SaaS: cadastro com aprovação, planos (limite de robôs, dinheiro real, copy trade), cliente VIP, cobrança Asaas,
  2FA obrigatório, auditoria encadeada por hash, kill switch por cliente e **modo pânico** (congela todos os robôs).

> **Sobre "previsão" e "ganhos":** nenhuma ferramenta prevê o mercado com certeza. Os sinais são cálculos técnicos sobre o
> histórico e vêm sempre com a taxa de acerto passada para o investidor julgar. A plataforma mostra esse aviso em todas as telas.

## Planos e pagamento

| Plano | Preço | Libera |
|---|---|---|
| **Básico** | R$ 59,90/mês | gráficos, sinais, FIIs, lançamentos, 1 robô simulado, 3 alertas de preço |
| **Médio** | R$ 89,90/mês | + 5 robôs, dinheiro real, avisos no Telegram, 10 alertas de preço |
| **Top** | R$ 129,90/mês | + 20 robôs, copy trade, alertas de preço ilimitados |

O cliente se cadastra escolhendo o plano e paga por **PIX ou cartão** na página segura do Asaas (os dados do cartão nunca passam
pela plataforma). A conta é **liberada sozinha** quando o Asaas confirma o pagamento. Mensalidade vencida suspende; pagou, volta.
O cliente troca de plano e de forma de pagamento em **Assinatura**. Configure no Asaas o webhook
`https://SEU-SITE/webhooks/pagamentos/asaas` com o token de `ASAAS_WEBHOOK_TOKEN` (eventos de cobrança).

## Administrador

Um login só: o administrador entra pela mesma tela dos clientes e vê **tudo** — a plataforma de investimentos (com conta própria,
recursos do plano Top) e a área de **Administração**: visão geral, clientes (aprovar, liberar, VIP, bloquear, **excluir**),
estratégias de copy trade, carteiras, rastreamento e segurança. O endereço secreto antigo (`ADMIN_PATH`) continua funcionando.

## Carteira e transferência entre clientes

Cada cliente pode abrir uma carteira, que é uma **subconta no Asaas** (instituição de pagamento autorizada pelo Banco Central):
o dinheiro fica no Asaas, nunca no banco de dados da plataforma. Depósito por QR Code PIX, **transferência entre clientes**
(de subconta para subconta) e **saque para conta bancária** por PIX. Proteções em cada saída de dinheiro:

- código do autenticador **na hora** (confirmação em duas etapas por transação; 5 erros = 15 min sem transações);
- bloqueio por 24 h depois de entrar por aparelho novo ou trocar senha/2FA (conta invadida não consegue tirar dinheiro);
- limite por operação (`WALLET_TX_MAX_CENTS`, padrão R$ 5.000) e por dia (`WALLET_DAILY_MAX_CENTS`, padrão R$ 10.000);
- mais de 10 saídas em 1 hora bloqueia a carteira para análise;
- chave PIX de saque nova só vale depois de 24 h; e-mail a cada chave nova e a cada saque;
- o mesmo pedido nunca sai duas vezes (idempotência); o administrador bloqueia qualquer carteira na hora.

A conta principal do Asaas precisa ter a criação de subcontas liberada (fale com o gerente do Asaas).

## Segurança e rastreamento

- **Pagamento falso:** webhook só com token secreto; mesmo assim o pagamento é **reconsultado no Asaas**, e só libera se o valor
  for exatamente o preço do plano. Comprovante enviado por cliente nunca libera nada. Chargeback trava a conta.
- **Login falso e roubo de senha:** 2FA obrigatório; conta trava após 5 senhas erradas; **IP que testa senhas em várias contas é
  bloqueado por 1 hora**; senha que já vazou na internet é recusada (base Have I Been Pwned, consulta anônima); e-mail de alerta
  a cada acesso por aparelho novo; um cadastro por CPF (com validação); armadilha contra robôs no cadastro.
- **Site todo rastreado:** cada ação feita com sessão é registrada (usuário, IP, aparelho, caminho, resultado, tempo) e fica em
  Administração → Rastreamento por 180 dias, com alerta de contas usadas de muitos IPs. Auditoria encadeada por hash à parte.

## Segurança do dinheiro dos clientes

- O dinheiro **nunca passa pela plataforma**: cada cliente conecta a própria corretora com chave de API.
- Chaves da Binance **com permissão de saque são recusadas**. As chaves ficam cifradas (AES-256-GCM) e nunca voltam para a tela.
- Conectar corretora e ligar robô com dinheiro real pedem o código do autenticador (2FA recente).
- Ordem real que falha **não é repetida sozinha**: o robô para em "erro" e avisa (evita ordem duplicada).
- O robô decide só no candle **fechado** e entra uma vez por sinal. Atingiu a perda máxima do dia: pausa sozinho.

## Antes de vender para clientes (Brasil)

Vender sinais, recomendações, copy trade ou robô que opera a conta de terceiros é atividade regulada pela **CVM**
(analista — Resolução CVM 20; consultor — Res. 19; gestor/administrador de carteira — Res. 21). Opere comercialmente
com o registro adequado ou em parceria com um profissional credenciado, e revise os termos de uso com um advogado.
Para uso próprio, nada disso é necessário.

## Colocar no ar (Render)

O `render.yaml` cria API, Postgres e Redis. As migrações rodam sozinhas no deploy (a `011_investimentos.sql` cria as tabelas novas;
as tabelas da antiga agência ficam no banco, sem uso). Variáveis em **Environment**:

| Variável | Para quê |
|---|---|
| `BRAPI_TOKEN` | B3 e FIIs ([brapi.dev](https://brapi.dev)). Sem ele, só os ativos de teste (PETR4, VALE3, ITUB4, MGLU3). |
| `ALPACA_DATA_KEY` / `ALPACA_DATA_SECRET` | Ações dos EUA ([alpaca.markets](https://alpaca.markets), feed IEX gratuito). |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_BOT_NAME` | Avisos no Telegram (crie o bot no @BotFather). |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_PATH` | Primeiro administrador e endereço secreto do Painel Master. |
| `ASAAS_API_KEY` | Cobrança das assinaturas. |

**Região:** a Binance bloqueia servidores nos EUA. Gráficos e sinais de cripto usam `data-api.binance.vision` (funciona em qualquer
região), mas **robôs de cripto com dinheiro real** exigem o serviço em **Frankfurt ou Singapura**. No Render a região só é escolhida
na criação do serviço.

**B3 com dinheiro real:** as corretoras brasileiras não oferecem API de ordens aberta para pessoa física. Na B3, os robôs rodam no
simulado e os sinais servem para o cliente executar na própria corretora.

## Desenvolvimento e testes

```
docker compose up -d                       # Postgres + Redis
cd backend && npm install && npm run build && npm run migrate
node dist/bootstrap.js voce@email.com 'SenhaForte123'
npm run dev                                # API em :3000
cd ../frontend && npm install && npm run dev
```

- `npm test` (backend): indicadores (RSI conferido com a série de Wilder), placar, backtest, validação de códigos.
- `npm run e2e` (backend, precisa de Postgres e Redis): sobe a API de verdade contra uma **Binance, brapi e Telegram falsas**
  (`e2e/fake-apis.mjs`) e testa ponta a ponta: gráficos, scanner, FIIs, corretora (recusa chave com saque e chave inválida),
  robô simulado entrando no cruzamento e saindo no stop, robô real com ordem assinada, copy trade, radar, Telegram,
  limites de plano, isolamento entre clientes (RLS), modo pânico e kill switch.
- A CI (GitHub Actions) roda tudo isso e monta a imagem Docker a cada push.

## Estrutura

```
db/migrations/011_investimentos.sql  watchlist, corretoras, robôs, operações, alertas, radar (RLS por cliente)
backend/src/
  market/indicators.ts    EMA, SMA, RSI, MACD, Bollinger, ATR, Donchian (funções puras)
  market/strategies.ts    5 estratégias, placar com motivos, acerto histórico, backtest
  market/data.ts          Binance, brapi e Alpaca com cache no Redis
  market/radar.ts         scanner, lançamentos e avisos de mudança de sinal
  market/routes.ts        /api/market: gráfico, scanner, backtest, FIIs, lista, avisos, Telegram
  brokers/index.ts        Binance (spot, HMAC) e Alpaca: testar chave, comprar, vender
  bots/engine.ts          motor dos robôs e do copy trade (trava no Redis, uma instância por vez)
  bots/routes.ts          /api/bots: robôs, posições, copy trade, corretoras
  admin/routes.ts         clientes, planos, estratégias master, auditoria, modo pânico
  auth/                   login com 2FA (app autenticador), sessão revogável, step-up
frontend/src/invest/      Mercado, Gráfico, Sinais, Lançamentos, FIIs, Robôs, Copy trade, Corretoras, Avisos
```
