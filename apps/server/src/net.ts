// Fetching addresses people type in (Custom news) without letting them reach into the house's own network.
//
// Anyone signed in, guests included, can make the server fetch a URL and see what came back drawn on a frame.
// So the address must lead to the public internet: not the Pi itself, the router, the tailnet or anything else
// at home. The check runs on the address each connection actually uses, after DNS, so a name that resolves to a
// private address (or a redirect to one) is turned down too.
import { lookup, type LookupAddress, type LookupOptions } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import zlib from "node:zlib";

const PRIVATE = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT, and every Tailscale address
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and broadcast
] as const)
  PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64: an IPv4 address in disguise
  ["fc00::", 7], // unique local, Tailscale's included
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const)
  PRIVATE.addSubnet(net, bits, "ipv6");

/** True for an address on the public internet. */
export function isPublic(address: string) {
  // An IPv4 address written as IPv6 (::ffff:10.0.0.1) is checked as the IPv4 address it is.
  const v4 = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (v4) return !PRIVATE.check(v4, "ipv4");
  const family = isIP(address);
  return family === 4 ? !PRIVATE.check(address, "ipv4") : family === 6 ? !PRIVATE.check(address, "ipv6") : false;
}

/** dns.lookup, refusing names that resolve to anything private. Connections use it, so what's checked is what's used. */
function publicLookup(hostname: string, options: LookupOptions, cb: (...args: unknown[]) => void) {
  lookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return cb(err);
    if (!addresses.length || addresses.some((a) => !isPublic(a.address))) return cb(new Error(`${hostname} isn't on the public internet`));
    if (options.all) cb(null, addresses);
    else cb(null, addresses[0].address, addresses[0].family);
  });
}

export type Got = { ok: boolean; status: number; url: string; contentType: string | null; bytes: Uint8Array; text: () => string };

/**
 * GET `url` from the public internet, following up to `redirects` redirects (each one checked), within `timeoutMs`
 * in all, and reading at most `maxBytes` of body after decompression.
 */
export async function getPublic(
  url: string,
  { headers = {}, timeoutMs = 10_000, maxBytes = 5_000_000, redirects = 5 }: { headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number; redirects?: number } = {},
): Promise<Got> {
  const signal = AbortSignal.timeout(timeoutMs);
  let at = new URL(url);
  for (let hop = 0; ; hop++) {
    if (at.protocol !== "http:" && at.protocol !== "https:") throw new Error(`${at.protocol} addresses aren't fetched`);
    // A literal address skips DNS, so it's checked here.
    const host = at.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && !isPublic(host)) throw new Error(`${host} isn't on the public internet`);
    const res = await request(at, headers, signal);
    const location = res.headers.location;
    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
      res.resume();
      if (hop >= redirects) throw new Error(`${url}: too many redirects`);
      at = new URL(location, at);
      continue;
    }
    const bytes = await body(res, maxBytes);
    const status = res.statusCode ?? 0;
    return {
      ok: status >= 200 && status < 300,
      status,
      url: at.href,
      contentType: res.headers["content-type"] ?? null,
      bytes,
      text: () => Buffer.from(bytes).toString("utf8"),
    };
  }
}

function request(url: URL, headers: Record<string, string>, signal: AbortSignal) {
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const get = url.protocol === "https:" ? https.get : http.get;
    const req = get(url, { headers: { "Accept-Encoding": "gzip, deflate, br", ...headers }, lookup: publicLookup as never, signal }, resolve);
    req.on("error", reject);
  });
}

/** The body, decompressed, or an error once it passes `max` bytes: a small gzip can unpack to gigabytes. */
function body(res: http.IncomingMessage, max: number) {
  const encoding = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
  const stream =
    encoding === "gzip" || encoding === "x-gzip"
      ? res.pipe(zlib.createGunzip())
      : encoding === "deflate"
        ? res.pipe(zlib.createInflate())
        : encoding === "br"
          ? res.pipe(zlib.createBrotliDecompress())
          : res;
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        res.destroy();
        stream.destroy();
        reject(new Error(`body larger than ${max} bytes`));
      } else chunks.push(chunk);
    });
    stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    stream.on("error", reject);
    res.on("error", reject);
  });
}
