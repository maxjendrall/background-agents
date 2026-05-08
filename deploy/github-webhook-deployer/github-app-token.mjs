#!/usr/bin/env node
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

const appId = process.env.GITHUB_APP_ID;
const installationId = process.env.GITHUB_INSTALLATION_ID;
const pemPath = process.env.GITHUB_APP_PEM_PATH;
if (!appId || !installationId || !pemPath) {
  console.error("GITHUB_APP_ID, GITHUB_INSTALLATION_ID, and GITHUB_APP_PEM_PATH are required");
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
const signingInput = `${header}.${payload}`;
const signer = createSign("RSA-SHA256");
signer.update(signingInput);
const jwt = `${signingInput}.${signer.sign(readFileSync(pemPath), "base64url")}`;

const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
  method: "POST",
  headers: {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${jwt}`,
    "user-agent": "background-agents-deployer",
    "x-github-api-version": "2022-11-28",
  },
});
const data = await res.json().catch(() => ({}));
if (!res.ok || !data.token) {
  console.error(JSON.stringify({ status: res.status, data }, null, 2));
  process.exit(1);
}
process.stdout.write(data.token);
