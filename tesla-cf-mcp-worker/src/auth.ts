/**
 * Auth: Tesla-side token management (partner + third-party owner tokens with
 * KV-backed refresh rotation) and MCP-side access control (static bearer for
 * Claude Code, minimal OAuth 2.1 shim for claude.ai remote connectors).
 */

import { Env, TeslaError, TokenResponse, authBase, fleetBase, OWNER_SCOPES, PARTNER_SCOPES } from "./types";

// KV keys
const KV_REFRESH = "tesla:refresh_token";
const KV_ACCESS = "tesla:access_token";
const KV_STATE = (s: string) => `oauth_state:${s}`;
const KV_CODE = (c: string) => `mcp_oauth_code:${c}`;
const KV_MCP_TOKEN = (t: string) => `mcp_oauth_token:${t}`;

const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const randomHex = (bytes: number): string =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

// ---------------------------------------------------------------------------
// Tesla tokens
// ---------------------------------------------------------------------------

/**
 * Returns a valid owner (third-party) access token, refreshing via the
 * rotated refresh token in KV. Tesla rotates refresh tokens on every use, so
 * the newest one always lives in KV; TESLA_REFRESH_TOKEN only seeds it.
 */
// Tesla refresh tokens are single-use and rotate on every redemption. Two
// concurrent callers presenting the same stored token would both refresh —
// the loser gets invalid_grant, and if Tesla treats that as theft-detection
// it can revoke the whole grant family. This in-isolate single-flight closes
// the common case (multiple calls landing on the same warm isolate); it does
// not cover two different colos refreshing in the same ~60s KV-propagation
// window, which would need a Durable Object to fully serialize.
let inFlightRefresh: Promise<string> | null = null;

export async function getOwnerToken(env: Env): Promise<string> {
  const cached = await env.TESLA_KV.get<{ token: string; exp: number }>(KV_ACCESS, "json");
  if (cached && cached.exp - 120 > Date.now() / 1000) return cached.token;

  if (inFlightRefresh) return inFlightRefresh;
  const refreshPromise = refreshOwnerToken(env).finally(() => {
    if (inFlightRefresh === refreshPromise) inFlightRefresh = null;
  });
  inFlightRefresh = refreshPromise;
  return refreshPromise;
}

async function refreshOwnerToken(env: Env): Promise<string> {
  // Re-check in case a refresh from another call (or another isolate, once
  // KV propagates) already landed while we were waiting to get here.
  const cached = await env.TESLA_KV.get<{ token: string; exp: number }>(KV_ACCESS, "json");
  if (cached && cached.exp - 120 > Date.now() / 1000) return cached.token;

  const refresh = (await env.TESLA_KV.get(KV_REFRESH)) ?? env.TESLA_REFRESH_TOKEN;
  if (!refresh) {
    throw new TeslaError(
      "No Tesla refresh token available. Visit /auth/login?key=<MCP_AUTH_TOKEN> to grant access, " +
        "or set the TESLA_REFRESH_TOKEN secret.",
    );
  }

  const tok = await redeemRefreshToken(env, refresh);
  if (tok) {
    await storeOwnerTokens(env, tok);
    return tok.access_token;
  }

  // The presented token was rejected — it may already have been rotated by a
  // concurrent refresh on another colo. Re-read once and retry with whatever
  // is now stored, if it differs from what we just tried.
  const latest = await env.TESLA_KV.get(KV_REFRESH);
  if (latest && latest !== refresh) {
    const retryTok = await redeemRefreshToken(env, latest);
    if (retryTok) {
      await storeOwnerTokens(env, retryTok);
      return retryTok.access_token;
    }
  }
  throw new TeslaError(
    "Tesla token refresh failed. If the refresh token was revoked, re-run /auth/login.",
  );
}

async function redeemRefreshToken(env: Env, refresh: string): Promise<TokenResponse | null> {
  const resp = await fetch(`${authBase(env)}/oauth2/v3/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.TESLA_CLIENT_ID,
      refresh_token: refresh,
    }),
  });
  if (!resp.ok) return null;
  return (await resp.json()) as TokenResponse;
}

/**
 * Persists rotated tokens. The refresh token is written FIRST: by the time
 * this runs, Tesla has already invalidated the old one, so it exists nowhere
 * but here and in-memory — losing it (a failed put) requires manual
 * re-authorization, whereas losing the access-token write just costs one
 * extra refresh. Retries the refresh-token write since it's the one KV
 * value that must not be silently dropped.
 */
export async function storeOwnerTokens(env: Env, tok: TokenResponse): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + (tok.expires_in ?? 3600);
  if (tok.refresh_token) {
    const refreshToken = tok.refresh_token;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await env.TESLA_KV.put(KV_REFRESH, refreshToken);
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
    if (lastErr) throw lastErr;
  }
  await env.TESLA_KV.put(KV_ACCESS, JSON.stringify({ token: tok.access_token, exp }), {
    expirationTtl: Math.max(60, tok.expires_in ?? 3600),
  });
}

/** Whether an owner grant exists (KV-rotated refresh token or seed secret) — used by /health. */
export async function ownerGrantPresent(env: Env): Promise<boolean> {
  return Boolean((await env.TESLA_KV.get(KV_REFRESH)) ?? env.TESLA_REFRESH_TOKEN);
}

/** Client-credentials partner token, needed only for one-time endpoint registration. */
export async function getPartnerToken(env: Env): Promise<string> {
  const resp = await fetch(`${authBase(env)}/oauth2/v3/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.TESLA_CLIENT_ID,
      client_secret: env.TESLA_CLIENT_SECRET,
      scope: PARTNER_SCOPES,
      audience: fleetBase(env),
    }),
  });
  if (!resp.ok) {
    throw new TeslaError(`Tesla partner token request failed (${resp.status})`, resp.status, await resp.text());
  }
  return ((await resp.json()) as TokenResponse).access_token;
}

// ---------------------------------------------------------------------------
// Owner OAuth flow (one-time grant by the vehicle owner)
// ---------------------------------------------------------------------------

export async function handleAuthLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!timingSafeEqual(url.searchParams.get("key") ?? "", env.MCP_AUTH_TOKEN)) {
    return new Response("Forbidden — pass ?key=<MCP_AUTH_TOKEN>", { status: 403 });
  }
  const state = randomHex(16);
  await env.TESLA_KV.put(KV_STATE(state), "1", { expirationTtl: 600 });
  const authorize = new URL(`${authBase(env)}/oauth2/v3/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: env.TESLA_CLIENT_ID,
    redirect_uri: `${env.PUBLIC_ORIGIN}/auth/callback`,
    scope: OWNER_SCOPES,
    state,
  }).toString();
  return Response.redirect(authorize.toString(), 302);
}

export async function handleAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || !(await env.TESLA_KV.get(KV_STATE(state)))) {
    return new Response("Invalid or expired OAuth state", { status: 400 });
  }
  await env.TESLA_KV.delete(KV_STATE(state));

  const resp = await fetch(`${authBase(env)}/oauth2/v3/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.TESLA_CLIENT_ID,
      client_secret: env.TESLA_CLIENT_SECRET,
      code,
      redirect_uri: `${env.PUBLIC_ORIGIN}/auth/callback`,
    }),
  });
  if (!resp.ok) {
    return new Response(`Token exchange failed (${resp.status}): ${await resp.text()}`, { status: 502 });
  }
  await storeOwnerTokens(env, (await resp.json()) as TokenResponse);
  return new Response(
    "Tesla account linked. Tokens stored in KV — you can close this tab and use the MCP tools now.",
    { headers: { "content-type": "text/plain" } },
  );
}

// ---------------------------------------------------------------------------
// Partner setup (one-time, per region)
// ---------------------------------------------------------------------------

/** POST /setup/register-partner — registers this Worker's domain with the Fleet API. */
export async function handleRegisterPartner(env: Env): Promise<Response> {
  const domain = new URL(env.PUBLIC_ORIGIN).hostname;
  const token = await getPartnerToken(env);
  const resp = await fetch(`${fleetBase(env)}/api/1/partner_accounts`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ domain }),
  });
  const body = await resp.json().catch(() => null);
  return json(
    {
      registered_domain: domain,
      status: resp.status,
      response: body,
      note: resp.ok
        ? "Partner endpoint registered. Verify the key with GET /setup/partner-public-key."
        : "Registration failed — make sure the public key is reachable at /.well-known/appspecific/com.tesla.3p.public-key.pem on this domain first.",
    },
    resp.ok ? 200 : 502,
  );
}

/** GET /setup/partner-public-key — asks Tesla which key it has on file for our domain. */
export async function handlePartnerPublicKey(env: Env): Promise<Response> {
  const domain = new URL(env.PUBLIC_ORIGIN).hostname;
  const token = await getPartnerToken(env);
  const resp = await fetch(
    `${fleetBase(env)}/api/1/partner_accounts/public_key?domain=${encodeURIComponent(domain)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  return json({ domain, status: resp.status, response: await resp.json().catch(() => null) });
}

// ---------------------------------------------------------------------------
// MCP access control
// ---------------------------------------------------------------------------

/** True when the request carries a valid bearer (static token or shim-issued OAuth token). */
export async function isMcpAuthorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m || !m[1]) return false;
  const token = m[1].trim();
  if (timingSafeEqual(token, env.MCP_AUTH_TOKEN)) return true;
  // Shim-issued refresh tokens live under the same KV prefix as access
  // tokens but must never authorize /mcp themselves — only a token stored
  // with value "access" may.
  return (await env.TESLA_KV.get(KV_MCP_TOKEN(token))) === "access";
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function unauthorized(env: Env): Response {
  return json(
    { error: "unauthorized" },
    401,
    {
      "www-authenticate": `Bearer resource_metadata="${env.PUBLIC_ORIGIN}/.well-known/oauth-protected-resource"`,
    },
  );
}

// ---------------------------------------------------------------------------
// OAuth 2.1 shim for claude.ai remote MCP connectors
//
// claude.ai requires remote servers to speak OAuth. This shim implements the
// minimum: discovery metadata, dynamic client registration, an authorize page
// that asks for the shared MCP_AUTH_TOKEN, and a token endpoint with PKCE.
// Successful logins get an opaque bearer stored in KV.
// ---------------------------------------------------------------------------

const ALLOWED_REDIRECT_HOSTS = [/(^|\.)claude\.ai$/, /(^|\.)claude\.com$/, /^localhost$/, /^127\.0\.0\.1$/];

function redirectAllowed(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") return false;
    return ALLOWED_REDIRECT_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

export function oauthServerMetadata(env: Env): Response {
  const o = env.PUBLIC_ORIGIN;
  return json({
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/oauth/token`,
    registration_endpoint: `${o}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}

export function oauthProtectedResourceMetadata(env: Env): Response {
  return json({
    resource: `${env.PUBLIC_ORIGIN}/mcp`,
    authorization_servers: [env.PUBLIC_ORIGIN],
    bearer_methods_supported: ["header"],
  });
}

export async function handleOauthRegister(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  return json(
    {
      client_id: `mcp-${randomHex(8)}`,
      token_endpoint_auth_method: "none",
      redirect_uris: body.redirect_uris ?? [],
      client_name: body.client_name ?? "mcp-client",
    },
    201,
  );
}

const AUTHORIZE_PAGE = (action: string, error = "") => `<!doctype html>
<html><head><meta charset="utf-8"><title>tesla-cf-mcp-worker</title>
<style>body{font-family:system-ui;max-width:26rem;margin:15vh auto;padding:0 1rem}
input,button{font-size:1rem;padding:.5rem;width:100%;box-sizing:border-box;margin-top:.5rem}
.err{color:#b00}</style></head><body>
<h2>tesla-cf-mcp-worker</h2>
<p>Enter the server access token (<code>MCP_AUTH_TOKEN</code>) to connect this MCP server.</p>
${error ? `<p class="err">${error}</p>` : ""}
<form method="post" action="${action}">
<input type="password" name="key" placeholder="access token" autofocus required>
<button type="submit">Authorize</button></form></body></html>`;

export async function handleOauthAuthorize(request: Request, env: Env): Promise<Response> {
  // OAuth params live in the query string on both GET and POST (the form's
  // action URL preserves them); the POST body only carries the entered key.
  const url = new URL(request.url);
  const q = url.searchParams;
  const redirectUri = q.get("redirect_uri") ?? "";
  const state = q.get("state") ?? "";
  const codeChallenge = q.get("code_challenge") ?? "";
  const method = q.get("code_challenge_method") ?? "S256";

  if (!redirectAllowed(redirectUri)) return new Response("redirect_uri not allowed", { status: 400 });
  // OAuth 2.1 mandates PKCE for public ("none"-auth) clients; every real MCP
  // client (claude.ai included) sends S256, so requiring it costs nothing and
  // closes the code-interception window a challenge-less flow would leave.
  if (!codeChallenge) return new Response("code_challenge required (PKCE)", { status: 400 });
  if (method !== "S256") return new Response("only S256 PKCE supported", { status: 400 });

  if (request.method === "GET") {
    return new Response(AUTHORIZE_PAGE(`${url.pathname}${url.search}`), {
      headers: { "content-type": "text/html" },
    });
  }

  const key = new URLSearchParams(await request.text()).get("key") ?? "";
  if (!timingSafeEqual(key, env.MCP_AUTH_TOKEN)) {
    return new Response(AUTHORIZE_PAGE(`${url.pathname}${url.search}`, "Invalid token, try again."), {
      status: 401,
      headers: { "content-type": "text/html" },
    });
  }

  const code = randomHex(24);
  await env.TESLA_KV.put(
    KV_CODE(code),
    JSON.stringify({ redirectUri, codeChallenge }),
    { expirationTtl: 300 },
  );
  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  if (state) target.searchParams.set("state", state);
  return Response.redirect(target.toString(), 302);
}

export async function handleOauthToken(request: Request, env: Env): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const grant = form.get("grant_type");

  if (grant === "authorization_code") {
    const code = form.get("code") ?? "";
    const stored = await env.TESLA_KV.get<{ redirectUri: string; codeChallenge: string }>(KV_CODE(code), "json");
    if (!stored) return json({ error: "invalid_grant" }, 400);
    await env.TESLA_KV.delete(KV_CODE(code));

    if (stored.redirectUri !== (form.get("redirect_uri") ?? "")) {
      return json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
    }
    // codeChallenge is always present now (authorize rejects challenge-less
    // requests), but keep the guard so codes minted by older deploys fail
    // closed rather than skipping verification.
    if (!stored.codeChallenge) return json({ error: "invalid_grant", error_description: "PKCE required" }, 400);
    const verifier = form.get("code_verifier") ?? "";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const b64url = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    if (b64url !== stored.codeChallenge) return json({ error: "invalid_grant", error_description: "PKCE failed" }, 400);
    return issueTokens(env);
  }

  if (grant === "refresh_token") {
    const rt = form.get("refresh_token") ?? "";
    if ((await env.TESLA_KV.get(KV_MCP_TOKEN(rt))) !== "refresh") return json({ error: "invalid_grant" }, 400);
    await env.TESLA_KV.delete(KV_MCP_TOKEN(rt));
    return issueTokens(env);
  }

  return json({ error: "unsupported_grant_type" }, 400);
}

async function issueTokens(env: Env): Promise<Response> {
  const accessToken = randomHex(32);
  const refreshToken = randomHex(32);
  const thirtyDays = 30 * 24 * 3600;
  await env.TESLA_KV.put(KV_MCP_TOKEN(accessToken), "access", { expirationTtl: thirtyDays });
  await env.TESLA_KV.put(KV_MCP_TOKEN(refreshToken), "refresh", { expirationTtl: 6 * thirtyDays });
  return json({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: thirtyDays,
  });
}
