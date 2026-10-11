import { fileExists, readFile, writeFile } from "@api/native/fs";

import { DISCORD, type Endpoints, endpointsOf, PRESETS, type Server, simplifyHost } from "./config";

const CONFIG_PATH = "plugins/changeendpoint.json";

interface Config {
    instance: string | null;
    accounts: Record<string, string>;
    customs: Server[];
    disrespectPermissions: boolean;
    boostCount: number;
}

export const state: { config: Config; endpoints: Endpoints | null } = {
    config: { instance: null, accounts: {}, customs: [], disrespectPermissions: true, boostCount: 67 },
    endpoints: null,
};

export const currentInstance = () => state.config.instance ?? DISCORD;

export const servers = () => [...PRESETS, ...state.config.customs];

export const findServer = (id: string | null | undefined) => servers().find(s => s.id === id);

export const resolveEndpoints = (id: string | null | undefined) => {
    const server = findServer(id);
    return server ? endpointsOf(server) : null;
};

export const serverName = (id: string | null | undefined) =>
    id == null || id === DISCORD ? "Discord" : (findServer(id)?.name ?? id);

export const save = () => writeFile(CONFIG_PATH, JSON.stringify(state.config)).catch(e => console.warn("[ChangeEndpoint] couldn't save config", e));

export async function loadConfig() {
    try {
        if (await fileExists(CONFIG_PATH)) {
            const saved = JSON.parse(await readFile(CONFIG_PATH));
            state.config = {
                instance: saved.instance ?? null,
                accounts: { ...saved.accounts },
                customs: Array.isArray(saved.customs) ? saved.customs : [],
                disrespectPermissions: saved.disrespectPermissions ?? true,
                boostCount: typeof saved.boostCount === "number" ? saved.boostCount : 67,
            };
        }
    } catch (e) {
        console.warn("[ChangeEndpoint] couldn't read config", e);
    }
    state.endpoints = resolveEndpoints(state.config.instance);
}

const listeners = new Set<() => void>();
export const onInstanceChange = (fn: () => void) => {
    listeners.add(fn);
    return () => void listeners.delete(fn);
};

export function setInstance(instance: string) {
    const id = instance === DISCORD ? null : instance;
    const endpoints = id ? resolveEndpoints(id) : null;
    if (id && !endpoints) return false;

    state.config = { ...state.config, instance: id };
    state.endpoints = endpoints;
    save();
    listeners.forEach(fn => fn());
    return true;
}

export function linkAccount(userId: string, instance = currentInstance()) {
    if (state.config.accounts[userId] === instance) return;
    state.config = { ...state.config, accounts: { ...state.config.accounts, [userId]: instance } };
    save();
}

export function setDisrespectPermissions(value: boolean) {
    state.config = { ...state.config, disrespectPermissions: value };
    return save();
}

export function setBoostCount(value: number) {
    state.config = { ...state.config, boostCount: value };
    return save();
}

export function saveCustom(server: Server) {
    const customs = state.config.customs.some(s => s.id === server.id)
        ? state.config.customs.map(s => (s.id === server.id ? server : s))
        : [...state.config.customs, server];
    state.config = { ...state.config, customs };
    if (server.id === state.config.instance) state.endpoints = resolveEndpoints(server.id);
    return save();
}

export function removeCustom(id: string) {
    state.config = { ...state.config, customs: state.config.customs.filter(s => s.id !== id) };
    return save();
}

const DISCORD_HOST = /(^|\.)(discord\.(com|gg|media)|discordapp\.(com|net))(:\d+)?$/;

const endpointHosts = (e: Endpoints) => [simplifyHost(e.api), simplifyHost(e.gateway), e.cdnHost];

export function instanceOfUrl(url: string): string | null {
    const host = simplifyHost(url);
    if (!host) return null;
    if (DISCORD_HOST.test(host)) return DISCORD;
    if (state.endpoints && endpointHosts(state.endpoints).includes(host)) return currentInstance();

    for (const server of servers()) {
        const e = endpointsOf(server);
        if (e && endpointHosts(e).includes(host)) return server.id;
    }
    return null;
}

export const isCurrentInstanceUrl = (url: string) => state.endpoints != null && instanceOfUrl(url) === currentInstance();
