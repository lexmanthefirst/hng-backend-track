// mysql2 v3.13.0 or later is required for Cloudflare Workers compatibility
import { createConnection } from "mysql2/promise";

export interface Env {
  // If you set another name in the Wrangler config file as the value for 'binding',
  // replace "HYPERDRIVE" with the variable name you defined.
  HYPERDRIVE: Hyperdrive;
}

export default {
  async fetch(_request, env, ctx): Promise<Response> {
    type QueryableConnection = Awaited<ReturnType<typeof createConnection>> & {
      query: (sql: string, values?: unknown[]) => Promise<[unknown, unknown]>;
    };

    let connection: QueryableConnection | null = null;

    try {
      // Create a connection using the mysql2 driver (or any supported driver, ORM, or query builder)
      // with the Hyperdrive credentials. These credentials are only accessible from your Worker.
      connection = (await createConnection({
        host: env.HYPERDRIVE.host,
        user: env.HYPERDRIVE.user,
        password: env.HYPERDRIVE.password,
        database: env.HYPERDRIVE.database,
        port: env.HYPERDRIVE.port,
        // The following options are required for mysql2 to run in Workers.
        // mysql2 uses eval() to optimize result parsing for rows with >100 columns.
        // Configure mysql2 to use static parsing with disableEval and keep the HTTP transport.
        disableEval: true,
        enableKeepAlive: true,
      })) as QueryableConnection;

      // Sample query – replace with your application logic.
      const [results, fields] = await connection.query("SHOW TABLES;");

      // Return result rows as JSON.
      return new Response(JSON.stringify({ results, fields }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (error) {
      console.error("Hyperdrive query failed", error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    } finally {
      if (connection) {
        ctx.waitUntil(connection.end());
      }
    }
  },
} satisfies ExportedHandler<Env>;
