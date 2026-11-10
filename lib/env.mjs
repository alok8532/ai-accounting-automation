// Loads <project>/.env into process.env (Node's built-in loader, no extra package).
// Values already set in the real environment win. .env is git-ignored: secrets live only there.

import { join } from "node:path";
import { ROOT } from "./config.mjs";

let loaded = false;
export function loadDotEnv() {
  if (loaded) return;
  loaded = true;
  try {
    process.loadEnvFile(process.env.DOTENV_FILE || join(ROOT, ".env"));
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`Cannot read .env: ${e.message}`);
  }
}
