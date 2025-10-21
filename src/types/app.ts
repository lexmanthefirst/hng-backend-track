import type { Context } from "hono";
import type { Env, Variables } from "./env";

export type AppEnv = { Bindings: Env; Variables: Variables };
export type AppContext = Context<AppEnv>;

export const getValid = <T>(c: AppContext, target: string): T =>
  c.req.valid(target as never) as T;
