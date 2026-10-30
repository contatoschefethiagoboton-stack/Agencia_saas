-- =====================================================================
-- 010 — cadastro com aprovação da agência e cliente VIP (oculto para o cliente)
-- =====================================================================
ALTER TABLE tenants DROP CONSTRAINT tenants_status_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_status_check
  CHECK (status IN ('pending', 'active', 'suspended', 'killed', 'rejected'));

ALTER TABLE tenants
  ADD COLUMN vip         boolean NOT NULL DEFAULT false,   -- só a agência vê: isento de cobrança, sem teto de IA, recursos do maior plano
  ADD COLUMN vip_note    text,                             -- anotação interna (ex.: "parceiro", "permuta")
  ADD COLUMN signup      text NOT NULL DEFAULT 'admin' CHECK (signup IN ('admin', 'self')),
  ADD COLUMN decided_at  timestamptz,                      -- quando a agência aprovou/recusou o cadastro
  ADD COLUMN decided_by  uuid REFERENCES users(id);
