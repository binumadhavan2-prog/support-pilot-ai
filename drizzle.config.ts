import { defineConfig } from "drizzle-kit";

try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local — rely on the real environment (CI, Docker).
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    // `generate` does not connect, so a placeholder keeps it working without a database.
    url: process.env.DATABASE_URL ?? "postgres://placeholder@localhost:5432/placeholder",
  },
  strict: true,
  verbose: true,
});
