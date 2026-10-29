-- =====================================================================
-- 006 — campanhas Meta Ads pelo painel, Google Meu Negócio e fotos por IA
-- =====================================================================

-- ---------- Campanhas: rascunho -> criada pausada na Meta -> aprovada -> ativa ----------
ALTER TABLE ad_campaigns
  ADD COLUMN name             text,
  ADD COLUMN objective        text CHECK (objective IN ('trafego', 'alcance')),
  ADD COLUMN radius_km        int CHECK (radius_km BETWEEN 1 AND 80),
  ADD COLUMN lat              numeric(9,6),
  ADD COLUMN lng              numeric(9,6),
  ADD COLUMN link             text,
  ADD COLUMN message          text,
  ADD COLUMN headline         text,
  ADD COLUMN media_id         uuid REFERENCES media(id) ON DELETE SET NULL,
  ADD COLUMN content_item_id  uuid REFERENCES content_items(id) ON DELETE SET NULL,
  ADD COLUMN external_adset_id text,
  ADD COLUMN external_ad_id   text,
  ADD COLUMN external_creative_id text,
  ADD COLUMN projection       jsonb,
  ADD COLUMN spend_cents_month bigint NOT NULL DEFAULT 0,
  ADD COLUMN spend_checked_at timestamptz,
  ADD COLUMN error            text,
  ADD COLUMN created_by       uuid REFERENCES users(id),
  ADD COLUMN approved_by      uuid REFERENCES users(id),
  ADD COLUMN approved_at      timestamptz,
  ADD COLUMN created_at       timestamptz NOT NULL DEFAULT now();
UPDATE ad_campaigns SET status = 'paused' WHERE status NOT IN ('draft','pending_approval','active','paused','failed','ended');
ALTER TABLE ad_campaigns ALTER COLUMN status SET DEFAULT 'draft';
ALTER TABLE ad_campaigns ADD CONSTRAINT ad_campaigns_status_check
  CHECK (status IN ('draft', 'pending_approval', 'active', 'paused', 'failed', 'ended'));
GRANT DELETE ON ad_campaigns TO app_user, app_service;

-- O vigia de verba percorre as campanhas ativas de todos os clientes.
CREATE FUNCTION ads_active_campaigns() RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE prev text := current_setting('app.bypass_rls', true);
BEGIN
  PERFORM set_config('app.bypass_rls', 'on', true);
  RETURN QUERY SELECT a.id, a.tenant_id FROM ad_campaigns a WHERE a.status = 'active' AND a.platform = 'meta';
  PERFORM set_config('app.bypass_rls', coalesce(prev, ''), true);
END $$;
REVOKE ALL ON FUNCTION ads_active_campaigns() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ads_active_campaigns() TO app_service;

-- ---------- Publicação também no Google Meu Negócio ----------
CREATE OR REPLACE FUNCTION content_claim_due(p_limit int) RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE prev text := current_setting('app.bypass_rls', true);
BEGIN
  PERFORM set_config('app.bypass_rls', 'on', true);
  UPDATE content_items SET status = 'failed', error = 'Publicação interrompida; confira na rede antes de tentar de novo'
   WHERE status = 'publishing' AND publishing_since < now() - interval '15 minutes';
  RETURN QUERY
  UPDATE content_items ci SET status = 'publishing', attempts = ci.attempts + 1, publishing_since = now()
   WHERE ci.id IN (SELECT c.id FROM content_items c JOIN tenants t ON t.id = c.tenant_id
                    WHERE c.status = 'approved' AND c.scheduled_for <= now() AND t.status = 'active'
                      AND ((c.channel IN ('instagram', 'facebook') AND c.kind IN ('post', 'carousel', 'story'))
                           OR (c.channel = 'google_business' AND c.kind = 'gbp_post'))
                    ORDER BY c.scheduled_for LIMIT p_limit FOR UPDATE OF c SKIP LOCKED)
  RETURNING ci.id, ci.tenant_id;
  PERFORM set_config('app.bypass_rls', coalesce(prev, ''), true);
END $$;

-- ---------- Fotos geradas por IA entram na biblioteca do cliente ----------
ALTER TABLE media ADD COLUMN source text NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'ai', 'render')),
                  ADD COLUMN prompt text;
UPDATE media SET source = 'render' WHERE kind = 'art';
