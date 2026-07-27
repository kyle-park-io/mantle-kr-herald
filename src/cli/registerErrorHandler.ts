// The CLI-entrypoint bootstrap. Every command imports this for its side effects;
// keep it the single place those live. First, prefer a working IP family over
// Node's Happy-Eyeballs default (see preferIpv4) so network commands survive a
// broken IPv6 route.
import "./preferIpv4";

// Then: turn any uncaught error — a synchronous config error, or an async/network
// failure surfaced by top-level await — into a clean one-line message + a non-zero
// exit, instead of a raw Node stack trace.
function report(err: unknown): never {
  const e = err as { message?: unknown; cause?: unknown } | null;
  console.error(`✖ ${e?.message ?? err}`);
  const cause = e?.cause as { message?: unknown } | undefined;
  if (cause) console.error(`  cause: ${cause.message ?? cause}`);
  process.exit(1);
}

process.on("uncaughtException", report);
process.on("unhandledRejection", report);
