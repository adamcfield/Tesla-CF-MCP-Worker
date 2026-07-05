/**
 * fleet-telemetry -> Cloudflare Worker forwarder.
 *
 * Subscribes to the MQTT topics published by the official fleet-telemetry
 * server's MQTT dispatcher and POSTs batched, worker-shaped JSON to
 * POST /ingest/telemetry on the Tesla CF MCP Worker.
 *
 * MQTT input (verified against teslamotors/fleet-telemetry
 * datastore/mqtt/mqtt_payload.go):
 *   topic   <topic_base>/<VIN>/v/<FieldName>     e.g. telemetry/LRW3..../v/VehicleSpeed
 *   payload JSON-encoded bare value:
 *     numbers            -> 34.5
 *     booleans           -> true
 *     enums              -> "DetailedChargeStateCharging", "ShiftStateD"
 *     Location           -> {"latitude":32.08,"longitude":34.78}
 *     invalid/no reading -> null            (skipped here)
 *   Payloads carry no timestamp or VIN — VIN comes from the topic, the
 *   timestamp is stamped here on arrival (skew <= BATCH_MS, fine at 1 Hz).
 *
 * Worker output (shape 1 of tesla-cf-mcp-worker/src/ingest.ts):
 *   {"events":[{"vin":"...","ts":1730000000,"data":{"VehicleSpeed":34.5,
 *     "Location":{"latitude":..,"longitude":..}}}]}
 *   Raw fleet-telemetry field names are sent as-is; the Worker's FIELD_MAP
 *   canonicalizes them (and converts mph/miles -> metric).
 *
 * Reliability:
 *   - durable MQTT session (clean:false + QoS 1): mosquitto queues messages
 *     while the forwarder is down/restarting
 *   - bounded in-memory retry queue with exponential backoff (1s..60s) when
 *     the Worker is unreachable; oldest events are dropped past the cap
 *   - --dry-run (or DRY_RUN=true): log the exact POST bodies, send nothing
 *
 * Dependencies: node >= 18 (global fetch) + the pure-JS `mqtt` client.
 */

import { setTimeout as sleep } from "node:timers/promises";
import mqtt from "mqtt";

// ---------------------------------------------------------------- config

const env = (key, fallback) => {
  const v = process.env[key];
  return v !== undefined && v !== "" ? v : fallback;
};

const CONFIG = {
  mqttUrl: env("MQTT_URL", "mqtt://mosquitto:1883"),
  mqttClientId: env("MQTT_CLIENT_ID", "ft-forwarder"),
  topicBase: env("MQTT_TOPIC_BASE", "telemetry"),
  ingestUrl: env("INGEST_URL", "https://tesla-cf-mcp-worker.adamcfield.workers.dev/ingest/telemetry"),
  ingestToken: env("INGEST_TOKEN", ""),
  batchMs: Number(env("BATCH_MS", "1000")),
  maxQueueEvents: Number(env("MAX_QUEUE_EVENTS", "5000")),
  maxEventsPerPost: Number(env("MAX_EVENTS_PER_POST", "50")),
  postTimeoutMs: Number(env("POST_TIMEOUT_MS", "10000")),
  statsIntervalMs: Number(env("STATS_INTERVAL_MS", "60000")),
  dryRun: process.argv.includes("--dry-run") || /^(1|true|yes)$/i.test(env("DRY_RUN", "false")),
};

if (!CONFIG.dryRun && !CONFIG.ingestToken) {
  console.error("[fatal] INGEST_TOKEN is required (or run with --dry-run)");
  process.exit(1);
}

const log = (tag, msg) => console.log(`${new Date().toISOString()} [${tag}] ${msg}`);
const nowSec = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------- state

/** vin -> { ts, data } accumulated during the current batch window. */
const pending = new Map();
/** Flushed events ({vin, ts, data}) waiting to be POSTed, oldest first. */
const queue = [];
const stats = { received: 0, skippedNull: 0, posted: 0, postErrors: 0, dropped: 0, lastPostAt: 0 };
let backoffMs = 0;
let shuttingDown = false;

// ---------------------------------------------------------------- mqtt in

function onMessage(topic, buf) {
  const prefix = `${CONFIG.topicBase}/`;
  if (!topic.startsWith(prefix)) return;
  const parts = topic.slice(prefix.length).split("/");
  const vin = parts[0];
  if (!vin) return;

  if (parts[1] === "connectivity") {
    log("connectivity", `${vin} ${buf.toString()}`);
    return;
  }
  if (parts[1] === "errors" || parts[1] === "alerts") {
    // Vehicle-side alerts/errors are not part of the Worker's ingest model;
    // surface them in logs for debugging.
    log(parts[1], `${vin} ${topic} ${buf.toString().slice(0, 500)}`);
    return;
  }
  if (parts[1] !== "v" || parts.length < 3) return;

  const field = parts[2];
  let value;
  try {
    value = JSON.parse(buf.toString());
  } catch {
    value = buf.toString(); // should not happen (dispatcher always JSON-encodes)
  }
  if (value === null) {
    stats.skippedNull++; // proto {invalid:true} marker — carries no reading
    return;
  }

  stats.received++;
  let entry = pending.get(vin);
  if (!entry) {
    entry = { ts: nowSec(), data: {} };
    pending.set(vin, entry);
  }
  entry.data[field] = value; // last write in the window wins
}

// ---------------------------------------------------------------- batching

function flushPending() {
  for (const [vin, entry] of pending) {
    queue.push({ vin, ts: entry.ts, data: entry.data });
  }
  pending.clear();

  const excess = queue.length - CONFIG.maxQueueEvents;
  if (excess > 0) {
    queue.splice(0, excess);
    stats.dropped += excess;
    log("queue", `over capacity, dropped ${excess} oldest events (queue=${queue.length})`);
  }
}

// ---------------------------------------------------------------- http out

async function postEvents(events) {
  const body = JSON.stringify({ events });
  if (CONFIG.dryRun) {
    log("dry-run", `POST ${CONFIG.ingestUrl} ${body}`);
    return true;
  }
  try {
    const resp = await fetch(CONFIG.ingestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${CONFIG.ingestToken}`,
      },
      body,
      signal: AbortSignal.timeout(CONFIG.postTimeoutMs),
    });
    if (!resp.ok) {
      const text = (await resp.text().catch(() => "")).slice(0, 300);
      log("post", `HTTP ${resp.status} from worker: ${text}`);
      return false; // every failure is retried; the bounded queue caps memory
    }
    return true;
  } catch (err) {
    log("post", `request failed: ${err.message}`);
    return false;
  }
}

async function senderLoop() {
  while (!shuttingDown) {
    if (queue.length === 0) {
      await sleep(200);
      continue;
    }
    const events = queue.slice(0, CONFIG.maxEventsPerPost);
    const ok = await postEvents(events);
    if (ok) {
      queue.splice(0, events.length);
      stats.posted += events.length;
      stats.lastPostAt = Date.now();
      backoffMs = 0;
    } else {
      stats.postErrors++;
      backoffMs = Math.min(Math.max(backoffMs * 2, 1000), 60000);
      log("post", `retrying in ${backoffMs}ms (queue=${queue.length})`);
      await sleep(backoffMs);
    }
  }
}

// ---------------------------------------------------------------- lifecycle

const client = mqtt.connect(CONFIG.mqttUrl, {
  clientId: CONFIG.mqttClientId,
  clean: false, // durable session: broker queues QoS1 messages while we're away
  reconnectPeriod: 2000,
});

client.on("connect", () => {
  log("mqtt", `connected to ${CONFIG.mqttUrl}`);
  const topics = [`${CONFIG.topicBase}/+/v/+`, `${CONFIG.topicBase}/+/connectivity`];
  client.subscribe(topics, { qos: 1 }, (err) => {
    if (err) log("mqtt", `subscribe failed: ${err.message}`);
    else log("mqtt", `subscribed: ${topics.join(", ")}`);
  });
});
client.on("message", onMessage);
client.on("error", (err) => log("mqtt", `error: ${err.message}`));
client.on("offline", () => log("mqtt", "offline — reconnecting"));

setInterval(flushPending, CONFIG.batchMs);
setInterval(() => {
  const lastPost = stats.lastPostAt ? `${Math.round((Date.now() - stats.lastPostAt) / 1000)}s ago` : "never";
  log(
    "stats",
    `received=${stats.received} posted=${stats.posted} queue=${queue.length} ` +
      `postErrors=${stats.postErrors} droppedEvents=${stats.dropped} skippedNull=${stats.skippedNull} lastPost=${lastPost}`,
  );
}, CONFIG.statsIntervalMs);

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("main", `${signal} — flushing before exit`);
  flushPending();
  if (queue.length > 0) {
    // Best-effort final drain; anything left is re-queued by mosquitto's
    // durable session next time we start.
    await Promise.race([postEvents(queue.splice(0, CONFIG.maxEventsPerPost)), sleep(5000)]);
  }
  client.end(true);
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

log(
  "main",
  `forwarder up: ${CONFIG.mqttUrl} (base=${CONFIG.topicBase}) -> ${CONFIG.ingestUrl} ` +
    `batch=${CONFIG.batchMs}ms dryRun=${CONFIG.dryRun}`,
);
senderLoop();
