/**
 * MCP server: JSON-RPC over streamable HTTP (POST /mcp), hand-rolled so the
 * Worker has no runtime dependencies. Works with Claude Code
 * (`claude mcp add --transport http tesla <origin>/mcp --header
 * "Authorization: Bearer <MCP_AUTH_TOKEN>"`) and claude.ai remote connectors
 * (via the OAuth shim in auth.ts).
 */

import * as api from "./api";
import * as cmd from "./commands";
import * as telemetry from "./telemetry";
import { Env, TeslaError } from "./types";

const SERVER_INFO = { name: "tesla-cf-mcp-worker", title: "Tesla CF MCP Worker", version: "0.1.0" };
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

type ToolHandler = (env: Env, args: Record<string, any>) => Promise<unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

const vinProp = {
  vin: { type: "string", description: "Vehicle VIN (from list_vehicles)" },
} as const;

const vinSchema = {
  type: "object",
  properties: vinProp,
  required: ["vin"],
} as const;

/** Parses "Mon,Tue" / "All" into the ChargeSchedule days_of_week bitmask (bit 0 = Sunday). */
function parseDays(days: string): number {
  const bits: Record<string, number> = {
    sun: 1, mon: 2, tue: 4, wed: 8, thu: 16, fri: 32, sat: 64,
  };
  if (days.trim().toLowerCase() === "all") return 127;
  let mask = 0;
  for (const part of days.split(",")) {
    const bit = bits[part.trim().toLowerCase().slice(0, 3)];
    if (!bit) throw new TeslaError(`Unrecognized day "${part.trim()}" — use e.g. "Mon,Tue" or "All"`);
    mask |= bit;
  }
  return mask;
}

const commandResult = (r: { result: boolean; reason: string }) =>
  r.result ? { result: "ok" } : { result: "failed", reason: r.reason || "vehicle rejected the command" };

const TELEMETRY_NUDGE =
  "Cost note: this is a billed on-demand read (~$0.12/hr-equivalent when called repeatedly). " +
  "For recurring reads prefer Fleet Telemetry streaming (~18x cheaper) — see configure_telemetry.";

const TOOLS: Tool[] = [
  // ------------------------------------------------------------------ reads
  {
    name: "list_vehicles",
    description: "List vehicles on the Tesla account (VIN, name, connectivity state). Free, does not wake vehicles.",
    inputSchema: { type: "object", properties: {} },
    handler: (env) => api.listVehicles(env),
  },
  {
    name: "get_vehicle_data",
    description:
      "Full vehicle_data snapshot: state, charge, climate, location, odometer, tire pressure. " +
      "Fails (without waking) if the vehicle is asleep — call wake_vehicle explicitly only if the user needs live data. " +
      TELEMETRY_NUDGE,
    inputSchema: vinSchema,
    handler: (env, a) =>
      api.getVehicleData(env, a.vin, [
        "charge_state",
        "climate_state",
        "drive_state",
        "location_data",
        "vehicle_state",
        "vehicle_config",
      ]),
  },
  {
    name: "get_charge_state",
    description:
      "Charge state only (battery %, range, charging status, charge limit). Cheaper payload than get_vehicle_data. " +
      "Does not wake a sleeping vehicle. " + TELEMETRY_NUDGE,
    inputSchema: vinSchema,
    handler: (env, a) => api.getVehicleData(env, a.vin, ["charge_state"]),
  },
  {
    name: "get_climate_state",
    description:
      "Climate state only (cabin temp, HVAC status, preconditioning). Does not wake a sleeping vehicle. " +
      TELEMETRY_NUDGE,
    inputSchema: vinSchema,
    handler: (env, a) => api.getVehicleData(env, a.vin, ["climate_state"]),
  },
  {
    name: "get_location",
    description:
      "Vehicle location and heading (drive_state + location_data). Requires the vehicle_location scope. " +
      "Does not wake a sleeping vehicle. " + TELEMETRY_NUDGE,
    inputSchema: vinSchema,
    handler: (env, a) => api.getVehicleData(env, a.vin, ["drive_state", "location_data"]),
  },
  {
    name: "nearby_charging_sites",
    description: "Superchargers and destination chargers near the vehicle's current location.",
    inputSchema: {
      type: "object",
      properties: {
        ...vinProp,
        count: { type: "number", description: "Max sites to return" },
        radius: { type: "number", description: "Search radius in miles" },
        detail: { type: "boolean", description: "Include site metadata" },
      },
      required: ["vin"],
    },
    handler: (env, a) =>
      api.nearbyChargingSites(env, a.vin, { count: a.count, radius: a.radius, detail: a.detail }),
  },
  {
    name: "wake_vehicle",
    description:
      "Wake a sleeping vehicle. ONLY call when the user explicitly needs live data or a command on a sleeping car — " +
      "waking uses battery and this server intentionally never auto-wakes. Takes ~10-30s to come online.",
    inputSchema: vinSchema,
    handler: (env, a) => api.wakeVehicle(env, a.vin),
  },

  // --------------------------------------------------------------- commands
  {
    name: "lock",
    description: "Lock the vehicle doors (signed command).",
    inputSchema: vinSchema,
    handler: async (env, a) => commandResult(await cmd.lockDoors(env, a.vin)),
  },
  {
    name: "unlock",
    description: "Unlock the vehicle doors (signed command).",
    inputSchema: vinSchema,
    handler: async (env, a) => commandResult(await cmd.unlockDoors(env, a.vin)),
  },
  {
    name: "set_charge_limit",
    description: "Set the charge limit percentage (50-100).",
    inputSchema: {
      type: "object",
      properties: {
        ...vinProp,
        percent: { type: "number", minimum: 50, maximum: 100 },
      },
      required: ["vin", "percent"],
    },
    handler: async (env, a) => commandResult(await cmd.setChargeLimit(env, a.vin, Math.round(a.percent))),
  },
  {
    name: "start_charging",
    description: "Start charging (vehicle must be plugged in).",
    inputSchema: vinSchema,
    handler: async (env, a) => commandResult(await cmd.startCharging(env, a.vin)),
  },
  {
    name: "stop_charging",
    description: "Stop charging.",
    inputSchema: vinSchema,
    handler: async (env, a) => commandResult(await cmd.stopCharging(env, a.vin)),
  },
  {
    name: "climate_on",
    description: "Turn on climate control / start preconditioning the cabin.",
    inputSchema: vinSchema,
    handler: async (env, a) => commandResult(await cmd.climateOn(env, a.vin)),
  },
  {
    name: "climate_off",
    description: "Turn off climate control.",
    inputSchema: vinSchema,
    handler: async (env, a) => commandResult(await cmd.climateOff(env, a.vin)),
  },
  {
    name: "set_temperature",
    description: "Set cabin target temperature in °C (driver side; passenger defaults to the same).",
    inputSchema: {
      type: "object",
      properties: {
        ...vinProp,
        temp_celsius: { type: "number", minimum: 15, maximum: 28 },
        passenger_temp_celsius: { type: "number", minimum: 15, maximum: 28 },
      },
      required: ["vin", "temp_celsius"],
    },
    handler: async (env, a) =>
      commandResult(await cmd.setTemperature(env, a.vin, a.temp_celsius, a.passenger_temp_celsius)),
  },
  {
    name: "flash_lights",
    description: "Flash the headlights (vehicle must be in park).",
    inputSchema: vinSchema,
    handler: async (env, a) => commandResult(await cmd.flashLights(env, a.vin)),
  },
  {
    name: "honk_horn",
    description: "Honk the horn (vehicle must be in park).",
    inputSchema: vinSchema,
    handler: async (env, a) => commandResult(await cmd.honkHorn(env, a.vin)),
  },
  {
    name: "open_charge_port",
    description: "Open the charge port door (also unlatches a plugged-in cable when not charging).",
    inputSchema: vinSchema,
    handler: async (env, a) => commandResult(await cmd.openChargePort(env, a.vin)),
  },
  {
    name: "close_charge_port",
    description: "Close the charge port door.",
    inputSchema: vinSchema,
    handler: async (env, a) => commandResult(await cmd.closeChargePort(env, a.vin)),
  },
  {
    name: "actuate_frunk",
    description: "Open the front trunk (frunk). Cannot be closed remotely.",
    inputSchema: vinSchema,
    handler: async (env, a) => commandResult(await cmd.actuateFrunk(env, a.vin)),
  },
  {
    name: "actuate_trunk",
    description: "Open/close the rear trunk (toggles on powered-liftgate vehicles).",
    inputSchema: vinSchema,
    handler: async (env, a) => commandResult(await cmd.actuateTrunk(env, a.vin)),
  },
  {
    name: "set_charging_schedule",
    description:
      "Add or update a charging schedule at a location. Times are minutes after midnight, vehicle-local. " +
      "Provide start_time and/or end_time. Pass id to update an existing schedule.",
    inputSchema: {
      type: "object",
      properties: {
        ...vinProp,
        days: { type: "string", description: '"All" or comma list, e.g. "Mon,Tue,Fri"' },
        enabled: { type: "boolean", default: true },
        start_time: { type: "number", description: "Charging window start, minutes after midnight" },
        end_time: { type: "number", description: "Charging window end, minutes after midnight" },
        latitude: { type: "number", description: "Schedule location latitude" },
        longitude: { type: "number", description: "Schedule location longitude" },
        one_time: { type: "boolean" },
        id: { type: "number", description: "Existing schedule id to update" },
        name: { type: "string" },
      },
      required: ["vin", "days", "latitude", "longitude"],
    },
    handler: async (env, a) => {
      if (a.start_time === undefined && a.end_time === undefined) {
        throw new TeslaError("Provide start_time and/or end_time (minutes after midnight)");
      }
      return commandResult(
        await cmd.addChargeSchedule(env, a.vin, {
          daysOfWeek: parseDays(a.days),
          enabled: a.enabled ?? true,
          startTime: a.start_time,
          endTime: a.end_time,
          latitude: a.latitude,
          longitude: a.longitude,
          oneTime: a.one_time,
          id: a.id,
          name: a.name,
        }),
      );
    },
  },
  {
    name: "remove_charging_schedule",
    description: "Remove a charging schedule by id.",
    inputSchema: {
      type: "object",
      properties: { ...vinProp, id: { type: "number" } },
      required: ["vin", "id"],
    },
    handler: async (env, a) => commandResult(await cmd.removeChargeSchedule(env, a.vin, a.id)),
  },
  {
    name: "set_precondition_schedule",
    description:
      "Add or update a cabin/battery preconditioning schedule (ready-by time is minutes after midnight, vehicle-local).",
    inputSchema: {
      type: "object",
      properties: {
        ...vinProp,
        days: { type: "string", description: '"All" or comma list, e.g. "Mon,Tue,Fri"' },
        enabled: { type: "boolean", default: true },
        precondition_time: { type: "number", description: "Ready-by time, minutes after midnight" },
        latitude: { type: "number" },
        longitude: { type: "number" },
        one_time: { type: "boolean" },
        id: { type: "number", description: "Existing schedule id to update" },
        name: { type: "string" },
      },
      required: ["vin", "days", "precondition_time", "latitude", "longitude"],
    },
    handler: async (env, a) =>
      commandResult(
        await cmd.addPreconditionSchedule(env, a.vin, {
          daysOfWeek: parseDays(a.days),
          enabled: a.enabled ?? true,
          preconditionTime: a.precondition_time,
          latitude: a.latitude,
          longitude: a.longitude,
          oneTime: a.one_time,
          id: a.id,
          name: a.name,
        }),
      ),
  },
  {
    name: "remove_precondition_schedule",
    description: "Remove a preconditioning schedule by id.",
    inputSchema: {
      type: "object",
      properties: { ...vinProp, id: { type: "number" } },
      required: ["vin", "id"],
    },
    handler: async (env, a) => commandResult(await cmd.removePreconditionSchedule(env, a.vin, a.id)),
  },

  // -------------------------------------------------------------- telemetry
  {
    name: "get_telemetry_config",
    description: "Show the Fleet Telemetry streaming config currently applied to a vehicle (if any).",
    inputSchema: vinSchema,
    handler: (env, a) => telemetry.getTelemetryConfig(env, a.vin),
  },
  {
    name: "configure_telemetry",
    description:
      "Register Fleet Telemetry streaming for one or more VINs — the preferred (18x cheaper) alternative to " +
      "repeated get_vehicle_data calls. Requires a reachable telemetry target server (hostname/ca) and the " +
      "virtual key paired to each vehicle. fields maps field names (e.g. Soc, Location, VehicleSpeed) to " +
      '{"interval_seconds": n}. Receiving/storing the stream is a v2 TODO — this only manages the vehicle-side config.',
    inputSchema: {
      type: "object",
      properties: {
        vins: { type: "array", items: { type: "string" } },
        hostname: { type: "string", description: "Telemetry target host (Tesla pushes over mTLS)" },
        port: { type: "number", default: 443 },
        ca: { type: "string", description: "PEM CA chain of the target server" },
        fields: {
          type: "object",
          description: 'e.g. {"Soc":{"interval_seconds":60},"Location":{"interval_seconds":120}}',
        },
        alert_types: { type: "array", items: { type: "string" } },
      },
      required: ["vins", "hostname", "fields"],
    },
    handler: (env, a) =>
      telemetry.createTelemetryConfig(env, {
        vins: a.vins,
        config: {
          hostname: a.hostname,
          port: a.port,
          ca: a.ca,
          fields: a.fields,
          alert_types: a.alert_types,
        },
      }),
  },
  {
    name: "delete_telemetry_config",
    description: "Remove the Fleet Telemetry streaming config from a vehicle.",
    inputSchema: vinSchema,
    handler: (env, a) => telemetry.deleteTelemetryConfig(env, a.vin),
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: any;
}

type JsonRpcResponse = { jsonrpc: "2.0"; id: number | string | null } & (
  | { result: unknown }
  | { error: { code: number; message: string } }
);

async function dispatch(env: Env, msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null;
  const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  // Notifications get no response.
  if (msg.method.startsWith("notifications/")) return null;

  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion as string | undefined;
      return reply({
        protocolVersion: requested && SUPPORTED_PROTOCOLS.includes(requested) ? requested : "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `Unknown tool: ${msg.params?.name}`);
      try {
        const result = await tool.handler(env, msg.params?.arguments ?? {});
        return reply({
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (e) {
        const message =
          e instanceof TeslaError
            ? e.message + (e.detail ? `\n\ndetail: ${typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)}` : "")
            : e instanceof Error
              ? e.message
              : String(e);
        return reply({ content: [{ type: "text", text: `Error: ${message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    // No server-initiated stream support; streamable-HTTP clients fall back to POST.
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const messages = (Array.isArray(body) ? body : [body]) as JsonRpcRequest[];
  const responses = (await Promise.all(messages.map((m) => dispatch(env, m)))).filter(
    (r): r is JsonRpcResponse => r !== null,
  );

  if (responses.length === 0) return new Response(null, { status: 202 });
  const payload = Array.isArray(body) ? responses : responses[0];
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
}
