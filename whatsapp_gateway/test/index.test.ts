import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import { startGateway, type RunningGateway } from "../src/index.js";

const KEY = "test-api-key-0123456789abcdef";
let dir: string;
let gw: RunningGateway | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gw-"));
});
afterEach(async () => {
  await gw?.stop();
  gw = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function boot(optionsPath: string) {
  return startGateway({
    optionsPath,
    dataDir: dir,
    fake: true,
    apiPort: 0,
    ingressPort: 0,
    host: "127.0.0.1",
    logger: pino({ level: "silent" }),
  });
}

function bootWith(options: unknown) {
  const optionsPath = join(dir, "options.json");
  writeFileSync(optionsPath, JSON.stringify(options));
  return boot(optionsPath);
}

describe("startGateway", () => {
  it("serves the API and ingress with the fake client", async () => {
    gw = await bootWith({ api_key: KEY });
    expect(gw.apiPort).toBeTypeOf("number");
    const base = `http://127.0.0.1:${gw.apiPort}`;
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/status`)).status).toBe(401);
    const auth = { authorization: `Bearer ${KEY}` };
    expect((await fetch(`${base}/status`, { headers: auth })).status).toBe(200);
    const groups = await (await fetch(`${base}/groups`, { headers: auth })).text();
    expect(groups).toContain("Family");
    const sent = await fetch(`${base}/send`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ to: ["+15555550123", "group:Family"], message: "hi" }),
    });
    expect(sent.status).toBe(200);
    const results = ((await sent.json()) as { results: { id?: string }[] }).results;
    expect(results.map((r) => r.id)).toEqual([expect.any(String), expect.any(String)]);
    expect((await fetch(`http://127.0.0.1:${gw.ingressPort}/`)).status).toBe(200);
  });

  it("starts only ingress when the API key is invalid", async () => {
    gw = await bootWith({ api_key: "short" });
    expect(gw.apiPort).toBeUndefined();
    const res = await fetch(`http://127.0.0.1:${gw.ingressPort}/`);
    expect(res.status).toBe(200);
    expect((await res.text()).toLowerCase()).toContain("api key");
  });

  it("starts only ingress when the options file is missing", async () => {
    gw = await boot(join(dir, "missing.json"));
    expect(gw.apiPort).toBeUndefined();
  });

  it("stop() closes the listeners and is idempotent", async () => {
    gw = await bootWith({ api_key: KEY });
    const port = gw.apiPort;
    await gw.stop();
    await gw.stop();
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    gw = undefined;
  });
});
