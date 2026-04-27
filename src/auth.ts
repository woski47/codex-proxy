import { readFile, writeFile } from "fs/promises";
import { access } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";

async function resolveAuthPath(): Promise<string> {
  if (process.env.CLAUDE_PROXY_AUTH_PATH) return process.env.CLAUDE_PROXY_AUTH_PATH;
  const primary = join(homedir(), ".local/share/opencode/auth.json");
  try { await access(primary); return primary; } catch {}
  // Fallback: .auth.json next to the proxy repo (Replit persistent storage)
  const local = join(dirname(import.meta.dir), ".auth.json");
  try { await access(local); return local; } catch {}
  return primary; // will fail with clear ENOENT
}

let AUTH_PATH: string;
const REFRESH_URL = "https://console.anthropic.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const EXPIRY_BUFFER_MS = 60_000;

// Direct token injection — no file needed.
// CLAUDE_PROXY_OAUTH_TOKEN: access token (required)
// CLAUDE_PROXY_OAUTH_REFRESH: refresh token (optional, enables auto-refresh)
const ENV_TOKEN = process.env.CLAUDE_PROXY_OAUTH_TOKEN;
const ENV_REFRESH = process.env.CLAUDE_PROXY_OAUTH_REFRESH;

interface AuthData {
  anthropic: {
    type: string;
    access: string;
    refresh: string;
    expires: number;
  };
}

let cached: AuthData | null = null;
let refreshing: Promise<string> | null = null;

async function readAuth(): Promise<AuthData> {
  if (ENV_TOKEN) {
    console.log("[auth] Using token from CLAUDE_PROXY_OAUTH_TOKEN env var");
    return {
      anthropic: {
        type: "oauth",
        access: ENV_TOKEN,
        refresh: ENV_REFRESH || "",
        expires: ENV_REFRESH ? Date.now() + 3600_000 : Infinity,
      },
    };
  }
  if (!AUTH_PATH) {
    AUTH_PATH = await resolveAuthPath();
    console.log("[auth] Using auth file:", AUTH_PATH);
  }
  const raw = await readFile(AUTH_PATH, "utf-8");
  return JSON.parse(raw);
}

async function writeAuth(data: AuthData): Promise<void> {
  if (ENV_TOKEN) return;
  if (!AUTH_PATH) AUTH_PATH = await resolveAuthPath();
  await writeFile(AUTH_PATH, JSON.stringify(data, null, 2) + "\n");
}

async function refreshToken(auth: AuthData): Promise<string> {
  if (!auth.anthropic.refresh) {
    throw new Error("No refresh token available — set CLAUDE_PROXY_OAUTH_REFRESH or provide auth.json");
  }
  console.log("[auth] Refreshing OAuth token...");
  const res = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: auth.anthropic.refresh,
      client_id: CLIENT_ID,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  auth.anthropic.access = data.access_token;
  if (data.refresh_token) auth.anthropic.refresh = data.refresh_token;
  auth.anthropic.expires = Date.now() + data.expires_in * 1000;

  await writeAuth(auth);
  cached = auth;
  console.log("[auth] Token refreshed, expires in", data.expires_in, "s");
  return auth.anthropic.access;
}

export async function getAccessToken(): Promise<string> {
  if (!cached) cached = await readAuth();

  if (Date.now() < cached.anthropic.expires - EXPIRY_BUFFER_MS) {
    return cached.anthropic.access;
  }

  if (!cached.anthropic.refresh) {
    return cached.anthropic.access; // no refresh token, use what we have
  }

  // Mutex: single concurrent refresh
  if (!refreshing) {
    refreshing = refreshToken(cached).finally(() => { refreshing = null; });
  }
  return refreshing;
}

export function getTokenExpiry(): number {
  return cached?.anthropic.expires ?? 0;
}
