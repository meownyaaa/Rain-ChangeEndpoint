import { instead } from "@api/patcher";
import { findByProps } from "@metro";
import { waitFor } from "@metro/internals/modules";

import { state } from "./state";

// spacebar's invite hosts, Discord only knows its own INVITE_HOST
const INVITE_HOSTS = ["sbar.fyi", "sbar.top", "fermi.chat"];
const INVITE_PATHS = ["/invite", "/i"];

type ParsedURL = { host?: string | null; hostname?: string | null; pathname?: string | null } | null | undefined;
let parse: (raw: string) => ParsedURL = () => null;

const isInviteHost = (host?: string | null) => !!host && INVITE_HOSTS.some(h => host === h || host.endsWith(`.${h}`));

function remainingPath(url: ParsedURL) {
    if (!url || !isInviteHost(url.hostname ?? url.host)) return null;
    const path = url.pathname ?? "";
    const prefix = INVITE_PATHS.find(p => path.startsWith(`${p}/`));
    return prefix ? path.slice(prefix.length) : null;
}

function inviteFrom(raw: string) {
    const code = remainingPath(parse(raw))?.split("/")[1];
    return code ? { type: "INVITE", code, url: raw } : undefined;
}

const LINK = /https?:\/\/[^\s<>()]+/gi;
const invitesIn = (text: string) => (text.match(LINK) ?? []).map(inviteFrom).filter(Boolean) as { code: string }[];

interface CodedLinks {
    parseURLSafely(raw: string): ParsedURL;
    [name: string]: unknown;
}

const unpatches: (() => unknown)[] = [];
let installed = false;

function wrap(links: CodedLinks, name: string, fn: (original: Function, args: any[]) => unknown) {
    // not every build has every helper
    if (typeof links[name] !== "function") return;
    unpatches.push(instead(name, links, function (this: unknown, args: any[], original: Function) {
        return fn((...a: unknown[]) => original.apply(this, a), args);
    }));
}

// other modules call these through the exports, the module's own calls can't be reached
function install(links: CodedLinks | undefined) {
    if (installed || !links) return;
    installed = true;
    parse = raw => links.parseURLSafely(raw);
    wrap(links, "getPathsFromURL", (original, args) => {
        const result = original(...args) as { url?: ParsedURL; inviteHostRemainingPath?: string | null } | null;
        if (!state.endpoints || !result || result.inviteHostRemainingPath) return result;
        const path = remainingPath(result.url);
        return path ? { ...result, inviteHostRemainingPath: path } : result;
    });
    wrap(links, "findCodedLink", (original, args) => {
        const found = original(...args);
        return found || !state.endpoints || typeof args[0] !== "string" ? found : inviteFrom(args[0]);
    });
    wrap(links, "containsCodedLink", (original, args) => {
        const found = original(...args);
        return found || !state.endpoints || typeof args[0] !== "string" ? found : invitesIn(args[0]).length > 0;
    });
    // message records take their invite cards from this, the startup cache builds them before start()
    wrap(links, "default", (original, args) => {
        const found = original(...args);
        if (!state.endpoints || typeof args[0] !== "string" || !Array.isArray(found)) return found;
        const extra = invitesIn(args[0]).filter(i => !found.some((f: { code?: string }) => f?.code === i.code));
        return extra.length ? [...found, ...extra] : found;
    });
}

const linksFilter = Object.assign(
    (m: any) => (m?.findCodedLink && m.getPathsFromURL ? m : undefined),
    { key: "rain.metro.byProps(findCodedLink,getPathsFromURL)" },
);

export function patchInvitesEarly() {
    const cancel = waitFor(linksFilter, install);
    return [cancel, () => unpatches.forEach(unpatch => unpatch())];
}

export function patchInvites() {
    install(findByProps("findCodedLink", "getPathsFromURL"));
    return [];
}
