-- =====================================================================
-- 003_operacao.sql — o que faltava para operar de verdade
--   * planos (tiers) com cota de IA
--   * 2FA por aplicativo autenticador (TOTP), além do código por WhatsApp
--   * fila de aprovação com "pedir ajuste"
--   * cobrança recorrente (cliente no gateway) e antifraude (chargeback)
--   * Painel Master enxergando todos os tenants sem BYPASSRLS
--   * permissões que faltavam para quem usa os três usuários separados
-- =====================================================================

-- ---------- Planos ----------
CREATE TABLE plans (
  id              text PRIMARY KEY,                 -- 'starter', 'pro', ...
  name            text NOT NULL,
  price_cents     bigint NOT NULL CHECK (price_cents >= 0),
  setup_cents     bigint NOT NULL DEFAULT 0 CHECK (setup_cents >= 0),
  ai_quota_cents  bigint NOT NULL DEFAULT 5000,     -- teto mensal de IA por cliente
  wa_numbers_max  int    NOT NULL DEFAULT 1,
  posts_per_month int    NOT NULL DEFAULT 28,
  active          boolean NOT NULL DEFAULT true
);
INSERT INTO plans (id, name, price_cents, setup_cents, ai_quota_cents, wa_numbers_max, posts_per_month) VALUES
  ('starter',   'Essencial', 49700,  0,     5000,  1, 20),
  ('pro',       'Pro',       79700,  29700, 12000, 2, 28),
  ('premium',   'Premium',   149700, 49700, 30000, 5, 40)
ON CONFLICT (id) DO NOTHING;

-- ---------- Tenants: cobrança, contato e antifraude ----------
ALTER TABLE tenants
  ADD COLUMN niche               text,              -- restaurante, clínica, barbearia, influenciador...
  ADD COLUMN city                text,
  ADD COLUMN document            text,              -- CPF/CNPJ (exigido pelo gateway)
  ADD COLUMN asaas_customer_id   text UNIQUE,
  ADD COLUMN asaas_subscription_id text UNIQUE,
  ADD COLUMN suspended_reason    text;

-- ---------- Usuários: 2FA por aplicativo ----------
ALTER TABLE users
  ADD COLUMN name               text,
  ADD COLUMN totp_secret_cipher bytea,              -- segredo TOTP cifrado (AES-256-GCM no app)
  ADD COLUMN totp_enabled       boolean NOT NULL DEFAULT false,
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
  ALTER COLUMN phone_e164 DROP NOT NULL;            -- com TOTP, o telefone é opcional

-- ---------- Conteúdo: pedir ajuste ----------
ALTER TABLE content_items DROP CONSTRAINT content_items_status_check;
ALTER TABLE content_items ADD CONSTRAINT content_items_status_check
  CHECK (status IN ('pending_approval','changes_requested','approved','rejected','published','failed'));
ALTER TABLE content_items ADD COLUMN feedback text, ADD COLUMN revision int NOT NULL DEFAULT 0;
CREATE INDEX ON content_items (tenant_id, status, scheduled_for);

-- ---------- Pagamentos: chargeback ----------
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('pending','confirmed','refunded','chargeback','failed'));

-- ---------- Painel Master: leitura entre tenants sem BYPASSRLS ----------
-- withAdmin() liga app.bypass_rls só dentro da transação do admin (rotas com requireAdmin).
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['business_dossier','channel_connections','content_items','ad_campaigns','api_usage',
                           'wa_numbers','wa_contacts','wa_conversations','wa_messages','wa_outbox'] LOOP
    EXECUTE format($p$CREATE POLICY admin_bypass ON %I
      USING (current_setting('app.bypass_rls', true) = 'on')
      WITH CHECK (current_setting('app.bypass_rls', true) = 'on')$p$, t);
  END LOOP;
END $$;
CREATE POLICY admin_bypass ON tenants USING (current_setting('app.bypass_rls', true) = 'on');

-- ---------- Permissões que faltavam (instalações com três usuários separados) ----------
GRANT SELECT ON plans TO app_user, app_service, app_admin;
GRANT SELECT, UPDATE ON users TO app_user;
GRANT SELECT, INSERT, UPDATE ON known_devices, otp_challenges TO app_user, app_admin;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app_admin;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_admin;
