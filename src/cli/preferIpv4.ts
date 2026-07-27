import net from "node:net";

/**
 * Side-effect import for CLI entrypoints: disable Node's Happy-Eyeballs family
 * autoselection process-wide.
 *
 * On hosts where the IPv6 route is broken but a AAAA record still resolves —
 * routine in WSL2, Docker, and corporate networks — Node's default
 * `autoSelectFamily` races the (dead) IPv6 address against IPv4 and can return
 * ETIMEDOUT even though a plain IPv4 connect succeeds instantly. `fetch`
 * (undici) inherits this default, so a send that works from `curl` fails from
 * the pipeline. Observed against api.telegram.org on WSL2; Google/twitterapi.io
 * happened to dodge it, which is exactly why it stayed latent.
 *
 * Turning autoselection off makes connections resolve over the address family
 * that actually works. Equivalent to the `--no-network-family-autoselection`
 * flag, but without asking every operator to set NODE_OPTIONS.
 */
export function preferIpv4(): void {
  net.setDefaultAutoSelectFamily(false);
}

preferIpv4();
