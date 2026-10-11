import { fileExists, readFile, writeFile } from "@api/native/fs";
import { after } from "@api/patcher";
import { findByProps } from "@metro";
import { ReactNative } from "@metro/common";
import React from "react";

import { onGatewaySocket } from "./env";
import { currentInstance, state } from "./state";

const PATH = "plugins/changeendpoint-channel-icons.json";
const SIZES: Record<string, number> = { xxs: 12, xs: 16, sm: 20, md: 24, lg: 32, refreshSmall16: 16 };

// per server, channel id -> icon. Discord's channel records drop the icon field
let saved: Record<string, Record<string, string>> = {};
const icons = new Map<string, string>();

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saved[currentInstance()] = Object.fromEntries(icons);
        writeFile(PATH, JSON.stringify(saved)).catch(() => {});
    }, 2000);
}

export async function loadChannelIcons() {
    try {
        if (await fileExists(PATH)) saved = JSON.parse(await readFile(PATH)) ?? {};
    } catch {}
    icons.clear();
    for (const [id, icon] of Object.entries(saved[currentInstance()] ?? {})) icons.set(id, icon);
}

export const getChannelIcon = (channelId: string) => icons.get(channelId);

export function setChannelIcon(channelId: string, icon: string | null) {
    if (icon) icons.set(channelId, icon);
    else icons.delete(channelId);
    save();
}

function take(channel: any) {
    if (!channel?.id || !("icon" in channel)) return false;
    if (channel.icon) icons.set(channel.id, channel.icon);
    else icons.delete(channel.id);
    return true;
}

const ICON_EVENTS = /"t":"(READY|GUILD_CREATE|CHANNEL_CREATE|CHANNEL_UPDATE)"/;

// mobile turns gateway channels into records natively before any flux action, so read the raw messages
function collect(data: unknown) {
    if (typeof data !== "string" || !data.includes("\"icon\"")) return;
    const event = data.match(ICON_EVENTS)?.[1];
    if (!event) return;
    const { d } = JSON.parse(data);
    let changed = false;
    if (event === "READY") for (const g of d.guilds ?? []) for (const c of g.channels ?? []) changed = take(c) || changed;
    else if (event === "GUILD_CREATE") for (const c of d.channels ?? []) changed = take(c) || changed;
    else changed = take(d);
    if (changed) save();
}

// icons can point at another folder (../<guild id>/<hash>), and iOS doesn't normalize the path
function resolvePath(path: string) {
    const out: string[] = [];
    for (const segment of path.split("/")) {
        if (segment === "..") out.pop();
        else if (segment && segment !== ".") out.push(segment);
    }
    return out.join("/");
}

type IconProps = { size?: string; style?: unknown };
const components = new Map<string, React.FC<IconProps>>();

export const channelIconUrl = (channelId: string, icon: string) =>
    `https://${state.endpoints!.cdnHost}/${resolvePath(`channel-icons/${channelId}/${icon}.png`)}`;

function iconComponent(channelId: string, icon: string) {
    const key = `${channelId}/${icon}`;
    let Icon = components.get(key);
    if (!Icon) {
        const uri = channelIconUrl(channelId, icon);
        Icon = ({ size, style }) => {
            const px = SIZES[size ?? ""] ?? 20;
            return <ReactNative.Image source={{ uri }} style={[style as object, { width: px, height: px, borderRadius: 4 }]} resizeMode="contain" />;
        };
        components.set(key, Icon);
    }
    return Icon;
}

export function collectChannelIcons() {
    return [
        onGatewaySocket(ws =>
            ws.addEventListener("message", e => {
                try {
                    collect(e.data);
                } catch (err) {
                    console.warn("[ChangeEndpoint] channel icon collect failed", err);
                }
            }),
        ),
    ];
}

export function patchChannelIcons() {
    const icons_ = findByProps("getChannelIconComponent", "getSimpleChannelIconComponent");
    const swap = (args: any[], component: unknown) => {
        const channel = args[0];
        const icon = state.endpoints && channel?.id ? icons.get(channel.id) : undefined;
        return icon ? iconComponent(channel.id, icon) : component;
    };
    return ["getChannelIconComponent", "getChannelIconComponentWithGuild", "getSimpleChannelIconComponent"].map(name => after(name, icons_, swap));
}
