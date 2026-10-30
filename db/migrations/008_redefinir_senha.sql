-- =====================================================================
-- 008 — "Esqueci minha senha": link de uso único, válido por 30 minutos
-- Guarda só o HASH do token; o link em si existe apenas no e-mail do usuário.
-- =====================================================================
CREATE TABLE password_resets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON password_resets (user_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE ON password_resets TO app_user, app_admin;
