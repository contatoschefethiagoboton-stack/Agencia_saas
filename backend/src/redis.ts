import { createClient } from 'redis';

// Sem REDIS_URL o cliente tenta localhost:6379, que não existe no Render: falha logo, com mensagem clara.
if (!process.env.REDIS_URL && process.env.NODE_ENV === 'production') {
  console.error('[redis] REDIS_URL não definida. Crie um Key Value (Redis) no Render e copie a "Internal Key Value URL" para a variável REDIS_URL do serviço.');
  process.exit(1);
}

export const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', err => console.error('[redis]', err.message || err.code || err));
await redis.connect();
