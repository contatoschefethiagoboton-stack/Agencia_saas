# TikTok — configuração do app

Feito **uma vez pela agência**. Depois, cada cliente conecta a própria conta em **Conexões → Conectar com TikTok**
e os **carrosséis** aprovados para o TikTok são publicados como posts de fotos (com música automática).
Vídeos não são gerados: o cliente grava a partir dos roteiros do calendário e posta pelo app.

## 1. Criar o app (20 min)

1. <https://developers.tiktok.com> → **Manage apps → Connect an app**.
2. Produtos: **Login Kit** e **Content Posting API** (ative **Direct Post**).
3. Escopos: `user.info.basic` e `video.publish`.
4. **Redirect URI**: `https://SEU-SITE.onrender.com/oauth/tiktok/callback`
5. **Verificação de domínio (URL prefix)** para as artes: em *Content Posting API → Manage URL properties*, adicione
   `https://SEU-SITE.onrender.com/media/`. O TikTok pede um arquivo de verificação: copie o **nome** e o **conteúdo** para
   `TIKTOK_VERIFY_FILENAME` e `TIKTOK_VERIFY_CONTENT` no Render; o site passa a servir esse arquivo na raiz.
6. No Render: `TIKTOK_CLIENT_KEY` e `TIKTOK_CLIENT_SECRET`.

## 2. Auditoria (obrigatória para posts públicos)

Antes da auditoria, a API só publica como **"Somente eu"** (`TIKTOK_PRIVACY=SELF_ONLY`, padrão) — ótimo para testar.
Peça a auditoria em *App review* com um vídeo do fluxo (conectar → aprovar carrossel → post aparecendo).
Aprovado, troque `TIKTOK_PRIVACY` para `PUBLIC_TO_EVERYONE`.

## Como funciona por dentro

- Refresh token (1 ano) **cifrado** no banco; token de acesso (24 h) renovado sozinho e guardado no Redis.
- O TikTok baixa as artes do nosso domínio (`/media/<id>.jpg`) e publica em segundo plano; a plataforma acompanha até concluir.
- Se o cliente remover o acesso, a conexão fica marcada **"Reconectar"** e os posts param com aviso (sem insistir na API).
