/**
 * Processo separado dos workers (no Render: um "Background Worker" apontando para este arquivo).
 * Robôs e radar usam trava no Redis: duas instâncias nunca executam a mesma volta.
 */
import 'express-async-errors';
import { runBotEngine } from './bots/engine.js';
import { runRadar, runPriceAlerts } from './market/radar.js';

await Promise.all([runBotEngine(), runRadar(), runPriceAlerts()]);
