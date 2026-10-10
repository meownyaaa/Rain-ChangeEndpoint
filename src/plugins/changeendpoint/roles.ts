import { after, instead } from "@api/patcher";
import { findByProps, findByStoreName } from "@metro";

import { state } from "./state";

type Role = { id: string; icon?: string | null; colorString?: string | null; colorStrings?: unknown };
type Member = { colorString?: string | null; colorStrings?: unknown; colorRoleId?: string };

// spacebar allows a color on @everyone, Discord only takes colors from assigned roles
function withEveryoneColor<T>(member: T, guildId: unknown): T {
    const m = member as Member | null | undefined;
    if (!state.endpoints || !m || typeof m !== "object" || m.colorString != null || m.colorRoleId != null || typeof guildId !== "string") return member;
    let everyone: Role | undefined;
    try {
        everyone = findByStoreName("GuildRoleStore").getRole(guildId, guildId);
    } catch {
        return member;
    }
    if (!everyone?.colorString) return member;
    // filled in place so the member keeps its identity for store subscribers
    m.colorString = everyone.colorString;
    m.colorStrings = everyone.colorStrings ?? null;
    m.colorRoleId = everyone.id;
    return member;
}

export function patchRoles() {
    const members = Object.getPrototypeOf(findByStoreName("GuildMemberStore"));

    return [
        instead("getMember", members, function (this: unknown, args: unknown[], original: Function) {
            return withEveryoneColor(original.apply(this, args), args[0]);
        }),
        instead("getTrueMember", members, function (this: unknown, args: unknown[], original: Function) {
            return withEveryoneColor(original.apply(this, args), args[0]);
        }),
        instead("getMembers", members, function (this: unknown, args: unknown[], original: Function) {
            const list = original.apply(this, args);
            if (Array.isArray(list)) for (const m of list) withEveryoneColor(m, args[0]);
            return list;
        }),
        // spacebar sends icon "" on emoji roles, Discord then builds a broken image url and skips the emoji
        after("getRoleIconData", findByProps("getRoleIconData", "canGuildUseRoleIcons"), (args: any[], data: { customIconSrc?: string } | null) => {
            const role = args[0] as Role | undefined;
            if (!state.endpoints || !data?.customIconSrc || role?.icon) return data;
            const { customIconSrc: _, ...rest } = data;
            return rest;
        }),
    ];
}
