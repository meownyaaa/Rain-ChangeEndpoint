import { simplifyHost } from "./config";

export interface Discovered {
    host: string;
    name?: string;
    api: string;
    cdn: string;
    gateway: string;
}

// lowercase origin (some servers say HTTPS://), no default port, no trailing slash or api version
const normalize = (url: unknown) =>
    typeof url !== "string" || !url.trim()
        ? null
        : url
            .trim()
            .replace(/^[a-z]+:\/\/[^/]+/i, origin => origin.toLowerCase().replace(/^(https|wss)(:\/\/[^/]+):443$/, "$1$2"))
            .replace(/\/+$/, "")
            .replace(/\/v\d+$/i, "");

async function getJson(url: string) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`${res.status} from ${url}`);
    return res.json();
}

const tryJson = (url: string) => getJson(url).catch(() => null);

// spacebar servers publish their endpoints, but the fields differ between versions, so every api candidate gets pinged
export async function discover(address: string): Promise<Discovered> {
    const host = simplifyHost(address);
    if (!host) throw new Error("Enter a server address");

    const known = await tryJson(`https://${host}/.well-known/spacebar`);
    const seeds = [normalize(known?.api), `https://${host}/api`, `https://api.${host}/api`].filter((s): s is string => !!s);

    let domains: Record<string, unknown> | null = null;
    for (const seed of seeds) if ((domains = await tryJson(`${seed}/policies/instance/domains`))) break;

    const endpoint = normalize(domains?.apiEndpoint);
    const candidates = [...new Set([normalize(domains?.api), endpoint, endpoint && `${endpoint}/api`, ...seeds].filter((c): c is string => !!c))];

    for (const api of candidates) {
        const ping = await tryJson(`${api}/v9/ping`);
        if (ping?.ping !== "pong!") continue;
        const name = typeof ping.instance?.name === "string" ? ping.instance.name.trim() : "";
        return {
            host,
            name: name || undefined,
            api,
            cdn: normalize(domains?.cdn) ?? `https://cdn.${host}`,
            gateway: normalize(domains?.gateway) ?? `wss://gateway.${host}`,
        };
    }
    throw new Error(`Couldn't find a Spacebar API at ${host}`);
}
