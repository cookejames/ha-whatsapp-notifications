import { describe, expect, it, vi } from "vitest";
import type { OutboundContent } from "../src/client.js";
import { SendError } from "../src/client.js";
import { FakeWhatsAppClient } from "../src/fake-client.js";
import { QueueError, SendQueue } from "../src/queue.js";

const JID = "15555550123@s.whatsapp.net";
const text = (t: string): OutboundContent => ({ kind: "text", text: t });

function setup(opts: { perMinute: number; maxLength?: number; deadlineMs?: number } = { perMinute: 100 }) {
  let t = 0;
  const sleeps: number[] = [];
  const client = new FakeWhatsAppClient({ state: "open" });
  const times: number[] = [];
  const realSend = client.send.bind(client);
  vi.spyOn(client, "send").mockImplementation(async (jid, content) => {
    times.push(t);
    return realSend(jid, content);
  });
  const queue = new SendQueue(client, {
    ...opts,
    now: () => t,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  });
  return { client, queue, times, sleeps };
}

describe("SendQueue", () => {
  it("sends in FIFO order and applies jitter between sends", async () => {
    const { client, queue, sleeps } = setup();
    const results = await Promise.all(["a", "b", "c"].map((s) => queue.enqueue(JID, text(s))));
    expect(client.sent.map((m) => (m.content as { text: string }).text)).toEqual(["a", "b", "c"]);
    expect(results.map((r) => r.id)).toEqual(client.sent.map((m) => m.id));
    expect(sleeps).toEqual([750, 750]); // 300 + 0.5 * 900, only between sends
    expect(queue.size()).toBe(0);
  });

  it("never exceeds perMinute in any rolling 60s window", async () => {
    const { queue, times } = setup({ perMinute: 3, deadlineMs: 600_000 });
    await Promise.all(Array.from({ length: 10 }, (_, i) => queue.enqueue(JID, text(String(i)))));
    expect(times).toHaveLength(10);
    for (const ti of times) {
      const inWindow = times.filter((x) => x <= ti && x > ti - 60_000);
      expect(inWindow.length).toBeLessThanOrEqual(3);
    }
    expect(times[3]).toBeGreaterThanOrEqual(60_000);
  });

  it("is serial, never concurrent", async () => {
    const client = new FakeWhatsAppClient({ state: "open" });
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(client, "send").mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight--;
      return { id: "x" };
    });
    const queue = new SendQueue(client, { perMinute: 100, sleep: async () => undefined });
    await Promise.all([1, 2, 3].map(() => queue.enqueue(JID, text("x"))));
    expect(maxInFlight).toBe(1);
  });

  it("rejects with queue_full beyond maxLength", async () => {
    // The first job leaves the pending list as soon as it starts sending.
    const { queue } = setup({ perMinute: 100, maxLength: 1 });
    const a = queue.enqueue(JID, text("a"));
    const b = queue.enqueue(JID, text("b"));
    await expect(queue.enqueue(JID, text("c"))).rejects.toMatchObject({ code: "queue_full" });
    await Promise.all([a, b]);
  });

  it("rejects with timeout when a job is not started by its deadline", async () => {
    const { queue, client } = setup({ perMinute: 1, deadlineMs: 10_000 });
    const a = queue.enqueue(JID, text("a"));
    const b = queue.enqueue(JID, text("b"));
    await expect(a).resolves.toBeDefined();
    const err = await b.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueueError);
    expect(err).toMatchObject({ code: "timeout" });
    expect(client.sent).toHaveLength(1);
  });

  it("maps client errors to send_failed with the client's message", async () => {
    const { queue, client } = setup();
    client.failNextSend(new SendError("boom from client"));
    const failing = queue.enqueue(JID, text("a"));
    const ok = queue.enqueue(JID, text("b"));
    await expect(failing).rejects.toMatchObject({ code: "send_failed", message: "boom from client" });
    await expect(ok).resolves.toBeDefined();
  });

  it("handles non-Error client rejections", async () => {
    const client = new FakeWhatsAppClient({ state: "open" });
    vi.spyOn(client, "send").mockRejectedValue("plain string");
    const queue = new SendQueue(client, { perMinute: 10, sleep: async () => undefined });
    await expect(queue.enqueue(JID, text("a"))).rejects.toMatchObject({
      code: "send_failed",
      message: "plain string",
    });
  });

  it("stop() rejects pending jobs and refuses new ones", async () => {
    const client = new FakeWhatsAppClient({ state: "open" });
    let release!: () => void;
    vi.spyOn(client, "send").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ id: "first" });
        }),
    );
    const queue = new SendQueue(client, { perMinute: 10, sleep: async () => undefined });
    const first = queue.enqueue(JID, text("a"));
    const second = queue.enqueue(JID, text("b"));
    const third = queue.enqueue(JID, text("c"));
    await Promise.resolve();
    expect(queue.size()).toBe(2);
    queue.stop();
    await expect(second).rejects.toMatchObject({ code: "send_failed" });
    await expect(third).rejects.toMatchObject({ code: "send_failed" });
    expect(queue.size()).toBe(0);
    await expect(queue.enqueue(JID, text("d"))).rejects.toBeInstanceOf(QueueError);
    release();
    await expect(first).resolves.toEqual({ id: "first" });
  });

  it("restarts the worker for jobs enqueued after the queue drained", async () => {
    const { queue, client } = setup();
    await queue.enqueue(JID, text("a"));
    await queue.enqueue(JID, text("b"));
    expect(client.sent).toHaveLength(2);
  });

  it("works with default timing options under fake timers", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeWhatsAppClient({ state: "open" });
      const queue = new SendQueue(client, { perMinute: 10 });
      const p = Promise.all([queue.enqueue(JID, text("a")), queue.enqueue(JID, text("b"))]);
      await vi.advanceTimersByTimeAsync(2000);
      await expect(p).resolves.toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
