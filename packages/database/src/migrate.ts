import { openDatabase } from "./index.js";
const database = openDatabase(
  process.env.DATABASE_URL || "file:./.data/octoagent.sqlite"
);
try {
  database.migrate();
  console.log("Database migrations applied.");
} finally {
  database.close();
}
