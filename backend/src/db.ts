import pg from 'pg';
import type { PoolClient } from 'pg';

// Sem as três URLs separadas (ex.: Render com um único usuário), todas caem em DATABASE_URL.
const url = (specific?: string) => specific || process.env.DATABASE_URL;

export const appPool     = new pg.Pool({ connectionString: url(process.env.DATABASE_URL_APP), max: 20 });
export const servicePool = new pg.Pool({ connectionString: url(process.env.DATABASE_URL_SERVICE), max: 10 });
export const adminPool   = new pg.Pool({ connectionString: url(process.env.DATABASE_URL_ADMIN), max: 5 });

type Fn<T> = (c: PoolClient) => Promise<T>;

async function tx<T>(pool: pg.Pool, setup: (c: PoolClient) => Promise<void>, fn: Fn<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await setup(c);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** Toda query de cliente passa por aqui: o RLS filtra pelo tenant da transação. */
export const withTenant = <T>(tenantId: string, fn: Fn<T>, pool = appPool) =>
  tx(pool, c => c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]).then(() => {}), fn);

/** Operações financeiras (ledger) — nunca expostas diretamente a rotas de cliente. */
export const withService = <T>(fn: Fn<T>) => tx(servicePool, async () => {}, fn);

/** Painel Master — só chamado depois de requireAdmin + step-up 2FA. */
export const withAdmin = <T>(fn: Fn<T>) => tx(adminPool, async () => {}, fn);
