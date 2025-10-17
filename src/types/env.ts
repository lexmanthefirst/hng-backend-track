/**
 * Environment bindings for Cloudflare Workers
 */
export interface Env {
  // D1 Database binding
  DB: D1Database;

  // KV Storage binding
  KV: KVNamespace;

  // Environment variables
  ENVIRONMENT: "development" | "staging" | "production";
  JWT_SECRET: string;
  CORS_ORIGIN?: string;
  API_VERSION?: string;

  // Authentication (Better Auth)
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  NEXTAUTH_URL?: string; // For backward compatibility

  // OAuth Providers
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;

  // Cloudflare (for Drizzle Kit)
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_DATABASE_ID?: string;
  CLOUDFLARE_D1_TOKEN?: string;

  // External API URLs
  API_URL: string;
}

/**
 * Variables available in the Hono context
 */
export interface Variables {
  user?: {
    id: string;
    email: string;
    name: string;
    subscription_tier: string;
    avatar?: string;
  };
  authUser?: any; // From @hono/auth-js
}
