-- =====================================================================
-- 002_whatsapp.sql — WhatsApp multi-tenant (Cloud API + Twilio)
-- Isolamento: cada negócio tem seu(s) número(s), seu WABA e, idealmente,
-- seu próprio portfólio empresarial na Meta (limites não são compartilhados).
-- =====================================================================

CREATE TABLE wa_numbers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  provider              text NOT NULL CHECK (provider IN ('meta_cloud','twilio')),
  phone_e164            text NOT NULL UNIQUE,
  phone_number_id       text UNIQUE,            -- ID do número na Cloud API (roteamento do webhook)
  waba_id               text,
  portfolio_id          text,                   -- portfólio empresarial do cliente na Meta
  twilio_number_sid     text,
  verified_name         text,                   -- nome de exibição
  name_status           text DEFAULT 'pending', -- APPROVED / DECLINED / pending
  quality_rating        text DEFAULT 'UNKNOWN' CHECK (quality_rating IN ('GREEN','YELLOW','RED','UNKNOWN')),
  messaging_limit       text DEFAULT 'TIER_250',
  status                text NOT NULL DEFAULT 'provisioning'
                        CHECK (status IN ('provisioning','awaiting_code','active','throttled','paused','disabled')),
  verification_rec_url  text,                   -- gravação da ligação com o código (fallback humano)
  rate_per_min          int NOT NULL DEFAULT 30,-- cadência atual (ajustada pela qualidade)
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wa_contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  wa_id         text NOT NULL,                  -- telefone do contato no formato do WhatsApp
  name          text,
  opted_in_at   timestamptz,                    -- consentimento para mensagens ativas (marketing)
  opted_out_at  timestamptz,                    -- pediu para parar: nada ativo é enviado
  UNIQUE (tenant_id, wa_id)
);

CREATE TABLE wa_conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  number_id        uuid NOT NULL REFERENCES wa_numbers(id),
  contact_id       uuid NOT NULL REFERENCES wa_contacts(id),
  mode             text NOT NULL DEFAULT 'bot' CHECK (mode IN ('bot','human','closed')),
  assigned_to      uuid REFERENCES users(id),
  handoff_reason   text,
  last_inbound_at  timestamptz,                 -- abre a janela de 24h de atendimento
  unread           int NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (number_id, contact_id)
);
CREATE INDEX ON wa_conversations (tenant_id, updated_at DESC);

CREATE TABLE wa_messages (
  id               bigserial PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  conversation_id  uuid NOT NULL REFERENCES wa_conversations(id),
  direction        text NOT NULL CHECK (direction IN ('in','out')),
  author           text NOT NULL CHECK (author IN ('contact','ai','agent','system')),
  agent_id         uuid REFERENCES users(id),
  msg_type         text NOT NULL DEFAULT 'text',
  body             text,
  wamid            text UNIQUE,                 -- ID da mensagem no WhatsApp (idempotência)
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','read','failed','received')),
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON wa_messages (conversation_id, id);

-- Fila de saída: TODA mensagem passa por aqui, nunca direto para a API (cadência e blindagem)
CREATE TABLE wa_outbox (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  number_id    uuid NOT NULL REFERENCES wa_numbers(id),
  message_id   bigint REFERENCES wa_messages(id),
  to_wa_id     text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('session','utility','marketing','authentication')),
  payload      jsonb NOT NULL,
  priority     int NOT NULL DEFAULT 5,          -- 1 = resposta a cliente; 9 = campanha
  not_before   timestamptz NOT NULL DEFAULT now(),
  attempts     int NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','blocked'))
);
CREATE INDEX ON wa_outbox (status, priority, not_before);

-- RLS em todas as tabelas do módulo
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['wa_numbers','wa_contacts','wa_conversations','wa_messages','wa_outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO app_user, app_service', t);
  END LOOP;
END $$;
GRANT USAGE ON SEQUENCE wa_messages_id_seq, wa_outbox_id_seq TO app_user, app_service;

-- Roteamento do webhook: descobre o tenant pelo número ANTES de existir contexto de tenant.
-- Retorna só o necessário; nenhuma outra linha fica exposta.
CREATE FUNCTION wa_resolve_number(p_phone_number_id text, p_phone_e164 text DEFAULT NULL)
RETURNS TABLE (number_id uuid, tenant_id uuid, provider text, status text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT id, tenant_id, provider, status FROM wa_numbers
   WHERE (p_phone_number_id IS NOT NULL AND phone_number_id = p_phone_number_id)
      OR (p_phone_e164 IS NOT NULL AND phone_e164 = p_phone_e164)
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION wa_resolve_number(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wa_resolve_number(text, text) TO app_service;

-- O worker de envio pega itens de vários tenants; função dedicada que trava e devolve um lote.
CREATE FUNCTION wa_claim_outbox(p_limit int)
RETURNS SETOF wa_outbox LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE wa_outbox o SET status = 'sending', attempts = attempts + 1
   WHERE o.id IN (SELECT id FROM wa_outbox
                   WHERE status = 'pending' AND not_before <= now()
                   ORDER BY priority, id LIMIT p_limit FOR UPDATE SKIP LOCKED)
  RETURNING o.*
$$;
REVOKE ALL ON FUNCTION wa_claim_outbox(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wa_claim_outbox(int) TO app_service;

-- Alerta de conta na Meta (violação/restrição): pausa todos os números daquele WABA.
CREATE FUNCTION wa_pause_waba(p_waba text) RETURNS TABLE (number_id uuid, tenant_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE wa_numbers SET status = 'paused' WHERE waba_id = p_waba AND status <> 'disabled'
  RETURNING id, tenant_id
$$;
REVOKE ALL ON FUNCTION wa_pause_waba(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wa_pause_waba(text) TO app_service;
