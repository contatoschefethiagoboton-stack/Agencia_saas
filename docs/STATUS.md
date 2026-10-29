# Status da plataforma — o que está pronto e o que falta

Revisão completa do código contra o escopo da Agência Hub / AutoMkt Express.
Legenda: ✅ pronto e testado · 🟡 pronto no código, depende de credencial/aprovação externa · ⛔ não existe API oficial

## Como colocar no ar (Render)

1. Render → **New → Blueprint** → este repositório (`render.yaml` cria API + Postgres + Redis já ligados).
2. Preencha `ADMIN_EMAIL` e `ADMIN_PASSWORD` quando o Render pedir.
3. Abra o site, entre com esse e-mail/senha e leia o QR Code com o Google Authenticator (2FA).
4. Em **Clientes**, cadastre o primeiro negócio. A senha provisória aparece uma vez; o cliente troca no 1º acesso.

Sem nenhuma chave externa, o site já funciona: login 2FA, painéis, cadastro de clientes, dossiê, aprovação, tesouraria
e central de segurança. Cada integração liga quando a respectiva variável é preenchida.

---

## 1. Core e multi-tenant

| Item | Status | Onde |
|---|---|---|
| Node.js + React + PostgreSQL + Redis | ✅ | `backend/`, `frontend/` |
| Isolamento por tenant com RLS (FORCE) em todas as tabelas de cliente | ✅ testado: cliente A não vê dados do B | `db/migrations/*.sql`, `db.ts` (`withTenant`) |
| Painel Master enxerga todos os tenants sem `BYPASSRLS` (Render não permite) | ✅ | política `admin_bypass` + `withAdmin` |
| Deploy no Render: Docker, migrações automáticas, 1º admin automático, Redis interno de reserva | ✅ | `Dockerfile`, `docker-entrypoint.sh`, `render.yaml` |
| Workers (fila de WhatsApp + IA) rodando no plano free | ✅ | dentro do serviço web (`RUN_WORKERS_IN_WEB`) |

## 2. Onboarding e criação de ativos

| Item | Status | Observação |
|---|---|---|
| Dossiê do negócio (memória do comércio) | ✅ | tela **Meu negócio** |
| Leitura automática do **site** do cliente | 🟡 precisa `ANTHROPIC_API_KEY` | com proteção contra SSRF |
| Leitura de **cardápio/catálogo em PDF** | 🟡 precisa `ANTHROPIC_API_KEY` | PDF vai direto para o modelo |
| Leitura do **Instagram** | 🟡 | métricas e posts pela API oficial depois que o cliente conecta (tela **Conexões**). Raspagem de perfil viola os termos da Meta e não foi implementada |
| Leitura do **Google Meu Negócio** | 🟡 | Business Profile API exige projeto Google aprovado + OAuth do dono. Hoje: dados digitados ou vindos do site |
| **Criar perfis** de Instagram/TikTok/Facebook/Google via API | ⛔ | não existe API oficial para isso. Caminho: assistente guiado + conexão OAuth (próxima etapa) |
| Conectar **Instagram + Facebook + Meta Ads** (login oficial da Meta) | ✅ testado com Graph API simulada · 🟡 precisa app Meta | tela **Conexões**; ver `docs/META_SETUP.md` |
| Conectar **Google Meu Negócio** (login do Google, escolha do local) | ✅ testado com API simulada · 🟡 precisa projeto Google aprovado | ver `docs/GOOGLE_SETUP.md` |
| Conectar TikTok | 🔲 falta | depende da auditoria do app no TikTok |

## 3. Conteúdo e tráfego pago

| Item | Status | Observação |
|---|---|---|
| Calendário de 30 dias por IA (legendas, gatilhos mentais, carrosséis, roteiros, posts do Google) | 🟡 precisa `ANTHROPIC_API_KEY` | quantidade conforme o plano; playbooks por nicho; Safety Prompt |
| Painel de aprovação Kanban + **Aprovar tudo** + **Pedir ajuste** em texto (IA reescreve) | ✅ | tela **Aprovações** |
| Teto de IA por plano (para antes de gastar) | ✅ | `budgetGuard.ts` + `plans.ai_quota_cents` |
| Geração das **artes** em lote por modelo de nicho | ✅ testado | 6 modelos (destaque, oferta, bastidores, dica, depoimento, carrossel) com cores, logo e fotos do cliente; JPG 1080×1350 (story 1080×1920); geradas junto com o calendário; tela **Identidade visual** |
| **Fotos por IA** para quem não tem fotos | ✅ testado com API simulada · 🟡 precisa `IMAGE_API_KEY` | entram na biblioteca; botão "Foto por IA" no post; contam no teto mensal de IA; regras de segurança no pedido |
| **Publicação** automática no Instagram (post, carrossel, story) e Facebook | ✅ testado com Graph API simulada · 🟡 precisa app Meta | só itens aprovados, já com a arte gerada (ou link próprio); falha mostra o motivo e "Tentar de novo" |
| Publicação no **Google Meu Negócio** (novidades com arte quadrada e botão Ligar) | ✅ testado com API simulada | mesmo fluxo de aprovação e publicador |
| Vídeos via **TikTok Content Posting API** | 🟡⛔ | o app precisa passar pela auditoria do TikTok para publicar como público |
| **Campanhas Meta Ads pela tela** (projeção → montada pausada → aprovação → no ar) | ✅ testado com API simulada · 🟡 precisa app Meta com `ads_management` | tela **Anúncios**: raio, verba, imagem, link (WhatsApp/site); público medido pela Meta |
| **Vigia de verba**: pausa sozinho ao atingir a verba do mês | ✅ testado | roda a cada 15 min; Kill Switch e Modo Pânico também pausam |
| Métricas reais no painel do cliente (Instagram + Meta Ads) | ✅ testado com Graph API simulada | substitui a prévia assim que o cliente conecta |
| **Google Ads** | 🔲 falta | exige developer token com acesso Básico + conta MCC |

## 4. WhatsApp multi-tenant

| Item | Status | Observação |
|---|---|---|
| Cloud API oficial (Embedded Signup, webhooks com HMAC, qualidade, pausa por alerta) | 🟡 | precisa app Meta como Tech Provider (`META_APP_ID/SECRET`) |
| Números virtuais **Twilio** + verificação por ligação gravada | 🟡 | precisa `TWILIO_*` e pacote regulatório BR aprovado |
| **Zenvia** | 🔲 falta | o contrato `WhatsAppProvider` permite adicionar como 3º provedor |
| Blindagem do número (fila única, cadência por qualidade, opt-in/opt-out, janela 24h) | ✅ código | `cadence.ts`, `outboxWorker.ts` |
| Atendente IA 24/7 restrito ao negócio + transferência para humano | 🟡 precisa `ANTHROPIC_API_KEY` | `aiAgent.ts` |
| Painel multi-atendente por negócio, tempo real | ✅ código | tela **Atendimento WhatsApp** (SSE) |
| Roteamento do webhook e fila de envio com banco sem superusuário (Render) | ✅ corrigido e testado | antes as funções não enxergavam nenhum número por causa do RLS forçado |

## 5. Financeiro

| Item | Status | Observação |
|---|---|---|
| Planos (tiers) configuráveis | ✅ | **Tesouraria → Planos** |
| Assinatura recorrente + setup no **Asaas** | 🟡 precisa `ASAAS_API_KEY` | cobranças mensais chegam pelo webhook e são reconhecidas pelo `externalReference` |
| **Split nativo** no ato do pagamento | 🟡 | `ASAAS_SPLIT_JSON` com as carteiras (custos, fundo de expansão…) |
| Split da verba de mídia no ledger (cliente / lucro / fundo de mídia), centavos inteiros | ✅ testado | `finance/split.ts` |
| Ledger de partidas dobradas imutável | ✅ | o banco recusa transação que não soma zero |
| **Mercado Pago** (webhook HMAC + reconsulta) | 🟡 | cobrança pelo MP ainda não é criada pela plataforma (só recebimento) |
| **Pagar.me** | 🔲 falta | |
| Painel Master: DRE por cliente, saldo para saque, **saque PIX** com 2FA, limite diário e chave com carência de 24h | ✅ | **Visão geral** e **Tesouraria** |
| Fundo de mídia para auto-captação | ✅ saldo e injeção | falta criar a campanha própria da agência pela tela |

## 6. Segurança

| Item | Status |
|---|---|
| 2FA obrigatório: app autenticador (TOTP) ou código no WhatsApp | ✅ testado |
| Step-up 2FA para saque, kill switch, modo pânico, chave PIX, reset de acesso | ✅ |
| Detecção de novo dispositivo, bloqueio após 5 senhas erradas, rate limit por IP e por e-mail | ✅ |
| Sessão JWT em cookie httpOnly/secure/strict, revogação instantânea, renovação deslizante | ✅ |
| Webhooks: assinatura HMAC/token + reconsulta no gateway + idempotência | ✅ |
| **Chargeback**: estorno no ledger + trava da conta + derruba sessões | ✅ testado |
| Teto de IA por plano + Safety Prompt + dados do cliente tratados como dados, não instruções | ✅ |
| Credenciais só no backend; tokens OAuth cifrados (AES-256-GCM) | ✅ |
| **Central de Segurança**: logs com cadeia de hash, tentativas de invasão, IPs suspeitos | ✅ |
| **Kill Switch** por cliente e **Modo Pânico** global (corta IA, anúncios e WhatsApp) | ✅ testado |
| Validação de cartão | 🟡 feita pelo gateway homologado (Asaas/MP); a plataforma nunca toca no cartão |

---

## Próximas etapas recomendadas (ordem)

1. ~~Conexão Meta, publicação automática e métricas reais~~ ✅ feito (falta só criar o app na Meta: `docs/META_SETUP.md`).
2. ~~Geração de artes em lote~~ ✅ feito. Com muito volume, mover as imagens do Postgres para um storage (S3/R2).
3. ~~Campanhas Meta Ads pela tela~~ ✅ · ~~Google Meu Negócio~~ ✅ · ~~fotos por IA~~ ✅. Falta: aviso de renovação do token de anúncios (~60 dias).
4. TikTok (conexão + publicação), depois da auditoria do app.
5. Google Ads, Pagar.me e Zenvia.
6. Testes automatizados de isolamento no CI (os roteiros de ponta a ponta usados nas revisões podem virar a base).

## Aprovações externas que levam semanas — começar já

- Meta: verificação do Business Manager, app como **Tech Provider**, revisão de `whatsapp_business_management`,
  `whatsapp_business_messaging`, `ads_management`, `instagram_content_publish`, `pages_manage_posts`.
- Google: developer token do Ads (acesso Básico) e acesso à Business Profile API.
- TikTok: auditoria do app para a Content Posting API.
- Twilio: pacote regulatório para números brasileiros.
