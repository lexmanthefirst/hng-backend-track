import { Hono } from "hono";
import { cors } from "hono/cors";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getConnection } from "../db/hyperdrive";
import type { AppEnv } from "../types/app";

const TABLE_NAME = "country_currency_exchange_rates";
const SUMMARY_IMAGE_KEY = "countries:summary-image";

type RestCountry = {
  name: string;
  capital?: string;
  region?: string;
  population: number;
  flag?: string;
  currencies?: Array<{ code?: string }>;
};

type ExchangeRatePayload = {
  result: string;
  rates?: Record<string, number>;
};

const RefreshBodySchema = z
  .object({
    limit: z.number().int().positive().max(300).optional(),
    currencyWhitelist: z
      .array(z.string().regex(/^[A-Z]{3}$/i))
      .max(50)
      .optional(),
  })
  .optional();

const CountriesQuerySchema = z.object({
  region: z.string().trim().min(1).max(100).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/i)
    .optional(),
  sort: z
    .enum(["gdp_desc", "gdp_asc", "population_desc", "population_asc"])
    .optional(),
});

const CountryParamSchema = z.object({
  name: z.string().min(1).max(191),
});

class ExternalDataError extends Error {
  source: "REST_COUNTRIES" | "EXCHANGE_RATE";

  constructor(message: string, source: "REST_COUNTRIES" | "EXCHANGE_RATE") {
    super(message);
    this.name = "ExternalDataError";
    this.source = source;
  }
}

const randomMultiplier = () => 1000 + Math.random() * 1000;

const roundToTwo = (value: number) => Math.round(value * 100) / 100;

const computeEstimatedGdp = (
  population: number,
  rate: number | null,
  hasCurrency: boolean
) => {
  if (!hasCurrency) {
    return 0;
  }

  if (!rate || rate <= 0) {
    return null;
  }

  return roundToTwo((population * randomMultiplier()) / rate);
};

const getPrimaryCurrency = (country: RestCountry) => {
  const [primary] = country.currencies ?? [];
  const code = primary?.code;
  return code ? code.toUpperCase() : null;
};

const buildSummarySvg = (
  total: number,
  topCountries: Array<{ name: string; estimated_gdp: number | null }>,
  refreshedAt: string
) => {
  const topLines = topCountries
    .map((entry, index) => {
      const label =
        entry.estimated_gdp !== null ? roundToTwo(entry.estimated_gdp) : "N/A";
      return `<text x="20" y="${
        80 + index * 24
      }" font-size="14" fill="#f8fafc">${index + 1}. ${
        entry.name
      } - ${label}</text>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="600" height="${
    160 + topCountries.length * 24
  }" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#0f172a" />
  <text x="20" y="30" font-size="20" fill="#f8fafc" font-weight="bold">Countries Summary</text>
  <text x="20" y="60" font-size="16" fill="#e2e8f0">Total Countries: ${total}</text>
  <text x="20" y="90" font-size="16" fill="#e2e8f0" font-weight="bold">Top 5 by Estimated GDP</text>
  ${topLines}
  <text x="20" y="${
    130 + topCountries.length * 24
  }" font-size="12" fill="#94a3b8">Last Refresh: ${refreshedAt}</text>
</svg>`;
};

const buildCountryQuery = (filters: z.infer<typeof CountriesQuerySchema>) => {
  const clauses: string[] = [];
  const values: string[] = [];

  if (filters.region) {
    clauses.push("region = ?");
    values.push(filters.region);
  }

  if (filters.currency) {
    clauses.push("currency_code = ?");
    values.push(filters.currency.toUpperCase());
  }

  const ordering: Record<string, string> = {
    gdp_desc: "estimated_gdp DESC",
    gdp_asc: "estimated_gdp ASC",
    population_desc: "population DESC",
    population_asc: "population ASC",
  };

  const orderBy = filters.sort
    ? ordering[filters.sort]
    : "last_refreshed_at DESC";
  const whereClause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  return {
    sql: `SELECT * FROM ${TABLE_NAME} ${whereClause} ORDER BY ${orderBy}`,
    values,
  };
};

const fetchJson = async <T>(
  url: string,
  source: "REST_COUNTRIES" | "EXCHANGE_RATE",
  timeoutMs = 15000
): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new ExternalDataError(`Failed to fetch ${source}`, source);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ExternalDataError) {
      throw error;
    }

    if ((error as Error).name === "AbortError") {
      throw new ExternalDataError(`${source} request timed out`, source);
    }

    throw new ExternalDataError(`Unexpected error reaching ${source}`, source);
  } finally {
    clearTimeout(timeout);
  }
};

const countriesRoute = new Hono<AppEnv>();

countriesRoute.use("*", cors());

countriesRoute.post(
  "/refresh",
  zValidator("json", RefreshBodySchema, (result, c) => {
    if (!result.success) {
      return c.json(
        { error: "Validation failed", details: result.error.issues },
        400
      );
    }
  }),
  async (c) => {
    const body = c.req.valid("json") ?? {};
    const whitelist = body.currencyWhitelist?.map((code) => code.toUpperCase());
    const whitelistSet = whitelist ? new Set(whitelist) : null;
    const limit = body.limit;

    try {
      const [countries, exchangeRates] = await Promise.all([
        fetchJson<RestCountry[]>(
          "https://restcountries.com/v2/all?fields=name,capital,region,population,flag,currencies",
          "REST_COUNTRIES"
        ),
        fetchJson<ExchangeRatePayload>(
          "https://open.er-api.com/v6/latest/USD",
          "EXCHANGE_RATE"
        ),
      ]);

      const ratesMap = exchangeRates.rates ?? {};
      const start = Date.now();
      const connection = await getConnection(c.env);

      let refreshCount = 0;
      let statusRow: {
        total_countries: number;
        last_refreshed_at: string | null;
      } = {
        total_countries: 0,
        last_refreshed_at: null,
      };
      let topCountries: Array<{ name: string; estimated_gdp: number | null }> =
        [];

      const upsertSql = `
        INSERT INTO ${TABLE_NAME}
          (name, capital, region, population, currency_code, exchange_rate, estimated_gdp, flag_url, last_refreshed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE
          capital = VALUES(capital),
          region = VALUES(region),
          population = VALUES(population),
          currency_code = VALUES(currency_code),
          exchange_rate = VALUES(exchange_rate),
          estimated_gdp = VALUES(estimated_gdp),
          flag_url = VALUES(flag_url),
          last_refreshed_at = CURRENT_TIMESTAMP
      `;

      try {
        for (const country of countries) {
          if (limit && refreshCount >= limit) {
            break;
          }

          const currencyCode = getPrimaryCurrency(country);
          if (
            whitelistSet &&
            (!currencyCode || !whitelistSet.has(currencyCode))
          ) {
            continue;
          }

          const rate = currencyCode ? ratesMap[currencyCode] ?? null : null;
          const hasCurrency = Boolean(currencyCode);
          const estimatedGdp = computeEstimatedGdp(
            country.population ?? 0,
            rate,
            hasCurrency
          );

          await connection.query(upsertSql, [
            country.name,
            country.capital ?? null,
            country.region ?? null,
            country.population ?? 0,
            currencyCode,
            rate,
            estimatedGdp,
            country.flag ?? null,
          ]);

          refreshCount += 1;
        }

        const [statusRows] = await connection.query(
          `SELECT COUNT(*) AS total_countries, MAX(last_refreshed_at) AS last_refreshed_at FROM ${TABLE_NAME}`
        );
        statusRow = (statusRows as Array<typeof statusRow>)[0] ?? statusRow;

        const [topRows] = await connection.query(
          `SELECT name, estimated_gdp FROM ${TABLE_NAME} WHERE estimated_gdp IS NOT NULL ORDER BY estimated_gdp DESC LIMIT 5`
        );
        topCountries = (
          topRows as Array<{ name: string; estimated_gdp: number | null }>
        ).map((row) => ({
          name: row.name,
          estimated_gdp: row.estimated_gdp,
        }));
      } finally {
        c.executionCtx.waitUntil(connection.end());
      }

      const lastRefreshedAt =
        statusRow.last_refreshed_at ?? new Date().toISOString();
      const summarySvg = buildSummarySvg(
        statusRow.total_countries ?? 0,
        topCountries,
        lastRefreshedAt
      );

      await c.env.KV.put(SUMMARY_IMAGE_KEY, summarySvg, {
        metadata: { lastRefreshedAt },
      });

      return c.json({
        message: `Refreshed ${refreshCount} countries`,
        durationMs: Date.now() - start,
        lastRefreshedAt,
      });
    } catch (error) {
      if (error instanceof ExternalDataError) {
        return c.json(
          {
            error: "External data source unavailable",
            details:
              error.source === "REST_COUNTRIES"
                ? "Could not fetch data from REST Countries"
                : "Could not fetch data from ExchangeRate-API",
          },
          503
        );
      }

      console.error("countries/refresh failed", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  }
);

countriesRoute.get(
  "/",
  zValidator("query", CountriesQuerySchema, (result, c) => {
    if (!result.success) {
      return c.json(
        { error: "Validation failed", details: result.error.issues },
        400
      );
    }
  }),
  async (c) => {
    const filters = c.req.valid("query");
    const connection = await getConnection(c.env);

    try {
      const { sql, values } = buildCountryQuery(filters);
      const [rows] = await connection.query(sql, values);
      return c.json(rows);
    } finally {
      c.executionCtx.waitUntil(connection.end());
    }
  }
);

countriesRoute.get("/status", async (c) => {
  const connection = await getConnection(c.env);

  try {
    const [rows] = await connection.query(
      `SELECT COUNT(*) AS total_countries, MAX(last_refreshed_at) AS last_refreshed_at FROM ${TABLE_NAME}`
    );
    const [status] = rows as Array<{
      total_countries: number;
      last_refreshed_at: string | null;
    }>;

    return c.json({
      total_countries: status?.total_countries ?? 0,
      last_refreshed_at: status?.last_refreshed_at ?? null,
    });
  } finally {
    c.executionCtx.waitUntil(connection.end());
  }
});

countriesRoute.get("/image", async (c) => {
  const svg = await c.env.KV.get(SUMMARY_IMAGE_KEY);

  if (!svg) {
    return c.json({ error: "Summary image not found" }, 404);
  }

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=60",
    },
  });
});

countriesRoute.get(
  "/:name",
  zValidator("param", CountryParamSchema, (result, c) => {
    if (!result.success) {
      return c.json(
        { error: "Validation failed", details: result.error.issues },
        400
      );
    }
  }),
  async (c) => {
    const { name } = c.req.valid("param");
    const connection = await getConnection(c.env);

    try {
      const [rows] = await connection.query(
        `SELECT * FROM ${TABLE_NAME} WHERE LOWER(name) = LOWER(?) LIMIT 1`,
        [name]
      );
      const [country] = rows as Array<Record<string, unknown>>;

      if (!country) {
        return c.json({ error: "Country not found" }, 404);
      }

      return c.json(country);
    } finally {
      c.executionCtx.waitUntil(connection.end());
    }
  }
);

countriesRoute.delete(
  "/:name",
  zValidator("param", CountryParamSchema, (result, c) => {
    if (!result.success) {
      return c.json(
        { error: "Validation failed", details: result.error.issues },
        400
      );
    }
  }),
  async (c) => {
    const { name } = c.req.valid("param");
    const connection = await getConnection(c.env);

    try {
      const [result] = await connection.query(
        `DELETE FROM ${TABLE_NAME} WHERE LOWER(name) = LOWER(?)`,
        [name]
      );
      const info = result as { affectedRows?: number };

      if (!info.affectedRows) {
        return c.json({ error: "Country not found" }, 404);
      }

      return c.body(null, 204);
    } finally {
      c.executionCtx.waitUntil(connection.end());
    }
  }
);

export default countriesRoute;
