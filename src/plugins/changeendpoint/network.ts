import { instead } from "@api/patcher";
import { showToast } from "@api/ui/toasts";
import { findByProps } from "@metro";

import { withoutSpoofedFeatures } from "./boosts";
import { currentInstance, instanceOfUrl, isCurrentInstanceUrl, serverName, state } from "./state";
import { isAccountSwitcherOpen, openAccountSwitcher } from "./switcher";

type Payload = { op: number; d?: Record<string, any> };

const ACTIVITY_KEYS = [
    "name", "type", "url", "timestamps", "application_id", "details", "state", "emoji", "party",
    "assets", "secrets", "instance", "flags", "id", "sync_id", "metadata", "session_id", "platform", "buttons",
];

const trimPresence = (p: Record<string, any>, keepActivities: boolean) => ({
    status: p.status,
    since: p.since ?? 0,
    afk: !!p.afk,
    activities: keepActivities
        ? (p.activities ?? []).map((a: Record<string, any>) => {
            const out: Record<string, any> = {};
            for (const k of ACTIVITY_KEYS) if (k in a) out[k] = a[k];
            if (typeof out.flags === "number") out.flags = String(out.flags);
            if (out.emoji) out.emoji = { name: out.emoji.name, id: out.emoji.id, animated: out.emoji.animated };
            return out;
        })
        : [],
});

// harmony rejects these with 4000
const MOBILE_ONLY_PROPERTIES = ["device_vendor_id", "design_id", "client_version", "client_app_state", "is_fast_connect", "gateway_connect_reasons"];

function cleanGatewayPayload(payload: Payload) {
    const d = payload.d;
    if (!d) return payload;

    if (payload.op === 2) {
        delete d.qos_token;
        delete d.client_state;
        if (d.properties) for (const key of MOBILE_ONLY_PROPERTIES) delete d.properties[key];
        if (d.presence) d.presence = trimPresence(d.presence, false);
        // spacebar only broadcasts coming online when the identify says offline
        if (state.endpoints && d.presence && d.presence.status !== "invisible") d.presence.status = "offline";
    } else if (payload.op === 3) payload.d = trimPresence(d, true);
    else if (payload.op === 4) delete d.preferred_regions;

    return payload;
}

let tokenManager: { getToken(userId?: string): string | null } | undefined;

export function tokenInstance(token: string | null | undefined) {
    if (!token) return null;
    tokenManager ??= findByProps("getToken", "setToken", "encryptAndStoreTokens");
    for (const [userId, instance] of Object.entries(state.config.accounts))
        if (tokenManager?.getToken(userId) === token) return instance;
    return null;
}

// a token linked to one server must never reach another
export function isTokenAllowed(token: string | null | undefined, url: string) {
    const target = instanceOfUrl(url);
    const owner = target && tokenInstance(token);
    return !target || !owner || target === owner;
}

const MESSAGE_SEND = /^(POST|PATCH) .*\/channels\/\d+\/messages(\/\d+)?$/;
const GUILD_EDIT = /^PATCH .*\/guilds\/(\d+)$/;

function cleanGuildEdit(guildId: string, body: string) {
    const json = JSON.parse(body);
    if (Array.isArray(json.features)) {
        const features = withoutSpoofedFeatures(guildId, json.features);
        if (features) json.features = features;
        else delete json.features;
    }
    // mobile sends "" for no channel and spacebar fails on both "" and null, so unset channels are left out
    for (const key of Object.keys(json)) if (key.endsWith("_channel_id") && (json[key] === "" || json[key] === null)) delete json[key];
    return JSON.stringify(json);
}
const requests = new WeakMap<XMLHttpRequest, { tag: string; url: string }>();

const blocked = (where: string) => console.warn(`[ChangeEndpoint] Blocked a request carrying another server's token: ${where}`);

let lastRescue = 0;

// the signed in account belongs to another server, so nothing loads and the You sheet hides the switcher
function offerAccountSwitch(token: string | undefined) {
    if (Date.now() - lastRescue < 15000) return;
    lastRescue = Date.now();
    setTimeout(() => {
        const owner = tokenInstance(token);
        showToast(`This account is on ${serverName(owner)}. Switch to or add a ${serverName(currentInstance())} account.`);
        if (!isAccountSwitcherOpen()) openAccountSwitcher();
    }, 0);
}

export function patchNetwork() {
    return [
        instead("send", WebSocket.prototype, function (this: WebSocket, args: any[], send: Function) {
            const [data] = args;
            if (typeof data !== "string" || !/"op":[2346][,}]/.test(data)) return send.apply(this, args);

            const payload: Payload = JSON.parse(data);
            if ((payload.op === 2 || payload.op === 6) && !isTokenAllowed(payload.d?.token, this.url)) {
                blocked(`gateway op ${payload.op}`);
                this.close(1000);
                if (payload.op === 2) offerAccountSwitch(payload.d?.token);
                return;
            }
            if (!isCurrentInstanceUrl(this.url)) return send.apply(this, args);
            return send.call(this, JSON.stringify(cleanGatewayPayload(payload)));
        }),
        instead("open", XMLHttpRequest.prototype, function (this: XMLHttpRequest, args: any[], open: Function) {
            const url = String(args[1]);
            requests.set(this, { tag: `${args[0]} ${url.split("?")[0]}`, url });
            return open.apply(this, args);
        }),
        instead("setRequestHeader", XMLHttpRequest.prototype, function (this: XMLHttpRequest, args: any[], setHeader: Function) {
            const req = requests.get(this);
            if (req && String(args[0]).toLowerCase() === "authorization" && !isTokenAllowed(args[1], req.url)) {
                blocked(req.tag);
                return;
            }
            return setHeader.apply(this, args);
        }),
        instead("send", XMLHttpRequest.prototype, function (this: XMLHttpRequest, args: any[], send: Function) {
            const req = requests.get(this);
            const [body] = args;
            const guildId = req && typeof body === "string" && isCurrentInstanceUrl(req.url) ? req.tag.match(GUILD_EDIT)?.[1] : undefined;
            if (guildId) return send.call(this, cleanGuildEdit(guildId, body));
            if (req && typeof body === "string" && MESSAGE_SEND.test(req.tag) && isCurrentInstanceUrl(req.url) && /signal_strength|mobile_network_type/.test(body)) {
                const json = JSON.parse(body);
                delete json.signal_strength;
                delete json.mobile_network_type;
                return send.call(this, JSON.stringify(json));
            }
            return send.apply(this, args);
        }),
    ];
}
