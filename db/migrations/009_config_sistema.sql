-- 009 — configurações internas da plataforma (ex.: última redefinição do admin feita por ADMIN_RESET)
CREATE TABLE system_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON system_settings FROM PUBLIC;
