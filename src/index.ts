import { Hono } from "hono";
import { cors } from "hono/cors";
import { v4 as uuidv4 } from "uuid";
import { Env } from "./types/env";

const app = new Hono<{ Bindings: Env }>();
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
        stack: "ExpressJs, FastAPI, and Hono",
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

export default app;
