import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/Domain/Schema.ts",
  out: "./migrations",
});
