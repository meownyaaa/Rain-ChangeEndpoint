import { intercept } from "@api/flux";
import { findByProps, findByStoreName } from "@metro";
import { FluxDispatcher } from "@metro/common";

import { state } from "./state";

// spacebar's op 8 skips offline members without a nick or role in large guilds and calls them not found
const notMembers = new Set<string>();
const queued = new Set<string>();
let fetching = false;

async function fetchMissingMembers() {
    if (fetching) return;
    fetching = true;
    try {
        for (const key of queued) {
            queued.delete(key);
            const [guildId, userId] = key.split(":");
            try {
                const { body } = await findByProps("get", "post", "put", "patch", "del", "V8APIError").get({ url: `/guilds/${guildId}/members/${userId}` });
                FluxDispatcher.dispatch({ type: "GUILD_MEMBERS_CHUNK_BATCH", chunks: [{ guildId, members: [body], notFound: [] }] });
            } catch (e: any) {
                if (e?.status === 404) notMembers.add(key);
            }
        }
    } finally {
        fetching = false;
    }
}

function queueNotFound(guildId: string | undefined, userIds: unknown) {
    if (!guildId || !Array.isArray(userIds)) return;
    for (const userId of userIds) {
        const key = `${guildId}:${userId}`;
        if (!notMembers.has(key)) queued.add(key);
    }
    if (queued.size) setTimeout(fetchMissingMembers, 0);
}

type PartialMember = { user?: { id?: string }; userId?: string; user_id?: string; guildId?: string; guild_id?: string; roles?: string[] };

// spacebar puts the raw member row on MESSAGE_CREATE with roles never loaded, Discord would replace the real roles with it
function fixMember(member: PartialMember, guildId: string | undefined, authorId?: string) {
    const userId = member.user?.id ?? member.userId ?? member.user_id ?? authorId;
    guildId = member.guild_id ?? member.guildId ?? guildId;
    if (!userId || !guildId) return false;
    const known = findByStoreName("GuildMemberStore")?.getMember(guildId, userId);
    if (!known) return false;
    member.roles = [...(known.roles ?? [])];
    return true;
}

export function patchMessageMembers() {
    return [
        intercept(payload => {
            if (!state.endpoints) return null;
            try {
                const p = payload as any;
                if (p.type === "MESSAGE_CREATE" || p.type === "MESSAGE_UPDATE") {
                    const message = p.message;
                    // unknown members are left out so the real one arrives later instead
                    if (message?.member && !fixMember(message.member, message.guild_id ?? p.guildId, message.author?.id)) delete message.member;
                } else if (p.type === "LOCAL_MESSAGES_LOADED" && Array.isArray(p.members)) {
                    p.members = p.members.filter((m: PartialMember) => fixMember(m, p.guildId));
                } else if (p.type === "GUILD_MEMBERS_CHUNK_BATCH" && Array.isArray(p.chunks)) {
                    for (const chunk of p.chunks) queueNotFound(chunk.guildId, chunk.notFound);
                } else if (p.type === "GUILD_MEMBERS_CHUNK") {
                    queueNotFound(p.guildId, p.notFound);
                }
            } catch (e) {
                console.warn("[ChangeEndpoint] message member fix failed", e);
            }
            return null;
        }),
    ];
}
