# Status da plataforma — o que está pronto e o que falta

Legenda: ✅ pronto e testado · 🟡 pronto no código, depende de chave/configuração externa · ⛔ não existe API oficial

## Acesso

- **Clientes** entram pelo endereço principal. O **administrador** entra pelo endereço secreto definido em
  Render → Environment → `ADMIN_PATH` (sem ele, `/admin`). O endereço aparece no log ao subir (`[config] Login do administrador: …`).
- Não existe senha padrão: você define `ADMIN_EMAIL` e `ADMIN_PASSWORD`. O 2FA é por **aplicativo autenticador**
  (QR Code no primeiro login). O código por WhatsApp foi desligado junto com a antiga agência.
- Esqueceu a senha do administrador ou perdeu o celular: `ADMIN_PASSWORD` nova + `ADMIN_RESET=1` e deploy.
- Clientes: "Esqueci minha senha" (precisa de `SMTP_*`). Perdeu o 2FA: Painel Master → Clientes → Resetar acesso.

## Módulos

| Módulo | Status | Observação |
|---|---|---|
| Gráficos (velas, volume, médias, Bollinger, RSI, MACD) | ✅ | lightweight-charts; cripto ao vivo pelo WebSocket público da Binance |
| Cripto (Binance) | ✅ | dados públicos, sem chave |
| B3 e FIIs (brapi) | 🟡 | `BRAPI_TOKEN` para todos os ativos; plano gratuito tem limites de consulta e de histórico intradiário |
| Ações dos EUA (Alpaca) | 🟡 | `ALPACA_DATA_KEY/SECRET` (gratuito, feed IEX) |
| Sinais, placar, acerto histórico, stop/alvo | ✅ | último candle fechado; scanner a cada 4 min |
| Backtest (5 estratégias) | ✅ | taxa 0,1% por ponta, entrada no candle seguinte, stop com gap |
| Radar de lançamentos | ✅ | Binance e B3 a cada 5 min; 1ª volta só memoriza a lista |
| FIIs: ranking e simulador de renda | ✅ | DY 12m, P/VP (quando a brapi informa), liquidez |
| Robôs simulados | ✅ | todos os mercados |
| Robôs com dinheiro real — cripto | 🟡 | Binance spot; **servidor em Frankfurt ou Singapura** (a Binance bloqueia EUA) |
| Robôs com dinheiro real — EUA | 🟡 | Alpaca (conta real ou de papel); só no horário do pregão |
| Robôs com dinheiro real — B3 | ⛔ | corretoras brasileiras não liberam API de ordens para pessoa física |
| Copy trade | ✅ | estratégias master da plataforma; cliente copia com valor, stop e corretora próprios |
| Avisos (plataforma + Telegram) | 🟡 | Telegram precisa de `TELEGRAM_BOT_TOKEN` |
| Planos, aprovação de cadastro, VIP, cobrança Asaas | ✅ / 🟡 | cobrança precisa de `ASAAS_API_KEY` |
| Segurança: 2FA, auditoria, kill switch, modo pânico | ✅ | modo pânico congela todos os robôs |

## Próximos passos sugeridos

1. **Regulatório:** registro na CVM ou parceria com analista/consultor credenciado antes de vender sinais e copy trade;
   termos de uso e política de privacidade revisados por advogado.
2. **Região do servidor:** se for oferecer robôs de cripto com dinheiro real, crie o serviço do Render em Frankfurt.
3. **Mais corretoras de cripto** (Bybit, OKX, Mercado Bitcoin) seguindo o mesmo contrato de `backend/src/brokers/index.ts`.
4. **B3 com ordens reais:** integração via MetaTrader 5 da corretora (exige um terminal rodando no Windows do cliente ou VPS).
5. **Notícias e agenda de dividendos** no painel, e alertas de preço definidos pelo cliente.
6. **Página pública de planos** com assinatura direta (hoje o cliente se cadastra e o administrador aprova).
