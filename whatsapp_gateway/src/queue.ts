import type { OutboundContent, WhatsAppClient } from "./client.js";

export type QueueErrorCode = "queue_full" | "timeout" | "send_failed";

/** Rejection reason from SendQueue; `code` is the per-target API error code. */
export class QueueError extends Error {
  readonly code: QueueErrorCode;
  constructor(code: QueueErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "QueueError";
    this.code = code;
  }
}

export interface SendQueueOptions {
  perMinute: number;
  maxLength?: number;
  deadlineMs?: number;
  /** [min, max] delay in ms after each send. */
  jitterMs?: [number, number];
  /** Current time in milliseconds. */
  now?: () => number;
  /** Returns a number in [0, 1). */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Job {
  jid: string;
  content: OutboundContent;
  enqueuedAt: number;
  resolve: (r: { id: string }) => void;
  reject: (e: Error) => void;
}

const WINDOW_MS = 60_000;

export class SendQueue {
  private readonly pending: Job[] = [];
  private readonly sentAt: number[] = [];
  private readonly perMinute: number;
  private readonly maxLength: number;
  private readonly deadlineMs: number;
  private readonly jitter: [number, number];
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private running = false;
  private stopped = false;

  constructor(
    private readonly client: WhatsAppClient,
    opts: SendQueueOptions,
  ) {
    this.perMinute = Math.max(1, Math.floor(opts.perMinute));
    this.maxLength = opts.maxLength ?? 100;
    this.deadlineMs = opts.deadlineMs ?? 120_000;
    this.jitter = opts.jitterMs ?? [300, 1200];
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  enqueue(jid: string, content: OutboundContent): Promise<{ id: string }> {
    if (this.stopped) {
      return Promise.reject(new QueueError("send_failed", "Send queue is stopped"));
    }
    if (this.pending.length >= this.maxLength) {
      return Promise.reject(new QueueError("queue_full", "Send queue is full"));
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ jid, content, enqueuedAt: this.now(), resolve, reject });
      if (!this.running) void this.run();
    });
  }

  /** Number of jobs waiting (not including one currently being sent). */
  size(): number {
    return this.pending.length;
  }

  /** Reject all pending jobs and refuse new ones. */
  stop(): void {
    this.stopped = true;
    for (const job of this.pending.splice(0)) {
      job.reject(new QueueError("send_failed", "Send queue stopped"));
    }
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      while (!this.stopped) {
        const job = this.pending[0];
        if (!job) break;
        if (this.now() - job.enqueuedAt >= this.deadlineMs) {
          this.pending.shift();
          job.reject(new QueueError("timeout", "Message was not sent before its deadline"));
          continue;
        }
        const wait = this.rateWait();
        if (wait > 0) {
          const untilDeadline = job.enqueuedAt + this.deadlineMs - this.now();
          await this.sleep(Math.max(0, Math.min(wait, untilDeadline)));
          continue; // re-evaluate: deadline, stop, window
        }
        this.pending.shift();
        this.sentAt.push(this.now());
        try {
          const result = await this.client.send(job.jid, job.content);
          job.resolve(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          job.reject(new QueueError("send_failed", message, { cause: err }));
        }
        if (this.pending.length > 0 && !this.stopped) {
          const [min, max] = this.jitter;
          await this.sleep(Math.round(min + this.random() * (max - min)));
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Milliseconds until another send is allowed by the rolling window (0 = now). */
  private rateWait(): number {
    const cutoff = this.now() - WINDOW_MS;
    while (this.sentAt.length > 0 && (this.sentAt[0] as number) <= cutoff) this.sentAt.shift();
    if (this.sentAt.length < this.perMinute) return 0;
    return (this.sentAt[this.sentAt.length - this.perMinute] as number) + WINDOW_MS - this.now();
  }
}
