# Conectar Instagram, Facebook e Meta Ads — configuração do app na Meta

Feito **uma vez pela agência**. Depois disso, cada cliente conecta as próprias contas em **Conexões**
com o login oficial da Meta, e a plataforma passa a publicar os conteúdos aprovados e a mostrar os números reais.

## 1. Criar o app (15 min)

1. Acesse <https://developers.facebook.com/apps> → **Criar app** → tipo **Empresa**, ligado ao Business Manager da agência.
2. Adicione os produtos **Login do Facebook para Empresas**, **API do Instagram** (com login do Facebook) e **API de Marketing**.
3. Em **Login do Facebook para Empresas → Configurações**:
   - **URIs de redirecionamento do OAuth válidos**: `https://SEU-SITE.onrender.com/oauth/meta/callback`
     (o mesmo endereço do site; se usar domínio próprio, use o domínio).
4. Em **Configurações do app → Básico**: copie o **ID do app** e a **Chave secreta**.
5. No Render (serviço web → Environment):
   - `META_APP_ID` = ID do app · `META_APP_SECRET` = chave secreta
   - `PUBLIC_URL` = endereço do site (ex.: `https://agencia-saas.onrender.com`). Se ficar vazio, o Render informa sozinho.

Pronto para testar: com o app em **modo de desenvolvimento**, quem for administrador/testador do app já consegue
conectar as próprias páginas e publicar. Use isso para validar com a sua página antes de chamar clientes.

## 2. Liberar para os clientes (revisão da Meta — 1 a 4 semanas)

Em **Revisão do app → Permissões e recursos**, peça acesso avançado a:

| Permissão | Para quê |
|---|---|
| `pages_show_list`, `pages_read_engagement` | listar as páginas do cliente |
| `pages_manage_posts` | publicar no Facebook |
| `instagram_basic`, `instagram_content_publish` | publicar no Instagram |
| `instagram_manage_insights`, `read_insights` | números de alcance e engajamento |
| `ads_read`, `ads_management` | números e criação de campanhas |
| `business_management` | acessar ativos do portfólio do cliente |

A Meta pede: **verificação da empresa** (CNPJ), **política de privacidade** publicada e um **vídeo** mostrando o fluxo
(cliente clica em Conectar → escolhe a página → conteúdo aprovado aparece publicado). Grave com o app em modo de desenvolvimento.

## 3. O que o cliente precisa ter

- **Instagram profissional** (empresa ou criador) **vinculado a uma Página do Facebook**.
- Ser administrador da página. Para anúncios, ter uma conta de anúncios com forma de pagamento.

## Como funciona por dentro

- O login acontece na Meta; a plataforma nunca vê a senha do cliente.
- Tokens ficam **cifrados** (AES-256-GCM) no banco; o token de página não expira enquanto o cliente não remover o acesso.
  O token de anúncios dura ~60 dias: o painel mostra até quando, e o cliente clica em **Reconectar**.
- O publicador roda a cada 30 s e publica só itens **aprovados** cujo horário chegou. Falha nunca é repetida sozinha
  (para não duplicar post): o cliente vê o motivo e clica em **Tentar de novo**.
- **Instagram exige imagem.** Enquanto a geração automática de artes não está pronta, o cliente cola o link da arte
  (Canva → Compartilhar → link público da imagem JPG, ou qualquer endereço `https` de imagem) no card do conteúdo.
- O **Modo Pânico** bloqueia publicação, novas conexões e chamadas à Meta (pausar campanha continua permitido).
