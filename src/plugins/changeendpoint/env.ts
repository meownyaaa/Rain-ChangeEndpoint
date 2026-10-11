import type { Endpoints } from "./config";
import { state } from "./state";

type Env = Record<string, unknown>;

const KEYS: Record<string, (e: Endpoints) => string> = {
    API_ENDPOINT: e => e.api,
    GATEWAY_ENDPOINT: e => e.gateway,
    GATEWAY_ALT_ENDPOINT: e => e.gateway,
    CDN_HOST: e => e.cdnHost,
    MEDIA_PROXY_ENDPOINT: e => e.media,
    ASSET_ENDPOINT: e => e.media,
};

export const discordEnv: Env = {};

// getters per key, Discord reassigns keys after creating the object so a plain merge doesn't stick
function pin(env: Env) {
    Object.keys(KEYS).forEach(key => {
        if (key in env && !(key in discordEnv)) discordEnv[key] = env[key];
        Object.defineProperty(env, key, {
            configurable: true,
            enumerable: true,
            get: () => (state.endpoints ? KEYS[key](state.endpoints) : discordEnv[key]),
            set(value) {
                discordEnv[key] = value;
            },
        });
    });
    return env;
}

export function installGlobalEnv() {
    const g = globalThis as { GLOBAL_ENV?: Env };
    if (g.GLOBAL_ENV) {
        pin(g.GLOBAL_ENV);
        return;
    }

    let env: Env | undefined;
    Object.defineProperty(globalThis, "GLOBAL_ENV", {
        configurable: true,
        enumerable: true,
        get: () => env,
        set(value: Env) {
            env = value && typeof value === "object" ? pin(value) : value;
        },
    });
}

const DISCORD_GATEWAY = /^wss?:\/\/gateway[\w.-]*\.discord\.gg(?=[/?]|$)/;

const gatewayWatchers = new Set<(ws: WebSocket) => void>();
export const onGatewaySocket = (fn: (ws: WebSocket) => void) => {
    gatewayWatchers.add(fn);
    return () => void gatewayWatchers.delete(fn);
};

// safety net until the gateway patches are in: never let a custom server's token reach Discord's gateway
export function guardWebSocket() {
    const Original = globalThis.WebSocket;
    globalThis.WebSocket = new Proxy(Original, {
        construct(target, args, newTarget) {
            if (state.endpoints && typeof args[0] === "string" && DISCORD_GATEWAY.test(args[0]))
                args[0] = args[0].replace(DISCORD_GATEWAY, state.endpoints.gateway.replace(/\/+$/, ""));
            const ws = Reflect.construct(target, args, newTarget) as WebSocket;
            const gateway = state.endpoints?.gateway.replace(/\/+$/, "");
            if (gateway && typeof args[0] === "string" && args[0].startsWith(gateway)) gatewayWatchers.forEach(fn => fn(ws));
            return ws;
        },
    });
    return () => {
        globalThis.WebSocket = Original;
    };
}
