import { intercept } from "@api/flux";

import { state } from "./state";

// spacebar's src is always mp4 (grey as an image) and its url is the klipy page, which doesn't embed
function fixGif(item: any) {
    if (!item || typeof item.gif_src !== "string") return;
    item.src = item.gif_src;
    item.url = item.gif_src;
}

export function patchGifs() {
    return [
        intercept(payload => {
            if (!state.endpoints) return null;
            try {
                const p = payload as any;
                if (p.type === "GIF_PICKER_QUERY_SUCCESS" && Array.isArray(p.items)) for (const item of p.items) fixGif(item);
                else if (p.type === "GIF_PICKER_TRENDING_FETCH_SUCCESS") fixGif(p.trendingGIFPreview);
            } catch (e) {
                console.warn("[ChangeEndpoint] gif fix failed", e);
            }
            return null;
        }),
    ];
}
