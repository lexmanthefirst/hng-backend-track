import { Hono } from "hono";
import { cors } from "hono/cors";
import { v4 as uuidv4 } from "uuid";

const app = new Hono();
app.use("*", cors());
app.get("/", (c) => {
  return c.text("Hello Hono!");
});

app.get("/me", async (c) => {
  try {
    const response = await fetch("https://catfact.ninja/fact");
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
