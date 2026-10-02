// The OpenAI image API, for the design's generated textures (gen-textures --api) and card
// illustrations (cards --api). Every request but the style sheet's attaches the style sheet as
// a reference, so the whole set shares one look.
//
// The key comes from OPENAI_API_KEY, or from a git-ignored .env.local at the repo root
// (OPENAI_API_KEY=...). OPENAI_IMAGE_MODEL overrides the model, OPENAI_IMAGE_QUALITY the
// quality ("high" by default; "low" or "medium" for cheap trial runs).
//
// Each answer is kept as it came back in assets/raw/api/<name>-<key>.png, the key a hash of
// everything sent (model, quality, size, prompt, images), and a request whose answer is already
// there isn't sent again: a run that stops half way resumes where it was, nothing is paid for
// twice, and a changed prompt or reference is asked again rather than reusing a stale answer. --force asks again; --dry lists the requests and an estimate of
// their cost without sending any. A real run totals the cost from the tokens each answer used.
//
// What every answer cost is kept in assets/raw/api/spent.json, across runs and tools, and
// --budget <usd> (or OPENAI_IMAGE_BUDGET) caps the total: a request that might take it over
// isn't sent, and the run stops there (rerun with a higher budget to go on).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const API = "https://api.openai.com/v1/images";
const ROOT = new URL("../../", import.meta.url);
export const API_DIR = new URL("assets/raw/api/", ROOT);

/**
 * The current image models (October 2026): Sunburst is the precise one, best at keeping to its
 * reference images; Flare (gpt-image-2.5-flare) is the fast one. gpt-image-1 shuts down on
 * 2026-10-23.
 */
export const IMAGE_MODEL = "gpt-image-2.5-sunburst";
/** US dollars per million tokens: text in, image in, image out (the 2.5 models' price list). */
const TOKEN_PRICE = { text: 5, imageIn: 8, imageOut: 30 };
/** For --dry: roughly what one answer costs at "high", references included (no price is published per image). */
const ESTIMATE: Record<ImageSize, number> = { "1024x1024": 0.08, "1536x1024": 0.11, "1024x1536": 0.11 };

export type ImageSize = "1024x1024" | "1536x1024" | "1024x1536";

export interface ImageRequest {
  /** Where the answer is kept: assets/raw/api/<name>-<key>.png. */
  name: string;
  prompt: string;
  size: ImageSize;
  /** Reference images (PNG, JPEG or WebP), the one to edit first. None: a plain generation. */
  refs?: Buffer[];
  /** With refs: a PNG the size of the first, transparent where the model may paint. */
  mask?: Buffer;
}

export interface ImageClient {
  /** The image for a request: from assets/raw/api/ if it was answered before, else from the API. */
  image(req: ImageRequest): Promise<Buffer | null>;
  /** Prints what was sent (or, dry, would be) and what it cost. */
  summary(): void;
}

/** The nearest size the API makes to a w × h aspect. */
export function sizeFor(w: number, h: number): ImageSize {
  const a = w / h;
  return a > 1.25 ? "1536x1024" : a < 0.8 ? "1024x1536" : "1024x1024";
}

interface Usage {
  input_tokens_details?: { text_tokens?: number; image_tokens?: number };
  output_tokens?: number;
}

/** The request's cache key: a hash of everything that goes into the answer. */
export function requestKey(req: ImageRequest, model: string, quality: string): string {
  const h = createHash("sha256");
  for (const part of [model, quality, req.size, req.prompt, ...(req.refs ?? []), req.mask ?? ""]) h.update(part).update("\0");
  return h.digest("hex").slice(0, 10);
}

interface Spent {
  name: string;
  size: ImageSize;
  usd: number;
  date: string;
}

export function imageClient(argv = process.argv): ImageClient {
  const dry = argv.includes("--dry");
  const force = argv.includes("--force");
  const b = argv.indexOf("--budget");
  const budget = Number(b >= 0 ? argv[b + 1] : (process.env.OPENAI_IMAGE_BUDGET ?? Infinity));
  if (!(budget > 0)) throw new Error("--budget takes a number of US dollars");
  const envFile = new URL(".env.local", ROOT);
  if (!process.env.OPENAI_API_KEY && existsSync(envFile)) process.loadEnvFile(envFile);
  const key = process.env.OPENAI_API_KEY;
  if (!key && !dry) throw new Error("The image API needs OPENAI_API_KEY: put OPENAI_API_KEY=... in .env.local at the repo root (it's git-ignored), or run with --dry.");
  const model = process.env.OPENAI_IMAGE_MODEL ?? IMAGE_MODEL;
  const quality = process.env.OPENAI_IMAGE_QUALITY ?? "high";
  mkdirSync(API_DIR, { recursive: true });
  const ledgerFile = new URL("spent.json", API_DIR);
  // Read afresh each time, so two tools running at once both count everything spent.
  const ledger = (): Spent[] => (existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, "utf8")) : []);
  const total = () => ledger().reduce((a, e) => a + e.usd, 0);
  /** What a request may cost: the estimate, or the dearest answer of its size so far if higher. */
  const expect = (size: ImageSize) => Math.max(ESTIMATE[size], ...ledger().filter((e) => e.size === size).map((e) => e.usd));
  let sent = 0;
  let cached = 0;
  let cost = 0;

  const call = async (req: ImageRequest): Promise<{ png: Buffer; usd: number }> => {
    const auth = { Authorization: `Bearer ${key}` };
    let init: RequestInit;
    let endpoint: string;
    if (req.refs?.length) {
      endpoint = "edits";
      const form = new FormData();
      form.set("model", model);
      form.set("prompt", req.prompt);
      form.set("size", req.size);
      form.set("quality", quality);
      req.refs.forEach((r, i) => form.append("image[]", new Blob([new Uint8Array(r)], { type: "image/png" }), `ref${i}.png`));
      if (req.mask) form.set("mask", new Blob([new Uint8Array(req.mask)], { type: "image/png" }), "mask.png");
      init = { method: "POST", headers: auth, body: form };
    } else {
      endpoint = "generations";
      init = { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ model, prompt: req.prompt, size: req.size, quality }) };
    }
    // Retry rate limits and server errors with backoff; anything else is a real error.
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${API}/${endpoint}`, { ...init, signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (res.ok) {
        const json = (await res.json()) as { data: { b64_json: string }[]; usage?: Usage };
        const u = json.usage;
        const usd = u
          ? ((u.input_tokens_details?.text_tokens ?? 0) * TOKEN_PRICE.text + (u.input_tokens_details?.image_tokens ?? 0) * TOKEN_PRICE.imageIn + (u.output_tokens ?? 0) * TOKEN_PRICE.imageOut) / 1e6
          : ESTIMATE[req.size];
        return { png: Buffer.from(json.data[0].b64_json, "base64"), usd };
      }
      const text = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const wait = 15000 * 2 ** attempt;
        console.log(`  ${req.name}: ${res.status}, retrying in ${wait / 1000} s`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw new Error(`image API ${endpoint} (${req.name}): ${res.status} ${text}`);
    }
  };

  return {
    async image(req) {
      const file = new URL(`${req.name}-${requestKey(req, model, quality)}.png`, API_DIR);
      if (existsSync(file) && !force) {
        cached++;
        return readFileSync(file);
      }
      sent++;
      if (dry) {
        cost += expect(req.size);
        console.log(`  would ask for ${req.name} (${req.size}${req.refs?.length ? `, ${req.refs.length} image${req.refs.length > 1 ? "s" : ""}` : ""}${req.mask ? ", masked" : ""})`);
        return null;
      }
      if (total() + expect(req.size) > budget)
        throw new Error(`${req.name} might take the spend over the $${budget} budget ($${total().toFixed(2)} spent, this one ~$${expect(req.size).toFixed(2)}): stopping here`);
      const t0 = performance.now();
      const { png, usd } = await call(req);
      cost += usd;
      writeFileSync(file, png);
      const spent = [...ledger(), { name: req.name, size: req.size, usd: Math.round(usd * 1e4) / 1e4, date: new Date().toISOString() }];
      writeFileSync(ledgerFile, `${JSON.stringify(spent, null, 1)}\n`);
      console.log(`  ${req.name} (${((performance.now() - t0) / 1000).toFixed(0)} s, $${usd.toFixed(3)}; $${total().toFixed(2)} spent)`);
      return png;
    },
    summary() {
      const what = dry ? `would send ${sent} request${sent === 1 ? "" : "s"} to ${model} at "${quality}", roughly $${cost.toFixed(2)}` : `sent ${sent} request${sent === 1 ? "" : "s"} to ${model} at "${quality}", $${cost.toFixed(2)}`;
      const cap = Number.isFinite(budget) ? ` of the $${budget} budget` : "";
      console.log(`${what}; ${cached} already in assets/raw/api/; $${total().toFixed(2)} spent so far${cap}`);
    },
  };
}

/**
 * The style sheet every other request attaches: generated once, then locked (delete
 * assets/raw/api/style_sheet-*.png, or change its prompt, to make a new one). Null in a dry run.
 */
export function styleSheet(api: ImageClient): Promise<Buffer | null> {
  return api.image({ name: "style_sheet", prompt: `${prompt("common")}\n\n${prompt("style-sheet")}`, size: "1536x1024" });
}

/** A prompt from tools/prompts/<name>.txt, with {placeholders} filled in. */
export function prompt(name: string, vars: Record<string, string | number> = {}): string {
  const text = readFileSync(new URL(`../prompts/${name}.txt`, import.meta.url), "utf8").trim();
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
