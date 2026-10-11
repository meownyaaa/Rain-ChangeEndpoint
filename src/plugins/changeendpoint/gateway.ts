import { before, instead } from "@api/patcher";
import { findByStoreName } from "@metro";
import { waitFor } from "@metro/internals/modules";

import { discordEnv } from "./env";
import { onInstanceChange, state } from "./state";

interface GatewaySocket {
    _getGatewayUrl(): string;
    compressionHandler: { getAlgorithm(): string };
    resumeUrl: string | null;
    webSocket?: { url?: string } | null;
    close?(): void;
    connect(): void;
    resetBackoff?(): void;
}

const currentGateway = () => state.endpoints?.gateway ?? String(discordEnv.GATEWAY_ENDPOINT ?? "wss://gateway.discord.gg");

const swapOrigin = (url: string, origin: string) => url.replace(/^wss?:\/\/[^/?]+/, origin.replace(/\/+$/, ""));

const unpatches: (() => unknown)[] = [];
let installed = false;

function install(socket: GatewaySocket | undefined) {
    if (installed || !socket?.compressionHandler) return false;
    installed = true;
    unpatches.push(
        instead("_getGatewayUrl", Object.getPrototypeOf(socket), function (this: GatewaySocket, args: unknown[], getUrl: Function) {
            const url = String(getUrl.apply(this, args));
            return state.endpoints ? swapOrigin(url, currentGateway()) : url;
        }),
        // zstd-stream breaks on spacebar
        instead("getAlgorithm", Object.getPrototypeOf(socket.compressionHandler), function (this: unknown, args: unknown[], getAlgorithm: Function) {
            return state.endpoints ? "" : getAlgorithm.apply(this, args);
        }),
        // spacebar's stream delete sends a voice state whose member has no user, Discord throws on it and resets the gateway
        before("_handleDispatch", Object.getPrototypeOf(socket), (args: any[]) => {
            const [data, type] = args;
            if (state.endpoints && type === "VOICE_STATE_UPDATE" && data?.member && !data.member.user) delete data.member;
        }),
        onInstanceChange(() => {
            socket.resumeUrl = null;
        }),
    );
    if (state.endpoints) socket.resumeUrl = null;
    return true;
}

const storeFilter = Object.assign(
    (m: any) => {
        const store = m?.default ?? m;
        return store?.getName?.length === 0 && store.getName() === "GatewayConnectionStore" ? store : undefined;
    },
    { key: "rain.metro.byStoreName(GatewayConnectionStore)" },
);

// patched as soon as the store exists, a reconnect later would land during Discord's cache load and it clears the cache
export function patchGatewayEarly() {
    const cancel = waitFor(storeFilter, (store: { getSocket(): GatewaySocket }) => install(store.getSocket()));
    return [cancel, () => unpatches.forEach(unpatch => unpatch())];
}

export function patchGateway() {
    const socket = findByStoreName("GatewayConnectionStore").getSocket() as GatewaySocket;
    // only needed when the early patch missed the first connection
    if (install(socket) && state.endpoints) {
        const url = socket.webSocket?.url;
        if (url && (!url.startsWith(state.endpoints.gateway) || url.includes("compress="))) {
            socket.resetBackoff?.();
            socket.close?.();
            socket.connect();
        }
    }
    return [];
}
