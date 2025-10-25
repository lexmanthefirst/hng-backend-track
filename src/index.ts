import { Hono } from "hono";
import { cors } from "hono/cors";
import { v4 as uuidv4 } from "uuid";
import stringsRoute from "./routes/strings";
import countriesRoute from "./routes/countries";
import { getConnection } from "./db/hyperdrive";
import type { AppEnv } from "./types/app";

const app = new Hono<AppEnv>();
app.use("*", cors());
app.get("/", (c) => {
  return c.text("Hello HNG!");
});

app.get("/me", async (c) => {
  try {
    const response = await fetch(c.env.API_URL);
    const data = (await response.json()) as { fact: string };
    return c.json({
      status: "success",
      user: {
        id: uuidv4(),
        email: "lexmanthefirst@gmail.com",
        name: "Alex Okhitoya",
        stack: ["ExpressJs", "FastAPI", "Hono"],
      },
      timestamp: new Date().toISOString(),
      fact: data.fact,
    });
  } catch (error) {
    console.error("Error fetching data:", error);
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to fetch data",
      },
      500
    );
  }
});

app.route("/strings", stringsRoute);
app.route("/countries", countriesRoute);

app.get("/view-tables", async (c) => {
  const connection = await getConnection(c.env);

  try {
    const [results] = await connection.query("SHOW TABLES;");
    return c.json({ tables: results });
  } catch (error) {
    console.error("Error fetching tables:", error);
    return c.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to fetch tables",
      },
      500
    );
  } finally {
    c.executionCtx.waitUntil(connection.end());
  }
});

app.post("/create-table", async (c) => {
  const connection = await getConnection(c.env);

  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS country_currency_exchange_rates (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(191) NOT NULL,
        capital VARCHAR(191) NULL,
        region VARCHAR(100) NULL,
        population BIGINT UNSIGNED NOT NULL,
        currency_code CHAR(3) NULL,
        exchange_rate DECIMAL(18,6) NULL,
        estimated_gdp DECIMAL(18,6) NULL,
        flag_url VARCHAR(255) NULL,
        last_refreshed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_country_name (name),
        INDEX idx_region (region),
        INDEX idx_currency (currency_code),
        INDEX idx_refresh (last_refreshed_at)
      )
    `);

    return c.json({ message: "Table ensured" });
  } catch (error) {
    console.error("Failed to create table", error);
    return c.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to create table",
      },
      500
    );
  } finally {
    c.executionCtx.waitUntil(connection.end());
  }
});

export default app;
