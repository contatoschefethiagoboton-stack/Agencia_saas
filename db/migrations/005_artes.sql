-- =====================================================================
-- 005_artes.sql — artes geradas, fotos e logo do negócio
-- Guardadas no banco (o disco do Render é apagado a cada deploy). Para muito volume,
-- trocar por um storage de objetos (S3/R2) mantendo a mesma tabela como índice.
-- =====================================================================
CREATE TABLE media (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  kind            text NOT NULL CHECK (kind IN ('art', 'photo', 'logo')),
  mime            text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png')),
  bytes           bytea NOT NULL,
  width           int,
  height          int,
  content_item_id uuid REFERENCES content_items(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON media (tenant_id, kind, created_at DESC);
CREATE INDEX ON media (content_item_id);

ALTER TABLE media ENABLE ROW LEVEL SECURITY;
ALTER TABLE media FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON media
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY admin_bypass ON media
  USING (current_setting('app.bypass_rls', true) = 'on')
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on');
GRANT SELECT, INSERT, UPDATE, DELETE ON media TO app_user, app_service;
GRANT SELECT ON media TO app_admin;

-- O Instagram/Facebook buscam a arte por um link público. Só ARTES são públicas (nunca fotos
-- enviadas ou logos); o id é aleatório de 128 bits, impossível de adivinhar.
CREATE FUNCTION media_public(p_id uuid) RETURNS TABLE (mime text, bytes bytea)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE prev text := current_setting('app.bypass_rls', true);
BEGIN
  PERFORM set_config('app.bypass_rls', 'on', true);
  RETURN QUERY SELECT m.mime, m.bytes FROM media m WHERE m.id = p_id AND m.kind = 'art';
  PERFORM set_config('app.bypass_rls', coalesce(prev, ''), true);
END $$;
REVOKE ALL ON FUNCTION media_public(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION media_public(uuid) TO app_user, app_service;
