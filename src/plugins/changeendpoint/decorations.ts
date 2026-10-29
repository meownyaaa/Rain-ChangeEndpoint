import { instead } from "@api/patcher";
import { findByProps } from "@metro";

import { state } from "./state";

// decorations come from Discord's collectibles shop by sku, without it they fall back to the server's own cdn
export function patchDecorations() {
    return [
        instead("getCollectiblesItemAssetUrl", findByProps("getCollectiblesItemAssetUrl"), function (this: unknown, args: unknown[], original: Function) {
            return state.endpoints ? null : original.apply(this, args);
        }),
    ];
}
