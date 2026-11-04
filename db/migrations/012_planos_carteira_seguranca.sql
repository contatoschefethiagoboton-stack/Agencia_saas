-- =====================================================================
-- 012 — Planos Básico/Médio/Top com pagamento (PIX ou cartão), acesso unificado do administrador,
--       exclusão de clientes, carteira (subcontas Asaas), alertas de preço, rastreamento e robô com stop móvel.
-- =====================================================================

-- ---------- Planos ----------
ALTER TABLE plans
  ADD COLUMN telegram     boolean NOT NULL DEFAULT false,
  ADD COLUMN price_alerts int     NOT NULL DEFAULT 3;          -- -1 = ilimitado
INSERT INTO plans (id, name, price_cents, setup_cents, max_bots, live_trading, copy_trade, telegram, price_alerts, description, active) VALUES
  ('basico', 'Básico', 5990,  0, 1,  false, false, false, 3,  'Gráficos, sinais, FIIs, lançamentos e 1 robô simulado', true),
  ('medio',  'Médio',  8990,  0, 5,  true,  false, true,  10, '5 robôs com dinheiro real e avisos no Telegram', true),
  ('top',    'Top',    12990, 0, 20, true,  true,  true,  -1, '20 robôs, copy trade e alertas de preço ilimitados', true)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, price_cents = EXCLUDED.price_cents, max_bots = EXCLUDED.max_bots,
  live_trading = EXCLUDED.live_trading, copy_trade = EXCLUDED.copy_trade, telegram = EXCLUDED.telegram,
  price_alerts = EXCLUDED.price_alerts, description = EXCLUDED.description, active = true;
UPDATE tenants SET plan = CASE plan WHEN 'starter' THEN 'basico' WHEN 'pro' THEN 'medio' WHEN 'premium' THEN 'top' ELSE plan END
 WHERE plan IN ('starter', 'pro', 'premium');
UPDATE plans SET active = false WHERE id IN ('starter', 'pro', 'premium');

-- ---------- Clientes: aguardando pagamento, excluído e conta da própria plataforma ----------
ALTER TABLE tenants DROP CONSTRAINT tenants_status_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_status_check
  CHECK (status IN ('pending', 'awaiting_payment', 'active', 'suspended', 'killed', 'rejected', 'deleted'));
ALTER TABLE tenants
  ADD COLUMN is_platform  boolean NOT NULL DEFAULT false,      -- conta de investimentos do próprio administrador
  ADD COLUMN billing_type text CHECK (billing_type IN ('PIX', 'CREDIT_CARD')),
  ADD COLUMN pay_url      text,                                 -- página de pagamento do Asaas (PIX ou cartão)
  ADD COLUMN deleted_at   timestamptz;
CREATE INDEX tenants_document ON tenants (regexp_replace(document, '\D', '', 'g')) WHERE document IS NOT NULL;   -- antifraude: um cadastro por CPF (regra no cadastro)

-- ---------- Robôs: stop móvel (acompanha a alta e vende na queda) ----------
ALTER TABLE bots ADD COLUMN trailing_stop_pct numeric(6, 2) CHECK (trailing_stop_pct IS NULL OR trailing_stop_pct BETWEEN 0.1 AND 50);

-- ---------- Alertas de preço ----------
CREATE TABLE price_alerts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  market       text NOT NULL CHECK (market IN ('crypto', 'b3', 'us')),
  symbol       text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('above', 'below', 'up_pct', 'down_pct')),
  value        numeric(28, 10) NOT NULL CHECK (value > 0),
  base_price   numeric(28, 10) NOT NULL,                       -- preço na criação (referência dos alertas em %)
  note         text,
  active       boolean NOT NULL DEFAULT true,
  triggered_at timestamptz,
  triggered_price numeric(28, 10),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX price_alerts_active ON price_alerts (market, symbol) WHERE active;

-- ---------- Rastreamento de acesso (toda chamada autenticada) ----------
CREATE TABLE access_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  user_id    uuid,
  tenant_id  uuid,
  impersonating boolean NOT NULL DEFAULT false,
  ip         inet,
  method     text NOT NULL,
  path       text NOT NULL,
  status     int NOT NULL,
  ms         int NOT NULL,
  ua         text
);
CREATE INDEX access_log_at ON access_log (at DESC);
CREATE INDEX access_log_tenant ON access_log (tenant_id, at DESC);
CREATE INDEX access_log_ip ON access_log (ip, at DESC);

-- ---------- Carteira: subconta Asaas por cliente (o dinheiro fica no Asaas, nunca no nosso banco) ----------
CREATE TABLE wallet_accounts (
  tenant_id        uuid PRIMARY KEY REFERENCES tenants(id),
  asaas_account_id text NOT NULL UNIQUE,
  wallet_id        text NOT NULL UNIQUE,
  api_key_cipher   bytea NOT NULL,                          -- chave da subconta (AES-256-GCM)
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'blocked')),
  blocked_reason   text,
  pix_key          text,                                    -- chave aleatória (EVP) para depósitos
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wallet_payout_keys (                         -- destino de saque: só vale 24 h depois de cadastrado
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  key_type    text NOT NULL CHECK (key_type IN ('CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP')),
  key_value   text NOT NULL,
  active_from timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  removed_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wallet_txs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  kind                text NOT NULL CHECK (kind IN ('saque', 'envio', 'recebimento')),
  amount_cents        bigint NOT NULL CHECK (amount_cents > 0),
  counterparty_tenant uuid REFERENCES tenants(id),
  payout_key_id       uuid REFERENCES wallet_payout_keys(id),
  pair_id             uuid,                                   -- envio <-> recebimento
  external_id         text,                                   -- id da transferência no Asaas
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed', 'blocked')),
  description         text,
  idempotency_key     text,
  ip                  inet,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX wallet_txs_tenant ON wallet_txs (tenant_id, created_at DESC);

-- ---------- RLS ----------
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['price_alerts', 'wallet_accounts', 'wallet_payout_keys', 'wallet_txs'] LOOP
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
GRANT INSERT ON access_log TO app_user, app_service;
GRANT USAGE ON SEQUENCE access_log_id_seq TO app_user, app_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_admin;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_admin;
