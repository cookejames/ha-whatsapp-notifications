import { loadOptions } from "./options.js";
import { createLogger } from "./logger.js";

const optionsPath = process.env["OPTIONS_PATH"] ?? "/data/options.json";
const result = loadOptions(optionsPath);
const logger = createLogger(result.ok ? result.options.logLevel : "info");

if (result.ok) {
  const o = result.options;
  logger.info(
    {
      pairingPhoneConfigured: o.pairingPhoneNumber !== "",
      allowedTargets: o.allowedTargets.length,
      rateLimitPerMinute: o.rateLimitPerMinute,
      trustedSources: o.trustedSources.length,
    },
    "WhatsApp Gateway starting",
  );
} else {
  // Full wiring (T14) will still serve ingress so the page can explain the problem.
  logger.error(`Invalid configuration: ${result.error}. Set an API key in the add-on configuration (at least 16 characters).`);
}

const keepAlive = setInterval(() => undefined, 1 << 30);

function shutdown(signal: string): void {
  logger.info(`Received ${signal}, shutting down`);
  clearInterval(keepAlive);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
