/**
 * Processo separado dos workers (no Render: um "Background Worker" apontando para este arquivo).
 * Escala horizontalmente: a fila usa FOR UPDATE SKIP LOCKED e o Redis coordena a cadência.
 */
import 'express-async-errors';
import { runOutboxWorker } from './whatsapp/outboxWorker.js';
import { runAiWorker } from './whatsapp/aiAgent.js';

await Promise.all([runOutboxWorker(), runAiWorker()]);
