-- =====================================================================
-- 001_core.sql — Núcleo multi-tenant com RLS, ledger e auditoria imutável
-- Papéis de banco:
--   app_user    -> API do cliente (sempre sob RLS, nunca BYPASSRLS)
--   app_service -> workers financeiros/integrações (acesso ao ledger)
--   app_admin   -> Painel Master (BYPASSRLS, só via API admin com 2FA)
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE ROLE app_user NOLOGIN;
  CREATE ROLE app_service NOLOGIN;
  CREATE ROLE app_admin NOLOGIN BYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- Tenants e usuários ----------
CREATE TABLE tenants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  slug           text UNIQUE NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','killed')),
  plan           text NOT NULL DEFAULT 'starter',
  media_fee_bps  int  NOT NULL DEFAULT 1500 CHECK (media_fee_bps BETWEEN 0 AND 5000), -- 15,00%
  geo_lat        numeric(9,6),
  geo_lng        numeric(9,6),
  geo_radius_km  int DEFAULT 5,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid REFERENCES tenants(id),           -- NULL = admin da plataforma
  email           text UNIQUE NOT NULL,
  password_hash   text NOT NULL,                          -- argon2id
  phone_e164      text NOT NULL,                          -- destino do OTP
  role            text NOT NULL CHECK (role IN ('owner','member','platform_admin')),
  token_version   int  NOT NULL DEFAULT 0,                -- incrementar = derruba todas as sessões
  failed_logins   int  NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE known_devices (
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  device_hash text NOT NULL,                              -- hash(User-Agent + faixa /24 do IP)
  first_seen  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_hash)
);

CREATE TABLE otp_challenges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   text NOT NULL,                              -- HMAC(pepper, código), nunca o código
  purpose     text NOT NULL CHECK (purpose IN ('login','withdrawal','pix_key_change')),
  attempts    int  NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

-- ---------- Negócio do cliente ----------
CREATE TABLE business_dossier (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id),
  data       jsonb NOT NULL,          -- tom de voz, produtos, horários, mídias, público
  version    int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE channel_connections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  provider      text NOT NULL CHECK (provider IN ('instagram','facebook','tiktok','google_business',
                                                  'google_ads','meta_ads','whatsapp')),
  external_id   text NOT NULL,        -- ex.: ad_account_id, page_id, phone_number_id
  token_cipher  bytea NOT NULL,       -- token OAuth cifrado (AES-256-GCM no app)
  expires_at    timestamptz,
  UNIQUE (tenant_id, provider, external_id)
);

CREATE TABLE content_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  channel       text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('post','carousel','reel_script','story','ad','gbp_post')),
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending_approval'
                CHECK (status IN ('pending_approval','approved','rejected','published','failed')),
  scheduled_for timestamptz,
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ad_campaigns (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  platform              text NOT NULL CHECK (platform IN ('meta','google')),
  monthly_budget_cents  bigint NOT NULL CHECK (monthly_budget_cents > 0),
  external_campaign_id  text,
  status                text NOT NULL DEFAULT 'paused',  -- nasce pausada; só ativa após aprovação
  is_agency_own         boolean NOT NULL DEFAULT false   -- campanha de auto-captação da agência
);

CREATE TABLE api_usage (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  provider    text NOT NULL,
  period      date NOT NULL,          -- primeiro dia do mês
  cost_cents  bigint NOT NULL DEFAULT 0,
  quota_cents bigint NOT NULL DEFAULT 5000,
  PRIMARY KEY (tenant_id, provider, period)
);

-- ---------- RLS: isolamento por tenant ----------
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['business_dossier','channel_connections','content_items','ad_campaigns','api_usage'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO app_user, app_service', t);
  END LOOP;
END $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_tenant ON tenants FOR SELECT TO app_user, app_service
  USING (id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT ON tenants TO app_user, app_service;

-- ---------- Financeiro: ledger de partidas dobradas ----------
CREATE TABLE fin_accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('gateway_clearing','tenant_media_wallet','platform_profit',
                                           'agency_media_fund','withdrawals_pending','api_costs')),
  tenant_id  uuid REFERENCES tenants(id),
  UNIQUE NULLS NOT DISTINCT (kind, tenant_id)          -- PostgreSQL 15+
);

CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  gateway             text NOT NULL CHECK (gateway IN ('asaas','mercadopago')),
  gateway_payment_id  text NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('subscription','setup','media_budget','a_la_carte')),
  amount_cents        bigint NOT NULL CHECK (amount_cents > 0),
  status              text NOT NULL DEFAULT 'pending',
  confirmed_at        timestamptz,
  UNIQUE (gateway, gateway_payment_id)
);

CREATE TABLE webhook_events (           -- idempotência: o mesmo evento nunca é processado 2x
  gateway     text NOT NULL,
  event_id    text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (gateway, event_id)
);

CREATE TABLE ledger_entries (
  id            bigserial PRIMARY KEY,
  txn_id        uuid NOT NULL,
  account_id    uuid NOT NULL REFERENCES fin_accounts(id),
  amount_cents  bigint NOT NULL,          -- positivo = crédito no saldo da conta
  memo          text,
  ref_payment   uuid REFERENCES payments(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ledger_entries (account_id);
CREATE INDEX ON ledger_entries (txn_id);

-- Toda transação precisa somar zero (checado no COMMIT)
CREATE FUNCTION check_txn_balanced() RETURNS trigger AS $$
BEGIN
  IF (SELECT COALESCE(SUM(amount_cents),0) FROM ledger_entries WHERE txn_id = NEW.txn_id) <> 0 THEN
    RAISE EXCEPTION 'Transação % desbalanceada', NEW.txn_id;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_txn_balanced();

CREATE TABLE pix_keys (                 -- chave de saque do admin; troca exige OTP + carência
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_value   text NOT NULL,
  key_type    text NOT NULL CHECK (key_type IN ('CPF','CNPJ','EMAIL','PHONE','EVP')),
  active_from timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  created_by  uuid NOT NULL REFERENCES users(id)
);

CREATE TABLE withdrawals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amount_cents        bigint NOT NULL CHECK (amount_cents > 0),
  pix_key_id          uuid NOT NULL REFERENCES pix_keys(id),
  status              text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','sent','failed')),
  requested_by        uuid NOT NULL REFERENCES users(id),
  gateway_transfer_id text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON fin_accounts, payments, webhook_events, ledger_entries, withdrawals, pix_keys TO app_service;
GRANT UPDATE (status, confirmed_at) ON payments TO app_service;
GRANT UPDATE (status, gateway_transfer_id) ON withdrawals TO app_service;
GRANT USAGE ON SEQUENCE ledger_entries_id_seq TO app_service;

-- ---------- Auditoria imutável com cadeia de hash ----------
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor_id   uuid,
  tenant_id  uuid,
  ip         inet,
  action     text NOT NULL,
  target     text,
  meta       jsonb NOT NULL DEFAULT '{}',
  prev_hash  bytea,
  hash       bytea
);

CREATE FUNCTION audit_chain() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit_log'));   -- serializa a cadeia
  SELECT hash INTO NEW.prev_hash FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.hash := digest(
    coalesce(encode(NEW.prev_hash,'hex'),'') || NEW.at::text || coalesce(NEW.actor_id::text,'') ||
    coalesce(NEW.tenant_id::text,'') || coalesce(host(NEW.ip),'') || NEW.action ||
    coalesce(NEW.target,'') || NEW.meta::text, 'sha256');
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER;
CREATE TRIGGER audit_chain_t BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_chain();

CREATE FUNCTION block_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Tabela % é somente-inserção', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_immutable  BEFORE UPDATE OR DELETE ON audit_log      FOR EACH ROW EXECUTE FUNCTION block_mutation();
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION block_mutation();
REVOKE TRUNCATE ON audit_log, ledger_entries FROM PUBLIC;

GRANT INSERT ON audit_log TO app_user, app_service, app_admin;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO app_user, app_service, app_admin;
GRANT SELECT ON audit_log TO app_admin;

-- Para garantia extra: exporte o último hash diariamente para um storage WORM
-- (ex.: S3 Object Lock). Se alguém com superusuário alterar o banco, a cadeia não fecha.
