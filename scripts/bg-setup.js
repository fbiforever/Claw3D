#!/usr/bin/env node
/**
 * BG Intelligence Claw3D Setup Script
 * Logs in to the BG Intelligence backend and saves the JWT token to .env.local
 *
 * Usage:  npm run bg-setup
 */
"use strict";

const http = require("http");
const https = require("https");
const readline = require("readline");
const fs = require("fs");
const path = require("path");

const ENV_FILE = path.join(__dirname, "..", ".env.local");

function loadEnv(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

function updateEnvFile(filePath, key, value) {
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const regex = new RegExp(`^(${key}\\s*=).*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, `$1${value}`);
  } else {
    content += `\n${key}=${value}\n`;
  }
  fs.writeFileSync(filePath, content, "utf8");
}

async function post(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;
    const bodyStr = JSON.stringify(body);
    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function main() {
  const existing = loadEnv(ENV_FILE);
  const apiUrl = (existing.BG_INTELLIGENCE_API_URL || "http://localhost:8001").replace(/\/$/, "");

  console.log("\n  BG Intelligence × Claw3D Setup");
  console.log("  ─────────────────────────────────────");
  console.log(`  Backend: ${apiUrl}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const email = await prompt(rl, "  Email    : ");
  // Hide password input if possible
  process.stdout.write("  Password : ");
  const password = await new Promise((resolve) => {
    const chars = [];
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", function onData(key) {
      if (key === "\r" || key === "\n") {
        process.stdin.setRawMode?.(false);
        process.stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(chars.join(""));
      } else if (key === "\u0003") {
        process.exit();
      } else if (key === "\u007f") {
        chars.pop();
        process.stdout.clearLine?.(0);
        process.stdout.cursorTo?.(0);
        process.stdout.write("  Password : " + "*".repeat(chars.length));
      } else {
        chars.push(key);
        process.stdout.write("*");
      }
    });
  });

  rl.close();

  console.log("\n  Authenticating...");

  let res;
  try {
    res = await post(`${apiUrl}/api/auth/login`, { email, password });
  } catch (err) {
    console.error(`\n  ERROR: Cannot reach backend at ${apiUrl}`);
    console.error(`  Make sure the BG Intelligence backend is running.`);
    console.error(`  Details: ${err.message}`);
    process.exit(1);
  }

  if (res.status !== 200 || !res.body?.token) {
    console.error(`\n  Login failed (HTTP ${res.status}).`);
    if (res.body?.detail) console.error(`  Reason: ${res.body.detail}`);
    process.exit(1);
  }

  const token = res.body.token;
  updateEnvFile(ENV_FILE, "BG_INTELLIGENCE_API_TOKEN", token);

  console.log("  ✔  Token saved to .env.local");
  console.log("\n  Next steps:");
  console.log("  1. In one terminal:  npm run bg-adapter");
  console.log("  2. In another:       npm run dev");
  console.log("  3. Open:             http://localhost:3000");
  console.log("  4. Connect screen:   ws://localhost:18790 → Custom provider");
  console.log("");
}

main().catch((err) => {
  console.error("Setup failed:", err.message);
  process.exit(1);
});
