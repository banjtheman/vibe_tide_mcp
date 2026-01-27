#!/usr/bin/env node

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";
import { spawn } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "server.ts");

// Resolve tsx from wherever it's installed
const require = createRequire(import.meta.url);
const tsxPath = require.resolve("tsx/cli");

spawn("node", [tsxPath, serverPath], {
  stdio: "inherit",
  env: process.env,
}).on("exit", (code) => process.exit(code ?? 0));
