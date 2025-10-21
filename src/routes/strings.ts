import { Hono } from "hono";
import { zValidator, type Hook } from "@hono/zod-validator";
import { z } from "zod";
import type { AppEnv, AppContext } from "../types/app";
import { getValid } from "../types/app";

// Expects a D1 table named `strings` with columns:
// id TEXT PRIMARY KEY, value TEXT UNIQUE, length INTEGER, is_palindrome INTEGER,
// unique_characters INTEGER, word_count INTEGER, character_frequency_map TEXT, created_at TEXT.

const stringsRoute = new Hono<AppEnv>();
const encoder = new TextEncoder();

const createStringSchema = z.object({
  value: z.string().refine((val) => val.trim().length > 0, {
    message: '"value" must not be empty',
  }),
});

const listStringsQuerySchema = z.object({
  is_palindrome: z
    .enum(["true", "false"])
    .transform((flag) => flag === "true")
    .optional(),
  min_length: z.coerce.number().int().min(0).optional(),
  max_length: z.coerce.number().int().min(0).optional(),
  word_count: z.coerce.number().int().min(0).optional(),
  contains_character: z.string().length(1).optional(),
});

const queryParamSchema = z.object({
  value: z.string().min(1),
});

const naturalLanguageQuerySchema = z.object({
  query: z.string().min(1),
});

type StringProperties = {
  length: number;
  is_palindrome: boolean;
  unique_characters: number;
  word_count: number;
  sha256_hash: string;
  character_frequency_map: Record<string, number>;
};

type StoredStringRecord = {
  id: string;
  value: string;
  properties: StringProperties;
  created_at: string;
};

type StoredStringRow = {
  id: string;
  value: string;
  length: number;
  is_palindrome: number;
  unique_characters: number;
  word_count: number;
  character_frequency_map: string;
  created_at: string;
};

type QueryFilters = {
  is_palindrome?: boolean;
  min_length?: number;
  max_length?: number;
  word_count?: number;
  contains_character?: string;
};

const normalizeForPalindrome = (input: string): string =>
  input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove accents
    .replace(/[^a-z0-9]/gi, ""); // strip punctuation, spaces

const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const calculateWordCount = (input: string): number => {
  const trimmed = input.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
};

const buildCharacterFrequencyMap = (input: string): Record<string, number> => {
  const frequency: Record<string, number> = {};
  for (const char of Array.from(input)) {
    frequency[char] = (frequency[char] ?? 0) + 1;
  }
  return frequency;
};

const computeStringProperties = async (
  value: string
): Promise<StringProperties> => {
  const normalized = normalizeForPalindrome(value);
  const reversed = normalized.split("").reverse().join("");
  const shaBuffer = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(value)
  );

  return {
    length: Array.from(value).length,
    is_palindrome: normalized.length > 0 && normalized === reversed,
    unique_characters: new Set(Array.from(value)).size,
    word_count: calculateWordCount(value),
    sha256_hash: toHex(shaBuffer),
    character_frequency_map: buildCharacterFrequencyMap(value),
  };
};

const parseFrequencyMap = (raw: string): Record<string, number> => {
  try {
    const parsed = JSON.parse(raw) as Record<string, number>;
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    // fall through to empty object
  }
  return {};
};

const mapRowToRecord = (row: StoredStringRow): StoredStringRecord => ({
  id: row.id,
  value: row.value,
  properties: {
    length: row.length,
    is_palindrome: Boolean(row.is_palindrome),
    unique_characters: row.unique_characters,
    word_count: row.word_count,
    sha256_hash: row.id,
    character_frequency_map: parseFrequencyMap(row.character_frequency_map),
  },
  created_at: row.created_at,
});

const applyFilters = (records: StoredStringRecord[], filters: QueryFilters) =>
  records.filter((record) => {
    const props = record.properties;

    if (
      filters.is_palindrome !== undefined &&
      props.is_palindrome !== filters.is_palindrome
    ) {
      return false;
    }

    if (filters.min_length !== undefined && props.length < filters.min_length) {
      return false;
    }

    if (filters.max_length !== undefined && props.length > filters.max_length) {
      return false;
    }

    if (
      filters.word_count !== undefined &&
      props.word_count !== filters.word_count
    ) {
      return false;
    }

    if (filters.contains_character !== undefined) {
      const candidate = filters.contains_character.toLowerCase();
      if (!record.value.toLowerCase().includes(candidate)) {
        return false;
      }
    }

    return true;
  });

const fetchRecords = async (
  c: AppContext,
  filters: QueryFilters
): Promise<StoredStringRecord[]> => {
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (filters.is_palindrome !== undefined) {
    conditions.push("is_palindrome = ?");
    params.push(filters.is_palindrome ? 1 : 0);
  }

  if (filters.min_length !== undefined) {
    conditions.push("length >= ?");
    params.push(filters.min_length);
  }

  if (filters.max_length !== undefined) {
    conditions.push("length <= ?");
    params.push(filters.max_length);
  }

  if (filters.word_count !== undefined) {
    conditions.push("word_count = ?");
    params.push(filters.word_count);
  }

  if (filters.contains_character !== undefined) {
    conditions.push("LOWER(value) LIKE ?");
    params.push(`%${filters.contains_character.toLowerCase()}%`);
  }

  let statement = c.env.DB.prepare(
    `SELECT id, value, length, is_palindrome, unique_characters, word_count, character_frequency_map, created_at
     FROM strings${
       conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""
     }
     ORDER BY created_at DESC`
  );

  if (params.length > 0) {
    statement = statement.bind(...params);
  }

  const result = await statement.all<StoredStringRow>();
  const rows = result.results ?? [];
  return rows.map(mapRowToRecord);
};

type NaturalLanguageParseResult =
  | { type: "success"; filters: QueryFilters }
  | { type: "conflict"; message: string }
  | { type: "unparsed"; message: string };

const parseNaturalLanguageQuery = (
  query: string
): NaturalLanguageParseResult => {
  const normalized = query.trim();
  if (!normalized) {
    return {
      type: "unparsed",
      message: "Unable to parse natural language query",
    };
  }

  const filters: QueryFilters = {};
  const conflicts: string[] = [];
  let parsed = false;
  const lower = normalized.toLowerCase();

  const setFilter = <K extends keyof QueryFilters>(
    key: K,
    value: QueryFilters[K]
  ) => {
    if (filters[key] !== undefined && filters[key] !== value) {
      conflicts.push(key as string);
      return;
    }
    if (filters[key] === undefined) {
      filters[key] = value;
      parsed = true;
    }
  };

  if (lower.includes("single word")) {
    setFilter("word_count", 1);
  }

  if (lower.includes("palindromic") || lower.includes("palindrome")) {
    setFilter("is_palindrome", true);
  }

  const longerMatch = lower.match(/longer than\s*(\d+)/);
  if (longerMatch) {
    setFilter("min_length", Number(longerMatch[1]) + 1);
  }

  if (lower.includes("first vowel")) {
    setFilter("contains_character", "a");
  }

  const containsLetterMatch = lower.match(
    /contain(?:ing)?\s+(?:the\s+)?letter\s*([a-z])/
  );
  if (containsLetterMatch) {
    setFilter("contains_character", containsLetterMatch[1]);
  }

  const containsCharacterMatch = lower.match(
    /contain(?:ing)?\s+(?:the\s+)?character\s*([a-z])/
  );
  if (containsCharacterMatch) {
    setFilter("contains_character", containsCharacterMatch[1]);
  }

  if (conflicts.length > 0) {
    return {
      type: "conflict",
      message: "Query parsed but resulted in conflicting filters",
    };
  }

  if (
    filters.min_length !== undefined &&
    filters.max_length !== undefined &&
    filters.min_length > filters.max_length
  ) {
    return {
      type: "conflict",
      message: "Query parsed but resulted in conflicting filters",
    };
  }

  if (!parsed) {
    return {
      type: "unparsed",
      message: "Unable to parse natural language query",
    };
  }

  return { type: "success", filters };
};

const createStringValidationHook: Hook<
  z.infer<typeof createStringSchema>,
  AppEnv,
  string,
  "json",
  {},
  typeof createStringSchema
> = (result, c) => {
  if (result.success) {
    return;
  }

  const issue = result.error.issues[0];
  if (issue?.code === "invalid_type") {
    const received = (issue as { received?: string }).received;
    if (received === "undefined") {
      return c.json(
        { error: 'Invalid request body or missing "value" field' },
        400
      );
    }
    return c.json(
      { error: 'Invalid data type for "value" (must be string)' },
      422
    );
  }

  return c.json(
    { error: 'Invalid request body or missing "value" field' },
    400
  );
};

const listStringsValidationHook: Hook<
  z.infer<typeof listStringsQuerySchema>,
  AppEnv,
  string,
  "query",
  {},
  typeof listStringsQuerySchema
> = (result, c) => {
  if (result.success) {
    return;
  }

  return c.json({ error: "Invalid query parameter values or types" }, 400);
};

const naturalLanguageValidationHook: Hook<
  z.infer<typeof naturalLanguageQuerySchema>,
  AppEnv,
  string,
  "query",
  {},
  typeof naturalLanguageQuerySchema
> = (result, c) => {
  if (result.success) {
    return;
  }

  return c.json({ error: "Query parameter 'query' is required" }, 400);
};

stringsRoute.post(
  "/",
  zValidator("json", createStringSchema, createStringValidationHook),
  async (c: AppContext) => {
    const { value } = getValid<z.infer<typeof createStringSchema>>(c, "json");
    const properties = await computeStringProperties(value);

    const existing = await c.env.DB.prepare(
      "SELECT id FROM strings WHERE id = ? OR value = ? LIMIT 1"
    )
      .bind(properties.sha256_hash, value)
      .first<{ id: string }>();

    if (existing) {
      return c.json({ error: "String already exists in the system" }, 409);
    }

    const created_at = new Date().toISOString();

    await c.env.DB.prepare(
      `INSERT INTO strings (id, value, length, is_palindrome, unique_characters, word_count, character_frequency_map, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        properties.sha256_hash,
        value,
        properties.length,
        properties.is_palindrome ? 1 : 0,
        properties.unique_characters,
        properties.word_count,
        JSON.stringify(properties.character_frequency_map),
        created_at
      )
      .run();

    const record: StoredStringRecord = {
      id: properties.sha256_hash,
      value,
      properties,
      created_at,
    };

    return c.json(record, 201);
  }
);

stringsRoute.get(
  "/filter-by-natural-language",
  zValidator(
    "query",
    naturalLanguageQuerySchema,
    naturalLanguageValidationHook
  ),
  async (c: AppContext) => {
    const { query } = getValid<z.infer<typeof naturalLanguageQuerySchema>>(
      c,
      "query"
    );
    const parseResult = parseNaturalLanguageQuery(query);

    if (parseResult.type === "unparsed") {
      return c.json({ error: parseResult.message }, 400);
    }

    if (parseResult.type === "conflict") {
      return c.json({ error: parseResult.message }, 422);
    }

    const filters = parseResult.filters;
    const records = await fetchRecords(c, filters);

    return c.json({
      data: records,
      count: records.length,
      interpreted_query: {
        original: query,
        parsed_filters: filters,
      },
    });
  }
);

stringsRoute.get(
  "/",
  zValidator("query", listStringsQuerySchema, listStringsValidationHook),
  async (c: AppContext) => {
    const query = getValid<z.infer<typeof listStringsQuerySchema>>(c, "query");
    const filters: QueryFilters = {
      is_palindrome: query.is_palindrome,
      min_length: query.min_length,
      max_length: query.max_length,
      word_count: query.word_count,
      contains_character: query.contains_character,
    };

    if (
      filters.min_length !== undefined &&
      filters.max_length !== undefined &&
      filters.min_length > filters.max_length
    ) {
      return c.json({ error: "Invalid query parameter values or types" }, 400);
    }

    const records = await fetchRecords(c, filters);
    const filtersApplied = Object.fromEntries(
      Object.entries(filters).filter(([, value]) => value !== undefined)
    );

    return c.json({
      data: records,
      count: records.length,
      filters_applied: filtersApplied,
    });
  }
);

stringsRoute.get(
  "/:value",
  zValidator("param", queryParamSchema),
  async (c: AppContext) => {
    const { value } = getValid<z.infer<typeof queryParamSchema>>(c, "param");
    const decodedValue = decodeURIComponent(value);

    const row = await c.env.DB.prepare(
      `SELECT id, value, length, is_palindrome, unique_characters, word_count, character_frequency_map, created_at
       FROM strings WHERE value = ? LIMIT 1`
    )
      .bind(decodedValue)
      .first<StoredStringRow>();

    if (!row) {
      return c.json({ error: "String does not exist in the system" }, 404);
    }

    return c.json(mapRowToRecord(row));
  }
);

stringsRoute.delete(
  "/by-value/:value",
  zValidator("param", queryParamSchema),
  async (c: AppContext) => {
    const { value } = getValid<z.infer<typeof queryParamSchema>>(c, "param");
    const decodedValue = decodeURIComponent(value);

    const result = await c.env.DB.prepare("DELETE FROM strings WHERE value = ?")
      .bind(decodedValue)
      .run();

    const changes = result.meta?.changes ?? 0;
    if (!result.success || changes === 0) {
      return c.json({ error: "String does not exist in the system" }, 404);
    }

    return c.body(null, 204);
  }
);

stringsRoute.delete(
  "/by-id/:id",
  zValidator("param", z.object({ id: z.string().min(1) })),
  async (c: AppContext) => {
    const { id } = getValid<{ id: string }>(c, "param");
    const decodedId = decodeURIComponent(id);

    const result = await c.env.DB.prepare("DELETE FROM strings WHERE id = ?")
      .bind(decodedId)
      .run();

    const changes = result.meta?.changes ?? 0;
    if (!result.success || changes === 0) {
      return c.json({ error: "String does not exist in the system" }, 404);
    }

    return c.body(null, 204);
  }
);

export default stringsRoute;
