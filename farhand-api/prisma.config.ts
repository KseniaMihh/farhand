import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    // Lets `npx prisma db seed` run the same script as `npm run seed`.
    seed: "npm run seed",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
