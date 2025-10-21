import { Hono } from "hono";
import { cors } from "hono/cors";
import { v4 as uuidv4 } from "uuid";
import stringsRoute from "./routes/strings";
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

export default app;
