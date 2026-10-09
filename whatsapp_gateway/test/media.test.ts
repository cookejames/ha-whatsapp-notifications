import { describe, expect, it, vi } from "vitest";
import { loadMedia, MediaError, sanitizeFilename, sniffImageType } from "../src/media.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = Buffer.from("GIF89a....", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const opts = { maxBytes: 1024, timeoutMs: 1000 };

function res(body: Uint8Array | string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body as ConstructorParameters<typeof Response>[0], { status: init.status ?? 200, headers: init.headers });
}
function fetchOf(...rs: Response[]) {
  const fn = vi.fn();
  for (const r of rs) fn.mockResolvedValueOnce(r);
  return fn;
}
const asFetch = (fn: ReturnType<typeof vi.fn>) => fn as unknown as typeof fetch;
const code = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as MediaError).code;

describe("loadMedia base64", () => {
  it("decodes an image and sniffs the type", async () => {
    const m = await loadMedia({ base64: PNG.toString("base64") }, "image", opts);
    expect(m.mimetype).toBe("image/png");
    expect(m.data.equals(PNG)).toBe(true);
    expect(m.filename).toBeUndefined();
  });

  it("rejects oversized base64 with payload_too_large", async () => {
    const big = Buffer.alloc(2000, 1).toString("base64");
    expect(await code(loadMedia({ base64: big }, "document", { ...opts, maxBytes: 1000 }))).toBe("payload_too_large");
  });

  it("rejects base64 that decodes just past the cap", async () => {
    const big = Buffer.alloc(1001, 1).toString("base64");
    expect(await code(loadMedia({ base64: big }, "document", { ...opts, maxBytes: 1000 }))).toBe("payload_too_large");
  });

  it("accepts base64 exactly at the cap", async () => {
    const m = await loadMedia({ base64: Buffer.alloc(1000, 1).toString("base64") }, "document", { ...opts, maxBytes: 1000 });
    expect(m.data.length).toBe(1000);
  });

  it("rejects an image with unknown bytes as unsupported_media", async () => {
    expect(await code(loadMedia({ base64: Buffer.from("hello world").toString("base64") }, "image", opts))).toBe(
      "unsupported_media",
    );
  });

  it("fails when neither url nor base64 is given", async () => {
    expect(await code(loadMedia({}, "image", opts))).toBe("media_fetch_failed");
  });
});

describe("loadMedia url", () => {
  it("fetches and uses the Content-Type header", async () => {
    const f = fetchOf(res(JPEG, { headers: { "content-type": "image/jpeg; charset=binary" } }));
    const m = await loadMedia({ url: "http://homeassistant:8123/cam" }, "image", { ...opts, fetchImpl: asFetch(f) });
    expect(m.mimetype).toBe("image/jpeg");
    expect(m.data.equals(JPEG)).toBe(true);
  });

  it("sniffs when the header is not an image type", async () => {
    const f = fetchOf(res(PNG, { headers: { "content-type": "application/octet-stream" } }));
    const m = await loadMedia({ url: "https://example.com/x" }, "image", { ...opts, fetchImpl: asFetch(f) });
    expect(m.mimetype).toBe("image/png");
  });

  it("rejects non-image bytes with a non-image header", async () => {
    const f = fetchOf(res("<html>", { headers: { "content-type": "text/html" } }));
    expect(await code(loadMedia({ url: "https://example.com/x" }, "image", { ...opts, fetchImpl: asFetch(f) }))).toBe(
      "unsupported_media",
    );
  });

  it("uses the document mimetype override, then header, then default", async () => {
    const a = await loadMedia({ url: "https://example.com/a", mimetype: "application/pdf", filename: "a.pdf" }, "document", {
      ...opts,
      fetchImpl: asFetch(fetchOf(res("x", { headers: { "content-type": "text/plain" } }))),
    });
    expect(a.mimetype).toBe("application/pdf");
    const b = await loadMedia({ url: "https://example.com/b", filename: "b.txt" }, "document", {
      ...opts,
      fetchImpl: asFetch(fetchOf(res("x", { headers: { "content-type": "text/plain" } }))),
    });
    expect(b.mimetype).toBe("text/plain");
    const c = await loadMedia({ url: "https://example.com/c", filename: "c" }, "document", {
      ...opts,
      fetchImpl: asFetch(fetchOf(new Response(new Uint8Array([1])))),
    });
    expect(c.mimetype).toBe("application/octet-stream");
  });

  it("maps non-2xx to media_fetch_failed", async () => {
    const f = fetchOf(res("nope", { status: 404 }));
    expect(await code(loadMedia({ url: "https://example.com/x" }, "image", { ...opts, fetchImpl: asFetch(f) }))).toBe(
      "media_fetch_failed",
    );
  });

  it("maps network errors to media_fetch_failed", async () => {
    const f = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    expect(await code(loadMedia({ url: "https://example.com/x" }, "image", { ...opts, fetchImpl: asFetch(f) }))).toBe(
      "media_fetch_failed",
    );
  });

  it("times out via AbortController", async () => {
    vi.useFakeTimers();
    try {
      const f = vi.fn(
        (_u: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      );
      const p = loadMedia({ url: "https://example.com/slow" }, "image", { ...opts, fetchImpl: asFetch(f), timeoutMs: 5000 });
      const assertion = expect(p).rejects.toMatchObject({ code: "media_fetch_failed", message: "Media fetch timed out" });
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a stream once maxBytes is passed", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(400));
      },
      cancel() {
        cancelled = true;
      },
    });
    const f = fetchOf(new Response(body));
    expect(
      await code(loadMedia({ url: "https://example.com/big" }, "document", { ...opts, fetchImpl: asFetch(f), maxBytes: 1000 })),
    ).toBe("payload_too_large");
    expect(cancelled).toBe(true);
  });

  it("rejects early on a too-large Content-Length", async () => {
    const f = fetchOf(res("x", { headers: { "content-length": "999999" } }));
    expect(await code(loadMedia({ url: "https://example.com/x" }, "document", { ...opts, fetchImpl: asFetch(f) }))).toBe(
      "payload_too_large",
    );
  });

  it("rejects non-http schemes and invalid URLs without fetching", async () => {
    const f = vi.fn();
    for (const url of ["file:///etc/passwd", "ftp://example.com/x", "data:text/plain,hi", "not a url"]) {
      expect(await code(loadMedia({ url }, "document", { ...opts, fetchImpl: asFetch(f) }))).toBe("media_fetch_failed");
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("follows up to 3 redirects, resolving relative locations", async () => {
    const f = fetchOf(
      res("", { status: 302, headers: { location: "/a" } }),
      res("", { status: 301, headers: { location: "https://other.example/b" } }),
      res("", { status: 307, headers: { location: "c" } }),
      res(PNG),
    );
    const m = await loadMedia({ url: "https://example.com/start" }, "image", { ...opts, fetchImpl: asFetch(f) });
    expect(m.mimetype).toBe("image/png");
    expect(f.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
      "https://example.com/start",
      "https://example.com/a",
      "https://other.example/b",
      "https://other.example/c",
    ]);
  });

  it("fails after more than 3 redirects", async () => {
    const r = () => res("", { status: 302, headers: { location: "/loop" } });
    const f = fetchOf(r(), r(), r(), r());
    expect(await code(loadMedia({ url: "https://example.com/x" }, "image", { ...opts, fetchImpl: asFetch(f) }))).toBe(
      "media_fetch_failed",
    );
  });

  it("refuses a redirect to a non-http scheme", async () => {
    const f = fetchOf(res("", { status: 302, headers: { location: "file:///etc/passwd" } }));
    expect(await code(loadMedia({ url: "https://example.com/x" }, "image", { ...opts, fetchImpl: asFetch(f) }))).toBe(
      "media_fetch_failed",
    );
  });

  it("handles an empty body", async () => {
    const f = fetchOf(new Response(null, { status: 200 }));
    expect(await code(loadMedia({ url: "https://example.com/x" }, "image", { ...opts, fetchImpl: asFetch(f) }))).toBe(
      "unsupported_media",
    );
  });

  it("defaults to global fetch", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(res(JPEG));
    try {
      const m = await loadMedia({ url: "https://example.com/x" }, "image", opts);
      expect(m.mimetype).toBe("image/jpeg");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("helpers", () => {
  it("sniffs JPEG, PNG, WebP and GIF", () => {
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(WEBP)).toBe("image/webp");
    expect(sniffImageType(GIF)).toBe("image/gif");
    expect(sniffImageType(Buffer.from("RIFF....WAVE"))).toBeUndefined();
    expect(sniffImageType(Buffer.alloc(0))).toBeUndefined();
  });

  it("sanitises filenames", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("....etcpasswd");
    expect(sanitizeFilename("a\\b/c.pdf")).toBe("abc.pdf");
  });

  it("strips separators from the document filename", async () => {
    const m = await loadMedia(
      { base64: "AAAA", filename: "dir/sub\\report.pdf", mimetype: "application/pdf" },
      "document",
      opts,
    );
    expect(m.filename).toBe("dirsubreport.pdf");
    expect(m.mimetype).toBe("application/pdf");
  });
});
