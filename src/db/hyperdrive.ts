import { createConnection } from "mysql2/promise";
import type { AppEnv } from "../types/app";

export const getConnection = async (env: AppEnv["Bindings"]) =>
  (await createConnection({
    host: env.HYPERDRIVE.host,
    user: env.HYPERDRIVE.user,
    password: env.HYPERDRIVE.password,
    database: env.HYPERDRIVE.database,
    port: env.HYPERDRIVE.port,

    disableEval: true,
    enableKeepAlive: true, // reuse HTTP connection to Hyperdrive
  })) as Awaited<ReturnType<typeof createConnection>> & {
    query: (sql: string, params?: unknown[]) => Promise<[unknown, unknown]>;
  };
