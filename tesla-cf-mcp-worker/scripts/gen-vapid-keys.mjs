#!/usr/bin/env node
/**
 * One-time VAPID keypair generator for Web Push (RFC 8292) — plain Node
 * WebCrypto, no dependencies. Run it once, set the two printed secrets, and
 * the worker starts pushing alert notifications to subscribed dashboards
 * (see src/webpush.ts). Re-running prints a FRESH pair; rotating the keys
 * invalidates every existing browser subscription, so only do that on purpose
 * (subscribers just tap Enable again on the dashboard's Alerts screen).
 *
 *   node scripts/gen-vapid-keys.mjs
 */

const { subtle } = globalThis.crypto;

const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
// Public: the 65-byte uncompressed EC point (0x04‖x‖y) — exactly the bytes
// the browser's pushManager.subscribe() wants as applicationServerKey.
const publicKey = Buffer.from(await subtle.exportKey("raw", pair.publicKey)).toString("base64url");
// Private: the raw 32-byte scalar, which JWK already carries base64url-encoded.
const privateKey = (await subtle.exportKey("jwk", pair.privateKey)).d;

console.log("Fresh VAPID keypair (base64url raw P-256 keys):\n");
console.log(`  VAPID_PUBLIC_KEY  = ${publicKey}`);
console.log(`  VAPID_PRIVATE_KEY = ${privateKey}\n`);
console.log("Set both on the worker (run from tesla-cf-mcp-worker/):\n");
console.log(`  echo -n '${publicKey}' | npx wrangler secret put VAPID_PUBLIC_KEY`);
console.log(`  echo -n '${privateKey}' | npx wrangler secret put VAPID_PRIVATE_KEY\n`);
console.log("Then redeploy (npm run deploy) and enable push on the dashboard's Alerts screen.");
