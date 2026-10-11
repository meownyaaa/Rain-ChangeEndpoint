import { intercept } from "@api/flux";

import { markThumbnail, mediaSize, prefetchVideo } from "./mediaSizes";
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

// spacebar doesn't measure videos, Discord shows media without a size as a plain file.
// measured videos have their real size saved, the rest get a placeholder
function fixAttachment(attachment: any, viewing: boolean) {
    if (!attachment || !/^(video|image)\//.test(attachment.content_type ?? "")) return;
    const known = mediaSize(attachment.id);
    if (known) {
        [attachment.width, attachment.height] = known;
        markThumbnail(attachment);
    } else {
        if (!attachment.width || !attachment.height) {
            attachment.width = 640;
            attachment.height = 360;
        }
        if (viewing) prefetchVideo(attachment);
    }
}

// messages someone is looking at, as opposed to the whole startup cache
const VIEWING = new Set(["LOAD_MESSAGES_SUCCESS", "LOCAL_MESSAGES_LOADED", "MESSAGE_CREATE"]);

// replies and forwards carry their own copy of the original message
function fixMessage(message: any, viewing: boolean, depth = 0) {
    if (!message || depth > 2) return;
    for (const reaction of message.reactions ?? []) fixReaction(reaction);
    for (const attachment of message.attachments ?? []) fixAttachment(attachment, viewing);
    fixMessage(message.referenced_message, viewing, depth + 1);
    for (const snapshot of message.message_snapshots ?? []) fixMessage(snapshot?.message, viewing, depth + 1);
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
                const viewing = VIEWING.has(p.type);
                for (const message of messages.flat()) fixMessage(message, viewing);
            } catch (e) {
                console.warn("[ChangeEndpoint] reaction fix failed", e);
            }
            return null;
        }),
    ];
}
