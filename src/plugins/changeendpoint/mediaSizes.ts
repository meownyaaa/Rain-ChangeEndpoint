import { fileExists, readFile, writeFile } from "@api/native/fs";
import { findByStoreName } from "@metro";
import { FluxDispatcher } from "@metro/common";

import { state } from "./state";
import { native } from "./voice";

const PATH = "plugins/changeendpoint-media-sizes.json";

// spacebar never measures videos, the tweak reads the real size once a video has been downloaded
let sizes: Record<string, [number, number]> = {};

export const mediaSize = (attachmentId: string) => sizes[attachmentId];

const VIDEO = /^video\//;
const MARK = "ce-thumb=1";

// a failed thumbnail stays failed for that exact url, so measured videos get a slightly different one
export function markThumbnail(attachment: { content_type?: string; url?: string; proxy_url?: string }) {
    if (!VIDEO.test(attachment.content_type ?? "")) return;
    for (const key of ["url", "proxy_url"] as const) {
        const value = attachment[key];
        if (value && !value.includes(MARK)) attachment[key] = `${value}${value.includes("?") ? "&" : "?"}${MARK}`;
    }
}

const requested = new Set<string>();

// the tweak downloads small videos one at a time and makes a preview frame from them
export function prefetchVideo(attachment: { id: string; content_type?: string; url?: string; proxy_url?: string; size?: number }) {
    if (!VIDEO.test(attachment.content_type ?? "") || requested.has(attachment.id)) return;
    const url = attachment.proxy_url || attachment.url;
    if (!url || !attachment.size || attachment.size > 15 * 1024 * 1024) return;
    requested.add(attachment.id);
    native("media.prefetch", [url, attachment.size]).catch(() => {});
}

export async function loadMediaSizes() {
    try {
        if (await fileExists(PATH)) sizes = JSON.parse(await readFile(PATH)) ?? {};
    } catch {}
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => writeFile(PATH, JSON.stringify(sizes)).catch(() => {}), 2000);
}

// the attachment fix in reactions.ts picks the size up as the message passes through again
function rerender(channelId: string, attachmentId: string) {
    const messages = findByStoreName("MessageStore").getMessages(channelId);
    const list: any[] = messages?._array ?? messages?.toArray?.() ?? [];
    for (const message of list) {
        if (!message.attachments?.some((a: { id: string }) => a.id === attachmentId)) continue;
        FluxDispatcher.dispatch({
            type: "MESSAGE_UPDATE",
            message: { id: message.id, channel_id: channelId, attachments: message.attachments.map((a: object) => ({ ...a })) },
        });
    }
}

export function pollMediaSizes() {
    const timer = setInterval(async () => {
        if (!state.endpoints) return;
        let found: [string, string, number, number][];
        try {
            found = await native<[string, string, number, number][]>("media.sizes");
        } catch {
            // an older tweak doesn't measure
            return clearInterval(timer);
        }
        for (const [channelId, attachmentId, width, height] of found) {
            if (!width || !height) continue;
            sizes[attachmentId] = [width, height];
            rerender(channelId, attachmentId);
        }
        if (found.length) save();
    }, 3000);
    return [() => clearInterval(timer)];
}
