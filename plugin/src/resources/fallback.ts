import { parseUrl } from "../util/parse";

/**
 * Image hosts keep the same object on several mirrors. When one mirror is down
 * the same path is tried on the others before giving up on the image.
 */
export const RELAY_HOSTS: readonly string[] = [
  "relay-1.bijitongbu.site",
  "relay-2.bijitongbu.site",
  "relay-4.bijitongbu.site",
];

interface RelayFlavor {
  prefix: string;
  origin: string;
}

const FLAVORS: readonly RelayFlavor[] = [
  { prefix: "p", origin: "pic.clipfx.app" },
  { prefix: "m", origin: "media.clipfx.app" },
  { prefix: "m30", origin: "media30d.clipfx.app" },
];

/** Alternative URLs for the same image, original excluded. Empty for unknown hosts. */
export function getFallbackUrls(url: string, relayHosts: readonly string[] = RELAY_HOSTS): string[] {
  const parsed = parseUrl(url);
  if (!parsed) return [];
  const suffix = parsed.search + parsed.hash;
  const port = parsed.port ? `:${parsed.port}` : "";
  if (RELAY_HOSTS.includes(parsed.hostname)) {
    const match = parsed.pathname.match(/^\/([^/]+)\/(.+)$/);
    if (!match) return [];
    const flavor = FLAVORS.find((candidate) => candidate.prefix === match[1]);
    if (!flavor) return [];
    return [
      ...relayHosts
        .filter((host) => host !== parsed.hostname)
        .map((host) => `${parsed.protocol}//${host}${port}/${match[1]}/${match[2]}${suffix}`),
      `${parsed.protocol}//${flavor.origin}${port}/${match[2]}${suffix}`,
    ];
  }
  const flavor = FLAVORS.find((candidate) => candidate.origin === parsed.hostname);
  const key = parsed.pathname.replace(/^\//, "");
  if (!flavor || !key) return [];
  return relayHosts.map((host) => `${parsed.protocol}//${host}${port}/${flavor.prefix}/${key}${suffix}`);
}
