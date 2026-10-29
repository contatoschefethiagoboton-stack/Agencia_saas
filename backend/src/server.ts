import 'express-async-errors';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { authRouter } from './auth/routes.js';
import { webhookRouter } from './payments/webhooks.js';
import { waWebhookRouter } from './whatsapp/webhooks.js';
import { inboxRouter } from './whatsapp/inboxRoutes.js';
import { adminRouter } from './admin/routes.js';
import { requireAuth } from './middleware/auth.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { clientRouter, approvalsRouter } from './client/routes.js';
import { metaCallbackRouter } from './integrations/meta/oauth.js';
import { googleCallbackRouter } from './integrations/google/google.js';
import { tiktokCallbackRouter, tiktokVerifyRouter } from './integrations/tiktok/tiktok.js';
import { servicePool } from './db.js';

const app = express();
app.set('trust proxy', 1);                   // atrás do proxy do Render/Cloudflare
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: { 'img-src': ["'self'", 'data:', 'https:'] } } }));
app.use(cookieParser());
const rawBody = (req: any, _res: unknown, buf: Buffer) => { req.rawBody = buf; };
const jsonSmall = express.json({ limit: '1mb', verify: rawBody });
const jsonLarge = express.json({ limit: '15mb' });                 // só para o PDF do onboarding
const LARGE = new Set(['/api/client/dossier/ingest', '/api/client/media']);   // PDF do onboarding e fotos/logo
app.use((req, res, next) => (LARGE.has(req.path) ? jsonLarge : jsonSmall)(req, res, next));

app.get('/healthz', (_req, res) => res.json({ ok: true }));   // health check do Render

// Artes públicas: o Instagram/Facebook buscam a imagem por este link. Só artes (nunca fotos ou logos enviados).
app.get('/media/:id.jpg', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).end();
  const m = (await servicePool.query('SELECT mime, bytes FROM media_public($1)', [req.params.id])).rows[0];
  if (!m) return res.status(404).end();
  res.set({ 'Cache-Control': 'public, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'cross-origin' }).type(m.mime).send(m.bytes);
});

app.use('/webhooks/pagamentos', webhookRouter);   // sem sessão; protegidos por assinatura
app.use('/webhooks/whatsapp', waWebhookRouter);    // Meta (HMAC) e Twilio (assinatura)

app.use('/oauth/meta', apiLimiter, metaCallbackRouter);   // retorno do login da Meta (sem sessão; state assinado)
app.use('/oauth/google', apiLimiter, googleCallbackRouter);   // retorno do login do Google (idem)
app.use('/oauth/tiktok', apiLimiter, tiktokCallbackRouter);   // retorno do login do TikTok (idem)
app.use(tiktokVerifyRouter);                                    // arquivo de verificação de domínio do TikTok
app.use('/api', apiLimiter);
app.use('/api/auth', authRouter);
app.use('/api/admin', requireAuth, adminRouter);
app.use('/api/whatsapp', requireAuth, inboxRouter);

app.use('/api/client', requireAuth, clientRouter);
app.use('/api/approvals', requireAuth, approvalsRouter);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

// ---------- Painel React (build do Vite copiado para ./public no Docker) ----------
const webDir = path.resolve(process.env.WEB_DIR ?? 'public');
if (fs.existsSync(path.join(webDir, 'index.html'))) {
  app.use(express.static(webDir, { index: false }));
  app.get(/^\/(?!api\/|webhooks\/).*/, (_req, res) => res.sendFile(path.join(webDir, 'index.html')));
}

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err?.name === 'ZodError') return res.status(400).json({ error: 'Dados inválidos' });
  if (err?.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Erro interno' });       // nunca vaza stack para o cliente
});

app.listen(Number(process.env.PORT ?? 3000), () => console.log('API no ar'));

// Sem Background Worker (ex.: plano free do Render), a fila do WhatsApp e a IA rodam neste mesmo processo.
// Com um worker separado (node dist/workers.js), defina RUN_WORKERS_IN_WEB=0 no serviço web.
if (process.env.RUN_WORKERS_IN_WEB !== '0' && (process.env.DATABASE_URL || process.env.DATABASE_URL_SERVICE)) {
  const { runOutboxWorker } = await import('./whatsapp/outboxWorker.js');
  const { runAiWorker } = await import('./whatsapp/aiAgent.js');
  const { runPublisher } = await import('./integrations/meta/publish.js');
  const { runAdsGuard } = await import('./integrations/meta/ads.js');
  for (const [name, run] of [['fila WhatsApp', runOutboxWorker], ['IA WhatsApp', runAiWorker], ['publicador', runPublisher],
                             ['vigia de verba', runAdsGuard]] as const) {
    (async function loop() {
      for (;;) {
        try { await run(); } catch (e) { console.error(`[worker ${name}]`, (e as Error).message); }
        await new Promise(r => setTimeout(r, 10_000));   // caiu (ex.: banco fora): tenta de novo
      }
    })();
  }
  console.log('Workers rodando no mesmo processo da API');
}
