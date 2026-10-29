-- =====================================================================
-- 007 — saúde das conexões (acesso vencido/revogado) e publicação no TikTok
-- =====================================================================
ALTER TABLE channel_connections
  ADD COLUMN needs_reconnect boolean NOT NULL DEFAULT false,   -- token revogado/expirado: cliente precisa reconectar
  ADD COLUMN last_error      text;

-- Publicador: TikTok entra com carrossel de fotos (as artes). Roteiros de vídeo seguem para o cliente gravar.
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
                           OR (c.channel = 'google_business' AND c.kind = 'gbp_post')
                           OR (c.channel = 'tiktok' AND c.kind IN ('post', 'carousel')))
                    ORDER BY c.scheduled_for LIMIT p_limit FOR UPDATE OF c SKIP LOCKED)
  RETURNING ci.id, ci.tenant_id;
  PERFORM set_config('app.bypass_rls', coalesce(prev, ''), true);
END $$;

-- Painel Master: conexões que precisam de atenção em todos os clientes.
CREATE INDEX ON channel_connections (needs_reconnect) WHERE needs_reconnect;
