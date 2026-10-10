export const DISCORD = "discord";

export interface Server {
    id: string;
    name: string;
    host: string;
    api?: string;
    cdn?: string;
    gateway?: string;
}

export const PRESETS: Server[] = [
    { id: "spacebar", name: "Spacebar", host: "rory.server.spacebar.chat" },
    { id: "harmony", name: "Harmony", host: "harmony.melodychat.org" },
    {
        id: "itchat",
        name: "ITChat",
        host: "muc.it-voip.4siwi.net:8097",
        api: "https://muc.it-voip.4siwi.net:8097/api",
        cdn: "https://share.it-voip.4siwi.net:8099",
        gateway: "wss://proxy.it-voip.4siwi.net:8098",
    },
];

export interface Endpoints {
    api: string;
    gateway: string;
    cdnHost: string;
    media: string;
}

export const simplifyHost = (host: string) =>
    host
        .trim()
        .replace(/^(\w+:)?\/\//, "")
        .replace(/\/.*$/, "")
        .replace(/\?.*$/, "");

export function endpointsOf(server: Server): Endpoints | null {
    const host = simplifyHost(server.host);
    // Discord prefixes API_ENDPOINT with https:, so it must be scheme-relative
    const api = server.api?.trim().replace(/^https:(?=\/\/)/, "") || (host && `//api.${host}/api`);
    const gateway = server.gateway?.trim() || (host && `wss://gateway.${host}`);
    const cdnHost = simplifyHost(server.cdn ?? "") || (host && `cdn.${host}`);
    if (!api || !gateway || !cdnHost) return null;

    return { api, gateway, cdnHost, media: `//${cdnHost}` };
}
