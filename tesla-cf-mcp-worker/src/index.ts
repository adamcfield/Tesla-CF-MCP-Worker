/**
 * tesla-cf-mcp-worker — entrypoint/router.
 *
 * Public (no auth):
 *   GET  /.well-known/appspecific/com.tesla.3p.public-key.pem  (Tesla key hosting)
 *   GET  /.well-known/oauth-authorization-server               (MCP OAuth discovery)
 *   GET  /.well-known/oauth-protected-resource
 *   *    /oauth/{register,authorize,token}                     (claude.ai OAuth shim)
 *   GET  /auth/callback                                        (Tesla owner OAuth redirect)
 *
 * Gated by MCP_AUTH_TOKEN:
 *   POST /mcp                     — MCP streamable HTTP endpoint
 *   GET  /auth/login?key=…        — start Tesla owner OAuth grant
 *   POST /setup/register-partner  — one-time partner endpoint registration
 *   GET  /setup/partner-public-key
 */

import {
  handleAuthCallback,
  handleAuthLogin,
  handleOauthAuthorize,
  handleOauthRegister,
  handleOauthToken,
  handlePartnerPublicKey,
  handleRegisterPartner,
  isMcpAuthorized,
  oauthProtectedResourceMetadata,
  oauthServerMetadata,
  unauthorized,
} from "./auth";
import { handleMcp } from "./mcp";
import { loadCommandKey } from "./protocol";
import { Env } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // --- public -------------------------------------------------------
      if (path === "/.well-known/appspecific/com.tesla.3p.public-key.pem") {
        const key = await loadCommandKey(env.TESLA_PRIVATE_KEY);
        return new Response(key.publicKeyPem, {
          headers: { "content-type": "application/x-pem-file" },
        });
      }
      if (path === "/.well-known/oauth-authorization-server") return oauthServerMetadata(env);
      if (path === "/.well-known/oauth-protected-resource") return oauthProtectedResourceMetadata(env);
      if (path === "/oauth/register" && request.method === "POST") return handleOauthRegister(request);
      if (path === "/oauth/authorize") return handleOauthAuthorize(request, env);
      if (path === "/oauth/token" && request.method === "POST") return handleOauthToken(request, env);
      if (path === "/auth/callback") return handleAuthCallback(request, env);
      if (path === "/auth/login") return handleAuthLogin(request, env);

      if (path === "/" || path === "") {
        return new Response(
          "tesla-cf-mcp-worker — Tesla Fleet API MCP server.\n" +
            "MCP endpoint: POST /mcp (Bearer auth). See README for setup.\n",
          { headers: { "content-type": "text/plain" } },
        );
      }

      // --- gated --------------------------------------------------------
      if (!(await isMcpAuthorized(request, env))) return unauthorized(env);

      if (path === "/mcp") return handleMcp(request, env);
      if (path === "/setup/register-partner" && request.method === "POST") {
        return handleRegisterPartner(env);
      }
      if (path === "/setup/partner-public-key") return handlePartnerPublicKey(env);

      return new Response("Not found", { status: 404 });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  },
} satisfies ExportedHandler<Env>;
