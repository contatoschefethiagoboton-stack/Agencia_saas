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
import { withTenant } from './db.js';
import { audit } from './audit/audit.js';

const app = express();
app.set('trust proxy', 1);                   // atrás do proxy do Render/Cloudflare
app.disable('x-powered-by');
app.use(helmet());
app.use(cookieParser());
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));   // health check do Render

app.use('/webhooks/pagamentos', webhookRouter);   // sem sessão; protegidos por assinatura
app.use('/webhooks/whatsapp', waWebhookRouter);    // Meta (HMAC) e Twilio (assinatura)

app.use('/api', apiLimiter);
app.use('/api/auth', authRouter);
app.use('/api/admin', requireAuth, adminRouter);
app.use('/api/whatsapp', requireAuth, inboxRouter);

// ---------- Painel do cliente: fila de aprovação ----------
app.get('/api/approvals', requireAuth, async (req, res) => {
  const rows = await withTenant(req.user!.tid!, async c =>
    (await c.query(`SELECT id, channel, kind, payload, scheduled_for FROM content_items
                    WHERE status = 'pending_approval' ORDER BY scheduled_for`)).rows);
  res.json(rows);
});

app.post('/api/approvals/:id', requireAuth, async (req, res) => {
  const decision = req.body?.decision === 'approve' ? 'approved' : 'rejected';
  await withTenant(req.user!.tid!, async c => {
    const r = await c.query(`UPDATE content_items SET status = $1, decided_by = $2, decided_at = now()
                             WHERE id = $3 AND status = 'pending_approval'`, [decision, req.user!.sub, req.params.id]);
    if (!r.rowCount) throw Object.assign(new Error('Item não encontrado'), { status: 404 });
    await audit({ actorId: req.user!.sub, tenantId: req.user!.tid, ip: req.ip,
                  action: `content.${decision}`, target: req.params.id }, c);
  });
  res.json({ ok: true });
});

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
