import { intercept } from "@api/flux";

import { state } from "./state";

const SNOWFLAKE = /^\d{17,20}$/;

function fixEmoji(emoji: any) {
    if (emoji && !emoji.id && SNOWFLAKE.test(emoji.name ?? "")) {
        emoji.id = emoji.name;
        emoji.animated ??= true;
    }
}

// spacebar leaves these out and the native message renderer fails the whole message without them
function fixReaction(reaction: any) {
    if (!reaction) return;
    fixEmoji(reaction.emoji);
    reaction.me ??= false;
    reaction.me_burst ??= false;
    reaction.burst_count ??= 0;
    reaction.count_details ??= { normal: reaction.count ?? 0, burst: 0 };
    reaction.burst_colors ??= [];
}

// replies and forwards carry their own copy of the original message
function fixMessage(message: any, depth = 0) {
    if (!message || depth > 2) return;
    for (const reaction of message.reactions ?? []) fixReaction(reaction);
    fixMessage(message.referenced_message, depth + 1);
    for (const snapshot of message.message_snapshots ?? []) fixMessage(snapshot?.message, depth + 1);
}

export function patchReactions() {
    return [
        intercept(payload => {
            if (!state.endpoints) return null;
            // runs inside every dispatch, a throw here fails the dispatch (CACHE_LOADED then clears the whole cache)
            try {
                const p = payload as any;
                fixEmoji(p.reaction?.emoji ?? p.emoji);
                // CACHE_LOADED keys messages by channel
                const messages = Array.isArray(p.messages) ? p.messages : p.messages && typeof p.messages === "object" ? Object.values(p.messages) : p.message ? [p.message] : [];
                for (const message of messages.flat()) fixMessage(message);
            } catch (e) {
                console.warn("[ChangeEndpoint] reaction fix failed", e);
            }
            return null;
        }),
    ];
}
