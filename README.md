# Agência de Marketing Automatizada — SaaS white-label (código base)

Backend Node.js + TypeScript, PostgreSQL com RLS, Redis, painéis em React.
Este pacote é o **núcleo seguro**: multi-tenant, autenticação 2FA, financeiro com ledger,
webhooks antifraude, auditoria imutável, Kill Switch, motor de conteúdo com fila de aprovação,
Meta Ads e WhatsApp Cloud. Os demais módulos estão mapeados nas etapas abaixo.

## Colocar no ar

Veja **[docs/STATUS.md](docs/STATUS.md)**: passo a passo do deploy no Render e o que está pronto/faltando em cada módulo.
Desenvolvimento local: `docker compose up -d` (Postgres + Redis), depois em `backend/` `npm run build && npm run migrate`,
`node dist/bootstrap.js voce@email.com 'SenhaForte123'` e `npm run dev`; em `frontend/` `npm run dev`. Testes: `npm test` no backend.

## Estrutura

```
db/migrations/001_core.sql      tenants, RLS, ledger de partidas dobradas, auditoria encadeada por hash
backend/src/
  db.ts                         withTenant (RLS por transação), withService, withAdmin
  auth/                         login senha + OTP WhatsApp, sessão revogável, detecção de dispositivo novo
  middleware/                   rate limit (Redis), requireAuth + Kill Switch, step-up 2FA
  payments/                     webhooks Asaas/Mercado Pago: assinatura + reconsulta no gateway + idempotência
  finance/                      split em centavos inteiros, ledger
  admin/routes.ts               dashboard MRR/DRE, saque PIX, Kill Switch, fundo de mídia da agência
  ai/                           teto de consumo por cliente, gerador de calendário editorial
  integrations/meta/ads.ts      campanha local por raio (sempre nasce pausada)
  whatsapp/                     módulo 6: WhatsApp multi-tenant
    providers/                  Meta Cloud API e Twilio atrás do mesmo contrato
    registry.ts                 uma instância lógica por número, com o token do próprio cliente
    provisioning.ts             Embedded Signup, compra de número virtual, verificação por ligação
    webhooks.ts                 entrada Meta (HMAC) e Twilio (assinatura), qualidade, alertas de conta
    inbound.ts                  roteia cada mensagem para o negócio dono do número, opt-in/opt-out
    aiAgent.ts                  atendente IA restrito ao negócio, transferência para humano
    cadence.ts / outboxWorker.ts  blindagem do número: fila única de saída com cadência
    inboxRoutes.ts / realtime.ts  painel de atendimento e eventos em tempo real (SSE)
  workers.ts                    processo separado: fila de envio + IA
frontend/                       React + Vite, tema escuro de análise
  src/admin/PainelMaster.tsx    visão do dono: KPIs, receita x lucro, composição, carteira, funil, clientes, IA, alertas
  src/cliente/PainelCliente.tsx painel do negócio: alcance, WhatsApp, mapa de horários, anúncios, melhores posts
  src/cliente/                  fila de aprovação e atendimento WhatsApp
  src/ui/                       tema, menu lateral e gráficos em SVG (sem biblioteca externa)
  src/data/demo.ts              dados de demonstração = contrato que a API deve devolver
```

## Etapas de desenvolvimento

**Etapa 1 — Fundação (semanas 1–3).** Banco + RLS, autenticação 2FA, auditoria, Kill Switch,
cadastro de tenant. Testes automatizados de isolamento: um teste que loga como tenant A e tenta
ler/alterar dados de B precisa falhar sempre.

**Etapa 2 — Financeiro (semanas 3–5).** Assinatura recorrente no Asaas (`/subscriptions`), webhooks,
ledger, split da verba de mídia, DRE. Preferir o **split nativo do gateway** (Asaas: `split` com
`walletId` na cobrança) para que cada valor caia direto na carteira certa, sem a plataforma custodiar
dinheiro de terceiros.

**Etapa 3 — Onboarding e Dossiê (semanas 5–7).** Formulário curto + conexão OAuth dos canais +
leitura de dados públicos autorizados (perfil do Google, site). A IA consolida em `business_dossier`.

**Etapa 4 — Motor orgânico (semanas 7–10).** Calendário mensal, legendas, carrosséis, roteiros,
geração de imagens, fila de aprovação, publicador agendado (worker com BullMQ) por canal.

**Etapa 5 — Tráfego pago (semanas 10–14).** Meta Ads primeiro, Google Ads depois. Projeção,
criação pausada, ativação após aprovação, relatório diário, pausa automática se a verba acabar.

**Etapa 6 — WhatsApp multi-tenant (semanas 12–16).** Ver a seção "Módulo 6" abaixo. Antes de começar,
cadastre a agência como Tech Provider na Meta e submeta o app à revisão (permissões
`whatsapp_business_management` e `whatsapp_business_messaging`).

**Etapa 7 — Site, domínio e avulsos (semanas 15–18).** Landing page gerada por template + IA,
domínio via API de registrador (ex.: Registro.br para .com.br tem processo próprio; .com via
Cloudflare/Namecheap), e-mail profissional via Google Workspace/Zoho (revenda). Loja de avulsos
(logo, cardápio, folder) como produtos `a_la_carte`.

**Etapa 8 — Painel Master completo e white-label (semanas 18–20).** Temas por revendedor,
subdomínio por tenant, gestor de tráfego próprio da agência.

## O que as APIs oficiais permitem (e o que não permitem)

- **Criar contas do zero:** não existe API oficial para criar perfis de Instagram, TikTok ou
  páginas de Facebook em nome de alguém, e o Perfil da Empresa no Google exige verificação feita
  pelo dono. O caminho viável é um **assistente guiado** (o cliente cria em 2 minutos com o passo a
  passo na tela) e depois conecta via OAuth; a partir daí, tudo é automático.
- **Meta Ads:** exige app aprovado na revisão da Meta (permissão `ads_management`), Business Manager
  verificado e a conta de anúncios do cliente compartilhada com a agência.
- **Google Ads:** exige developer token com acesso Básico aprovado e conta MCC.
- **TikTok:** a Content Posting API só publica conteúdo público depois que o app passa pela auditoria
  do TikTok; antes disso, as postagens ficam privadas.
- **WhatsApp:** cada número precisa ser registrado na Meta com nome de exibição aprovado; mensagens
  fora da janela de 24h só por templates aprovados (e são cobradas por conversa).
- **Fundo de mídia:** a retenção da taxa precisa estar explícita no contrato e no checkout.
  Custodiar dinheiro de clientes pode ter implicações regulatórias (instituição de pagamento,
  Banco Central) — por isso o desenho usa split do gateway. Valide com contador e advogado.

## Módulo 6 — WhatsApp multi-tenant

**Isolamento.** Na Cloud API não existe "uma instância por número" como nas soluções não oficiais:
um único webhook recebe tudo, e o `phone_number_id` diz de qual negócio é cada mensagem. O isolamento
é feito em três camadas: cada número tem o token do WABA do próprio cliente (cifrado), todas as tabelas
têm RLS, e cada cliente fica no **próprio portfólio empresarial** na Meta. Esta última camada é a mais
importante: desde outubro de 2025 o limite de mensagens é do portfólio e é compartilhado por todos os
números dele. Se todos os clientes ficarem no portfólio da agência, um cliente que dispara mal consome
o limite e derruba a qualidade de todos.

**Fluxo de ativação de um negócio.**
1. O dono clica em "Conectar WhatsApp" e passa pelo Embedded Signup (pop-up oficial da Meta).
2. Se não tiver número, a plataforma compra um número virtual na Twilio e o adiciona ao WABA dele.
3. A Meta liga para o número com o código. A ligação é gravada; o operador ouve no painel e digita o
   código (é o único passo humano; a transcrição automática de voz em português não é confiável o
   suficiente para isso). Em seguida o número é registrado e já recebe mensagens.

**Números virtuais.** A Twilio exige pacote regulatório aprovado (documentos e endereço) para números
brasileiros, e a oferta de DDDs é limitada. A Zenvia vende números por processo comercial, sem API de
compra self-service; por isso o código traz Twilio. O provedor `twilio.ts` também permite operar a
Twilio como BSP (remetente WhatsApp registrado nela) quando fizer mais sentido.

**Atendente IA.** Responde só sobre o negócio, a partir do dossiê, e transfere para humano em
reclamação, reembolso, negociação ou quando não tem a informação. Isso também atende à regra da Meta
que, desde janeiro de 2026, proíbe usar a API para distribuir assistente de IA de propósito geral.
Quando o atendente responde pela web, a conversa passa para modo humano e a IA para de responder nela.

**Blindagem do número.** Na API oficial, número não cai por velocidade e sim por qualidade (bloqueios e
denúncias de usuários). A fila de saída aplica: ritmo por número ajustado pela qualidade (verde, amarela,
vermelha), teto de destinatários únicos em 24h com 10% de margem abaixo do limite do portfólio, no máximo
uma mensagem de marketing por contato a cada 24h, marketing só com opt-in, opt-out automático por
palavra-chave ("SAIR", "PARAR"), bloqueio de mensagem livre fora da janela de 24h, e resfriamento
automático quando a Meta devolve erro de limite de spam. Alertas de violação na conta pausam todos os
números do WABA afetado. O Kill Switch do Painel Master também pausa o WhatsApp do cliente.

## Segurança (resumo do que já está no código)

| Camada | Implementação |
|---|---|
| Isolamento | RLS com `FORCE`, papel de banco sem BYPASSRLS, tenant setado por transação |
| Login | argon2id, bloqueio após 5 falhas, OTP de 6 dígitos com hash + TTL 5 min + 5 tentativas |
| Sessão | JWT 30 min em cookie httpOnly/SameSite=Strict, revogação por `token_version` |
| Ações críticas | step-up 2FA nos últimos 5 min (saque, Kill Switch, fundo de mídia) |
| Pagamentos | assinatura HMAC/token + reconsulta do pagamento no gateway + checagem de valor + idempotência |
| Saque | chave PIX pré-cadastrada com carência de 24h, limite diário, lock de saldo, estorno contábil |
| Ledger | partidas dobradas, soma zero checada no COMMIT, somente-inserção |
| Auditoria | somente-inserção, cadeia SHA-256; exportar o último hash diariamente para storage WORM |
| APIs de IA | chave só no backend, teto mensal por cliente reservado antes da chamada |

## Rodar localmente

```bash
docker compose up -d                      # Postgres 16 + Redis, aplica a migração
# criar os usuários de login e conceder os papéis:
#   CREATE USER api_user PASSWORD '...' IN ROLE app_user;   (idem svc_user/app_service, adm_user/app_admin)
cd backend && cp ../.env.example .env && npm install && npm run dev
npm run workers                           # em outro terminal: fila do WhatsApp + IA
cd ../frontend && npm install && npm run dev   # interface em http://localhost:5173 (#master ou #cliente)
```

Pendências marcadas no código: worker de publicação dos posts agendados, envio de campanhas por
modelo aprovado (a fila já suporta), agendador da checagem de saúde dos números a cada 6h, conferir a versão vigente da Graph API e a tabela de preços
do modelo de IA. O código não foi compilado neste ambiente (sem acesso à rede para `npm install`):
rode `npx tsc --noEmit` antes do primeiro deploy.
