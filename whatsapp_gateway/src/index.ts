import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import type { Logger } from "pino";
import type { WhatsAppClient } from "./client.js";
import { FakeWhatsAppClient } from "./fake-client.js";
import { createApiServer } from "./http.js";
import { createIngressServer } from "./ingress.js";
import { createIpFilter, type ManagedIpFilter } from "./ipfilter.js";
import { createLogger } from "./logger.js";
import { loadOptions } from "./options.js";
import { SendQueue } from "./queue.js";
import { BaileysClient } from "./whatsapp.js";

export const API_PORT = 8099;
export const INGRESS_PORT = 8098;
const SUPERVISOR_INGRESS_IP = "172.30.32.2";
const API_FILTER_REFRESH_MS = 5 * 60 * 1000;
const SHUTDOWN_BACKSTOP_MS = 5_000;

export interface GatewayEnv {
  optionsPath?: string;
  dataDir?: string;
  fake?: boolean;
  /** Listen ports; 0 picks a free port (tests). */
  apiPort?: number;
  ingressPort?: number;
  host?: string;
  logger?: Logger;
}

export interface RunningGateway {
  apiPort: number | undefined;
  ingressPort: number;
  client: WhatsAppClient;
  stop(): Promise<void>;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function createFakeClient(): FakeWhatsAppClient {
  const client = new FakeWhatsAppClient({ state: "open" });
  client.setGroups([
    { jid: "120363000000000000@g.us", name: "Family", participants: 4, isMember: true },
    { jid: "120363000000000001@g.us", name: "Garden Club", participants: 12, isMember: true },
  ]);
  return client;
}

/** Wire everything together and start listening. Resolves once the servers are up. */
export async function startGateway(env: GatewayEnv = {}): Promise<RunningGateway> {
  const optionsPath = env.optionsPath ?? "/data/options.json";
  const dataDir = env.dataDir ?? "/data";
  const host = env.host ?? "0.0.0.0";
  const result = loadOptions(optionsPath);
  const logger = env.logger ?? createLogger(result.ok ? result.options.logLevel : "info");
  const version = readVersion();

  let resetAuth: () => Promise<void>;
  let client: WhatsAppClient;
  if (env.fake) {
    const fake = createFakeClient();
    client = fake;
    resetAuth = async () => {
      fake.setState("open");
    };
    logger.warn("GATEWAY_FAKE is set: using an in-memory WhatsApp client, nothing is sent");
  } else {
    const phone = result.ok ? result.options.pairingPhoneNumber : "";
    const baileys = new BaileysClient({
      dataDir,
      pairingPhoneNumber: phone !== "" ? phone : undefined,
      logger,
    });
    client = baileys;
    resetAuth = () => baileys.resetAuth();
  }

  const filters: ManagedIpFilter[] = [];
  const servers: Server[] = [];
  let queue: SendQueue | undefined;
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await Promise.all(servers.map(closeServer));
    queue?.stop();
    for (const f of filters) f.stop();
    try {
      await client.stop();
    } catch (err) {
      logger.error({ err }, "Error while stopping the WhatsApp client");
    }
  };

  try {
    const ingressFilter = createIpFilter({ allow: [SUPERVISOR_INGRESS_IP], refreshMs: 0 });
    filters.push(ingressFilter);
    const ingress = createIngressServer({
      client,
      resetAuth,
      ipFilter: ingressFilter,
      logger,
      apiKeyConfigured: result.ok,
    });
    servers.push(ingress);
    const ingressPort = await listen(ingress, env.ingressPort ?? INGRESS_PORT, host);

    let apiPort: number | undefined;
    if (result.ok) {
      const o = result.options;
      logger.info(
        {
          version,
          pairingPhoneConfigured: o.pairingPhoneNumber !== "",
          allowedTargets: o.allowedTargets.length,
          rateLimitPerMinute: o.rateLimitPerMinute,
          trustedSources: o.trustedSources.length,
        },
        "WhatsApp Gateway starting",
      );
      const apiFilter = createIpFilter({
        allow: o.trustedSources,
        resolveHosts: ["homeassistant"],
        refreshMs: API_FILTER_REFRESH_MS,
      });
      filters.push(apiFilter);
      await apiFilter.refresh();
      queue = new SendQueue(client, { perMinute: o.rateLimitPerMinute });
      const api = createApiServer({
        client,
        queue,
        options: { apiKey: o.apiKey, allowedTargets: o.allowedTargets },
        ipFilter: apiFilter,
        logger,
        version,
      });
      servers.push(api);
      apiPort = await listen(api, env.apiPort ?? API_PORT, host);
    } else {
      logger.error(
        `Invalid configuration: ${result.error}. Set an API key in the add-on configuration (at least 16 characters). The HTTP API is disabled.`,
      );
    }

    client.start().catch((err: unknown) => {
      logger.error({ err }, "WhatsApp client failed to start");
    });
    logger.info({ ingressPort, apiPort }, "Listening");
    return { apiPort, ingressPort, client, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

async function main(): Promise<void> {
  const logger = createLogger("info");
  let gateway: RunningGateway;
  try {
    gateway = await startGateway({
      optionsPath: process.env["OPTIONS_PATH"] ?? "/data/options.json",
      dataDir: process.env["DATA_DIR"] ?? "/data",
      fake: process.env["GATEWAY_FAKE"] === "1",
    });
  } catch (err) {
    logger.error({ err }, "Failed to start");
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down`);
    setTimeout(() => process.exit(0), SHUTDOWN_BACKSTOP_MS).unref();
    gateway.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
