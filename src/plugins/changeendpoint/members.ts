import { intercept } from "@api/flux";
import { findByStoreName } from "@metro";

import { state } from "./state";

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
                }
            } catch (e) {
                console.warn("[ChangeEndpoint] message member fix failed", e);
            }
            return null;
        }),
    ];
}
