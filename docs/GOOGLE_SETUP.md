# Google Meu Negócio — configuração do projeto no Google

Feito **uma vez pela agência**. Depois, cada cliente conecta o próprio perfil em **Conexões → Conectar com Google**
e os posts do Google aprovados no calendário passam a ser publicados no horário.

## 1. Criar o projeto (20 min)

1. <https://console.cloud.google.com> → **Novo projeto** (ex.: "Agência Hub").
2. **APIs e serviços → Biblioteca**: ative **My Business Account Management API**, **My Business Business Information API**
   e **Google My Business API** (a dos posts, v4).
3. **Tela de permissão OAuth**: tipo **Externo**, nome do app, e-mail de suporte, domínio do site, link da política de privacidade.
   Escopo: `https://www.googleapis.com/auth/business.manage`.
4. **Credenciais → Criar credenciais → ID do cliente OAuth** → tipo **Aplicativo da Web**.
   - **URIs de redirecionamento autorizados**: `https://SEU-SITE.onrender.com/oauth/google/callback`
5. No Render (Environment): `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`.

## 2. Pedir acesso às APIs do Business Profile (obrigatório)

As APIs do Perfil da Empresa só respondem depois que o Google aprova o projeto:
<https://developers.google.com/my-business/content/prereqs> → formulário **"GBP API contact form"** → "Application for Basic API Access".
Informe o ID do projeto. Costuma levar de alguns dias a 2 semanas.

Enquanto o app OAuth está em **modo de teste**, só os e-mails cadastrados como testadores conseguem conectar
(até 100). Para liberar a todos, publique o app e passe pela verificação do Google (escopo sensível).

## O que o cliente precisa ter

- Um **Perfil da Empresa no Google** já verificado (a verificação é feita pelo dono, por carta, ligação ou vídeo — não existe API para isso).
- Ser proprietário ou administrador do perfil.

## Como funciona por dentro

- O refresh token fica **cifrado** no banco; o token de acesso (1 h) é renovado sozinho e guardado no Redis.
- Os posts são do tipo "Novidade", com a arte quadrada (1080×1080), sem hashtags (o Google ignora) e com o botão **Ligar**
  quando o telefone está no dossiê.
- Falha mostra o motivo no card e o botão **Tentar de novo**; nunca republica sozinho.
