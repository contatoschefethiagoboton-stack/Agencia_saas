-- =====================================================================
-- 004_meta.sql — conexão com Instagram/Facebook/Meta Ads e publicação automática
-- =====================================================================

-- ---------- Conexões de canais: nome e dados para exibir no painel ----------
ALTER TABLE channel_connections
  ADD COLUMN name         text,
  ADD COLUMN meta         jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN connected_by uuid REFERENCES users(id),
  ADD COLUMN connected_at timestamptz NOT NULL DEFAULT now();
GRANT DELETE ON channel_connections TO app_user, app_service;

-- ---------- Publicação ----------
ALTER TABLE content_items DROP CONSTRAINT content_items_status_check;
ALTER TABLE content_items ADD CONSTRAINT content_items_status_check
  CHECK (status IN ('pending_approval','changes_requested','approved','publishing','rejected','published','failed'));
ALTER TABLE content_items
  ADD COLUMN external_id  text,           -- id do post na rede social
  ADD COLUMN permalink    text,
  ADD COLUMN error        text,
  ADD COLUMN published_at timestamptz,
  ADD COLUMN attempts     int NOT NULL DEFAULT 0,
  ADD COLUMN publishing_since timestamptz;
CREATE INDEX ON content_items (status, scheduled_for);

-- Funções que precisam enxergar vários tenants ligam app.bypass_rls SÓ durante a própria execução
-- e restauram o valor anterior (não vaza para o resto da transação de quem chamou).
-- (Postgres gerenciado não permite "SET app.bypass_rls" na definição da função; por isso set_config.)

-- O publicador pega itens de vários tenants: função dedicada que trava e devolve um lote.
-- Só canais com publicação automática; roteiros de vídeo são gravados pelo cliente.
CREATE FUNCTION content_claim_due(p_limit int) RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE prev text := current_setting('app.bypass_rls', true);
BEGIN
  PERFORM set_config('app.bypass_rls', 'on', true);
  -- travado em "publishing" há mais de 15 min (processo caiu no meio): marca falha, nunca republica sozinho
  UPDATE content_items SET status = 'failed', error = 'Publicação interrompida; confira na rede antes de tentar de novo'
   WHERE status = 'publishing' AND publishing_since < now() - interval '15 minutes';
  RETURN QUERY
  UPDATE content_items ci SET status = 'publishing', attempts = ci.attempts + 1, publishing_since = now()
   WHERE ci.id IN (SELECT c.id FROM content_items c JOIN tenants t ON t.id = c.tenant_id
                    WHERE c.status = 'approved' AND c.scheduled_for <= now() AND t.status = 'active'
                      AND c.channel IN ('instagram', 'facebook') AND c.kind IN ('post', 'carousel', 'story')
                    ORDER BY c.scheduled_for LIMIT p_limit FOR UPDATE OF c SKIP LOCKED)
  RETURNING ci.id, ci.tenant_id;
  PERFORM set_config('app.bypass_rls', coalesce(prev, ''), true);
END $$;
REVOKE ALL ON FUNCTION content_claim_due(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION content_claim_due(int) TO app_service;

-- ---------- Correção: funções SECURITY DEFINER do WhatsApp ----------
-- Elas rodam como dono das tabelas, e o RLS forçado vale para o dono também: sem isto, no Render
-- (sem superusuário) o webhook não acha o número e a fila de envio volta sempre vazia.
CREATE OR REPLACE FUNCTION wa_resolve_number(p_phone_number_id text, p_phone_e164 text DEFAULT NULL)
RETURNS TABLE (number_id uuid, tenant_id uuid, provider text, status text)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE prev text := current_setting('app.bypass_rls', true);
BEGIN
  PERFORM set_config('app.bypass_rls', 'on', true);
  RETURN QUERY SELECT n.id, n.tenant_id, n.provider, n.status FROM wa_numbers n
   WHERE (p_phone_number_id IS NOT NULL AND n.phone_number_id = p_phone_number_id)
      OR (p_phone_e164 IS NOT NULL AND n.phone_e164 = p_phone_e164)
   LIMIT 1;
  PERFORM set_config('app.bypass_rls', coalesce(prev, ''), true);
END $$;

CREATE OR REPLACE FUNCTION wa_claim_outbox(p_limit int)
RETURNS SETOF wa_outbox LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE prev text := current_setting('app.bypass_rls', true);
BEGIN
  PERFORM set_config('app.bypass_rls', 'on', true);
  RETURN QUERY UPDATE wa_outbox o SET status = 'sending', attempts = o.attempts + 1
   WHERE o.id IN (SELECT x.id FROM wa_outbox x
                   WHERE x.status = 'pending' AND x.not_before <= now()
                   ORDER BY x.priority, x.id LIMIT p_limit FOR UPDATE SKIP LOCKED)
  RETURNING o.*;
  PERFORM set_config('app.bypass_rls', coalesce(prev, ''), true);
END $$;

CREATE OR REPLACE FUNCTION wa_pause_waba(p_waba text) RETURNS TABLE (number_id uuid, tenant_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE prev text := current_setting('app.bypass_rls', true);
BEGIN
  PERFORM set_config('app.bypass_rls', 'on', true);
  RETURN QUERY UPDATE wa_numbers n SET status = 'paused' WHERE n.waba_id = p_waba AND n.status <> 'disabled'
  RETURNING n.id, n.tenant_id;
  PERFORM set_config('app.bypass_rls', coalesce(prev, ''), true);
END $$;

-- ---------- Correção: políticas de RLS com app.tenant_id vazio ----------
-- Depois que uma conexão do pool usou set_config('app.tenant_id', ..., true), o valor fora da
-- transação vira '' (e não NULL). A política fazia ''::uuid e a consulta inteira quebrava
-- (ex.: webhook do WhatsApp numa conexão reaproveitada). Com nullif, sem tenant = não enxerga nada.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['business_dossier','channel_connections','content_items','ad_campaigns','api_usage',
                           'wa_numbers','wa_contacts','wa_conversations','wa_messages','wa_outbox'] LOOP
    EXECUTE format('DROP POLICY tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
DROP POLICY own_tenant ON tenants;
CREATE POLICY own_tenant ON tenants FOR SELECT TO app_user, app_service
  USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid);
