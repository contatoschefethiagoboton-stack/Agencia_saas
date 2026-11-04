-- =====================================================================
-- 011 — Plataforma de investimentos: corretoras, robôs, copy trade, alertas e radar de lançamentos.
-- As tabelas da antiga agência continuam no banco (dados preservados), mas não são mais usadas.
-- =====================================================================

-- ---------- Planos: limites da plataforma de investimentos ----------
ALTER TABLE plans
  ADD COLUMN max_bots       int     NOT NULL DEFAULT 1,
  ADD COLUMN live_trading   boolean NOT NULL DEFAULT false,   -- robô com dinheiro real (sem isso, só simulado)
  ADD COLUMN copy_trade     boolean NOT NULL DEFAULT false,
  ADD COLUMN description    text;
UPDATE plans SET max_bots = 1,  live_trading = false, copy_trade = false, description = 'Gráficos, sinais, radar e 1 robô simulado' WHERE id = 'starter';
UPDATE plans SET max_bots = 5,  live_trading = true,  copy_trade = true,  description = '5 robôs, dinheiro real e copy trade'      WHERE id = 'pro';
UPDATE plans SET max_bots = 20, live_trading = true,  copy_trade = true,  description = '20 robôs, dinheiro real e copy trade'     WHERE id = 'premium';

-- ---------- Lista de acompanhamento (watchlist) ----------
CREATE TABLE watchlist (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  market     text NOT NULL CHECK (market IN ('crypto', 'b3', 'us')),
  symbol     text NOT NULL,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, market, symbol)
);

-- ---------- Corretoras conectadas (chaves de API cifradas, só negociação, nunca saque) ----------
CREATE TABLE broker_connections (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  broker         text NOT NULL CHECK (broker IN ('binance', 'alpaca')),
  label          text NOT NULL,
  key_cipher     bytea NOT NULL,                 -- API key (AES-256-GCM)
  secret_cipher  bytea NOT NULL,                 -- API secret (AES-256-GCM)
  key_hint       text NOT NULL,                  -- últimos 4 caracteres, para o cliente reconhecer
  paper          boolean NOT NULL DEFAULT false, -- Alpaca: conta de papel (simulada da própria corretora)
  status         text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
  last_error     text,
  checked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------- Robôs ----------
-- tenant_id NULL + is_master = estratégia da plataforma que os clientes podem copiar (copy trade).
CREATE TABLE bots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid REFERENCES tenants(id) ON DELETE CASCADE,
  name               text NOT NULL,
  market             text NOT NULL CHECK (market IN ('crypto', 'b3', 'us')),
  symbol             text NOT NULL,
  interval           text NOT NULL CHECK (interval IN ('5m', '15m', '1h', '4h', '1d')),
  strategy           text NOT NULL,
  mode               text NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper', 'live')),
  connection_id      uuid REFERENCES broker_connections(id) ON DELETE SET NULL,
  amount             numeric(20, 8) NOT NULL CHECK (amount > 0),   -- valor por operação (na moeda de cotação)
  stop_loss_pct      numeric(6, 2)  CHECK (stop_loss_pct  IS NULL OR stop_loss_pct  BETWEEN 0.1 AND 50),
  take_profit_pct    numeric(6, 2)  CHECK (take_profit_pct IS NULL OR take_profit_pct BETWEEN 0.1 AND 500),
  max_daily_loss     numeric(20, 8) CHECK (max_daily_loss IS NULL OR max_daily_loss > 0),
  status             text NOT NULL DEFAULT 'paused' CHECK (status IN ('active', 'paused', 'error')),
  status_reason      text,
  is_master          boolean NOT NULL DEFAULT false,
  public_description text,                                         -- texto da estratégia no catálogo de copy trade
  copy_of            uuid REFERENCES bots(id) ON DELETE SET NULL,  -- robô seguidor de uma estratégia master
  last_signal_at     timestamptz,                                  -- candle que já gerou entrada (não repete)
  last_tick_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (is_master = (tenant_id IS NULL)),
  CHECK (NOT (is_master AND copy_of IS NOT NULL))
);
CREATE INDEX bots_active ON bots (status) WHERE status = 'active';
CREATE INDEX bots_copy_of ON bots (copy_of) WHERE copy_of IS NOT NULL;

-- ---------- Operações (uma linha por posição: abre e fecha) ----------
CREATE TABLE bot_trades (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id        uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  tenant_id     uuid REFERENCES tenants(id) ON DELETE CASCADE,
  mode          text NOT NULL CHECK (mode IN ('paper', 'live')),
  symbol        text NOT NULL,
  qty           numeric(28, 10) NOT NULL CHECK (qty > 0),
  entry_price   numeric(28, 10) NOT NULL,
  entry_at      timestamptz NOT NULL DEFAULT now(),
  entry_order   text,                               -- id da ordem na corretora
  stop_price    numeric(28, 10),
  target_price  numeric(28, 10),
  exit_price    numeric(28, 10),
  exit_at       timestamptz,
  exit_order    text,
  exit_reason   text CHECK (exit_reason IN ('sinal', 'stop', 'alvo', 'copia', 'manual', 'perda_diaria')),
  fees          numeric(28, 10) NOT NULL DEFAULT 0,
  pnl           numeric(28, 10),                    -- resultado líquido (moeda de cotação)
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed'))
);
CREATE UNIQUE INDEX bot_trades_one_open ON bot_trades (bot_id) WHERE status = 'open';   -- nunca duas posições no mesmo robô
CREATE INDEX bot_trades_bot ON bot_trades (bot_id, entry_at DESC);

-- ---------- Alertas (sinais, robôs, lançamentos) ----------
CREATE TABLE alerts (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid REFERENCES tenants(id) ON DELETE CASCADE,   -- NULL = alerta para todos (ex.: nova moeda listada)
  kind       text NOT NULL CHECK (kind IN ('sinal', 'robo', 'lancamento', 'sistema')),
  title      text NOT NULL,
  body       text,
  market     text,
  symbol     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alerts_recent ON alerts (created_at DESC);

CREATE TABLE alert_reads (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  last_read  bigint NOT NULL DEFAULT 0
);

-- Preferências de aviso do cliente (Telegram)
CREATE TABLE notify_settings (
  tenant_id         uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  telegram_chat_id  text,
  on_signals        boolean NOT NULL DEFAULT true,
  on_bots           boolean NOT NULL DEFAULT true,
  on_listings       boolean NOT NULL DEFAULT true
);

-- ---------- Radar de lançamentos: ativos já vistos em cada mercado ----------
CREATE TABLE known_symbols (
  market     text NOT NULL,
  symbol     text NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (market, symbol)
);

-- ---------- RLS ----------
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['watchlist', 'broker_connections', 'notify_settings', 'alert_reads'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY admin_bypass ON %I
      USING (current_setting('app.bypass_rls', true) = 'on')
      WITH CHECK (current_setting('app.bypass_rls', true) = 'on')$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user, app_service', t);
  END LOOP;
END $$;

-- Robôs e operações: o cliente enxerga os próprios e as estratégias master (somente leitura)
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['bots', 'bot_trades'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_rw ON %I
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY master_read ON %I FOR SELECT USING (tenant_id IS NULL)$p$, t);
    EXECUTE format($p$CREATE POLICY admin_bypass ON %I
      USING (current_setting('app.bypass_rls', true) = 'on')
      WITH CHECK (current_setting('app.bypass_rls', true) = 'on')$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user, app_service', t);
  END LOOP;
END $$;

-- Alertas: o cliente lê os dele e os gerais
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON alerts FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY admin_bypass ON alerts
  USING (current_setting('app.bypass_rls', true) = 'on') WITH CHECK (current_setting('app.bypass_rls', true) = 'on');
GRANT SELECT ON alerts TO app_user;
GRANT SELECT, INSERT ON alerts TO app_service;
GRANT USAGE ON SEQUENCE alerts_id_seq TO app_service, app_admin;

GRANT SELECT ON known_symbols TO app_user;
GRANT SELECT, INSERT ON known_symbols TO app_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_admin;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_admin;
