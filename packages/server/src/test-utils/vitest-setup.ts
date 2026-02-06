import path from "node:path";
import dotenv from "dotenv";

// Load package-local .env.test first for integration/E2E credentials, then repo-root .env fallback.
dotenv.config({ path: path.resolve(process.cwd(), ".env.test"), override: true });
dotenv.config({ path: path.resolve(process.cwd(), "../.env") });

process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GIT_SSH_COMMAND = "ssh -oBatchMode=yes";
process.env.SSH_ASKPASS = "/usr/bin/false";
process.env.SSH_ASKPASS_REQUIRE = "force";
process.env.DISPLAY = process.env.DISPLAY ?? "1";
