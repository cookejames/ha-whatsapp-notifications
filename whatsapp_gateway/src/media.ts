export type MediaErrorCode = "payload_too_large" | "unsupported_media" | "media_fetch_failed";

export class MediaError extends Error {
  readonly code: MediaErrorCode;
  constructor(code: MediaErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MediaError";
    this.code = code;
  }
}

export interface MediaSpec {
  url?: string;
  base64?: string;
  /** Document only; path separators are stripped. */
  filename?: string;
  /** Documents only; overrides the Content-Type header. */
  mimetype?: string;
}

export interface LoadedMedia {
  data: Buffer;
  mimetype: string;
  filename?: string;
}

export interface LoadMediaOptions {
  fetchImpl?: typeof fetch;
  maxBytes: number;
  timeoutMs: number;
}

const MAX_REDIRECTS = 3;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sanitizeFilename(name: string): string {
  return name.replace(/[/\\]/g, "");
}

export function sniffImageType(b: Buffer): string | undefined {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_MAGIC)) return "image/png";
  const head6 = b.subarray(0, 6).toString("latin1");
  if (head6 === "GIF87a" || head6 === "GIF89a") return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP")
    return "image/webp";
  return undefined;
}

function normaliseType(value: string | null | undefined): string | undefined {
  const t = value?.split(";")[0]?.trim().toLowerCase();
  return t ? t : undefined;
}

export async function loadMedia(
  spec: MediaSpec,
  kind: "image" | "document",
  opts: LoadMediaOptions,
): Promise<LoadedMedia> {
  let data: Buffer;
  let headerType: string | undefined;
  if (spec.base64 !== undefined) {
    const cleaned = spec.base64.replace(/\s+/g, "");
    // Reject on the estimated size before allocating the decoded buffer.
    if (Math.floor((cleaned.length * 3) / 4) - 2 > opts.maxBytes) {
      throw new MediaError("payload_too_large", "Media exceeds the size limit");
    }
    data = Buffer.from(cleaned, "base64");
    if (data.length > opts.maxBytes) throw new MediaError("payload_too_large", "Media exceeds the size limit");
  } else if (spec.url !== undefined) {
    const fetched = await fetchUrl(spec.url, opts);
    data = fetched.data;
    headerType = fetched.type;
  } else {
    throw new MediaError("media_fetch_failed", "No media source given");
  }

  let mimetype: string;
  if (kind === "image") {
    const candidate = headerType && IMAGE_TYPES.has(headerType) ? headerType : sniffImageType(data);
    if (!candidate) throw new MediaError("unsupported_media", "Image must be JPEG, PNG, WebP or GIF");
    mimetype = candidate;
  } else {
    mimetype = normaliseType(spec.mimetype) ?? headerType ?? "application/octet-stream";
  }

  const result: LoadedMedia = { data, mimetype };
  if (kind === "document" && spec.filename !== undefined) result.filename = sanitizeFilename(spec.filename);
  return result;
}

async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

async function fetchUrl(
  rawUrl: string,
  opts: LoadMediaOptions,
): Promise<{ data: Buffer; type: string | undefined }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    let url = parseHttpUrl(rawUrl);
    for (let hops = 0; ; hops++) {
      const res = await fetchImpl(url, { redirect: "manual", signal: controller.signal });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await discard(res);
        if (hops >= MAX_REDIRECTS) throw new MediaError("media_fetch_failed", "Too many redirects");
        url = parseHttpUrl(new URL(location, url).toString());
        continue;
      }
      if (!res.ok) {
        await discard(res);
        throw new MediaError("media_fetch_failed", `Media URL returned HTTP ${res.status}`);
      }
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        await discard(res);
        throw new MediaError("payload_too_large", "Media exceeds the size limit");
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > opts.maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new MediaError("payload_too_large", "Media exceeds the size limit");
          }
          chunks.push(value);
        }
      }
      return { data: Buffer.concat(chunks), type: normaliseType(res.headers.get("content-type")) };
    }
  } catch (err) {
    if (err instanceof MediaError) throw err;
    const msg = controller.signal.aborted ? "Media fetch timed out" : "Media fetch failed";
    throw new MediaError("media_fetch_failed", msg, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (err) {
    throw new MediaError("media_fetch_failed", "Invalid media URL", { cause: err });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MediaError("media_fetch_failed", "Media URL must use http or https");
  }
  return url;
}
