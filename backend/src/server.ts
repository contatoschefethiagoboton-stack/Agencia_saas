import 'express-async-errors';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { authRouter } from './auth/routes.js';
import { webhookRouter } from './payments/webhooks.js';
import { adminRouter } from './admin/routes.js';
import { requireAuth } from './middleware/auth.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { marketRouter } from './market/routes.js';
import { botsRouter } from './bots/routes.js';
import { accountRouter } from './account/routes.js';
import { walletRouter } from './wallet/routes.js';
import { accessLog, ipGuard } from './security/guard.js';
import { encryptionKeyStatus } from './security/vault.js';
import { adminPath, publicUrl } from './config.js';

const app = express();
app.set('trust proxy', 1);                   // atrás do proxy do Render/Cloudflare
app.disable('x-powered-by');
// connect-src: o gráfico de cripto recebe os preços ao vivo direto da Binance (WebSocket público, sem chave)
app.use(helmet({ contentSecurityPolicy: { directives: { 'img-src': ["'self'", 'data:', 'https:'],
                   'connect-src': ["'self'", 'wss://stream.binance.com:9443', 'wss://data-stream.binance.vision'] } } }));
app.use(cookieParser());
const rawBody = (req: any, _res: unknown, buf: Buffer) => { req.rawBody = buf; };
app.use(express.json({ limit: '1mb', verify: rawBody }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));   // health check do Render

app.use('/webhooks/pagamentos', webhookRouter);   // sem sessão; protegidos por assinatura
app.use('/api', ipGuard, apiLimiter, accessLog);   // IP bloqueado não passa; toda chamada com sessão é rastreada
app.use('/api/auth', authRouter);
app.use('/api/admin', requireAuth, adminRouter);

// área do cliente: precisa de sessão de cliente (o administrador entra aqui só pelo "abrir painel do cliente")
const requireTenant = (req: express.Request, res: express.Response, next: express.NextFunction) =>
  req.user?.tid ? next() : res.status(403).json({ error: 'Área de clientes' });
app.use('/api/market', requireAuth, requireTenant, marketRouter);
app.use('/api/bots', requireAuth, requireTenant, botsRouter);
app.use('/api/account', requireAuth, requireTenant, accountRouter);
app.use('/api/wallet', requireAuth, requireTenant, walletRouter);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

// ---------- Painel React (build do Vite copiado para ./public no Docker) ----------
const webDir = path.resolve(process.env.WEB_DIR ?? 'public');
if (fs.existsSync(path.join(webDir, 'index.html'))) {
  app.use(express.static(webDir, { index: false }));
  // LOGINS SEPARADOS: só o endereço secreto (ADMIN_PATH) recebe a marca da área da agência.
  // Em qualquer outro endereço o site só conhece o login de cliente.
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  const adminHtml = html.replace('</head>', `<meta name="app-area" content="admin"><meta name="robots" content="noindex, nofollow"></head>`);
  app.get(/^\/(?!api\/|webhooks\/).*/, (req, res) => {
    const isAdmin = req.path.replace(/\/+$/, '') === adminPath();
    res.set('Cache-Control', 'no-store').type('html').send(isAdmin ? adminHtml : html);
  });
}

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err?.name === 'ZodError') return res.status(400).json({ error: 'Dados inválidos' });
  if (err?.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Erro interno' });       // nunca vaza stack para o cliente
});

app.listen(Number(process.env.PORT ?? 3000), () => {
  console.log('API no ar');
  console.log(`[config] Login do administrador: ${publicUrl()}${adminPath()}`);
  if (adminPath() === '/admin') console.warn('[config] ADMIN_PATH não definida: o login do administrador está no endereço padrão /admin. Defina um endereço secreto (ex.: /acesso-painel-7k2).');
  // conferência de configuração: avisa no log do Render o que falta, em vez de falhar no meio de um login
  const enc = encryptionKeyStatus();
  if (!process.env.JWT_SECRET) console.warn('[config] JWT_SECRET não definida: ninguém consegue entrar. Defina em Environment.');
  if (!enc.ok) console.warn(`[config] ${enc.detail}: o 2FA e as conexões com corretoras não funcionam.`);
  if (!process.env.BRAPI_TOKEN) console.warn('[config] BRAPI_TOKEN não definida: B3 e FIIs limitados aos ativos de teste da brapi.');
  if (!process.env.ALPACA_DATA_KEY) console.warn('[config] ALPACA_DATA_KEY não definida: ações dos EUA desligadas.');
  else if (enc.source === 'jwt_secret') console.warn('[config] TOKEN_ENC_KEY não definida: usando chave derivada do JWT_SECRET. Funciona, mas não troque o JWT_SECRET depois.');
});

// Sem Background Worker (ex.: plano free do Render), os robôs e o radar rodam neste mesmo processo.
// Com um worker separado (node dist/workers.js), defina RUN_WORKERS_IN_WEB=0 no serviço web.
if (process.env.RUN_WORKERS_IN_WEB !== '0' && (process.env.DATABASE_URL || process.env.DATABASE_URL_SERVICE)) {
  const { runBotEngine } = await import('./bots/engine.js');
  const { runRadar, runPriceAlerts } = await import('./market/radar.js');
  for (const [name, run] of [['robôs', runBotEngine], ['radar', runRadar], ['alertas de preço', runPriceAlerts]] as const) {
    (async function loop() {
      for (;;) {
        try { await run(); } catch (e) { console.error(`[worker ${name}]`, (e as Error).message); }
        await new Promise(r => setTimeout(r, 10_000));   // caiu (ex.: banco fora): tenta de novo
      }
    })();
  }
  console.log('Robôs e radar rodando no mesmo processo da API');
}
