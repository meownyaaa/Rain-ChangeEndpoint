import { instead } from "@api/patcher";
import { findByProps, findByStoreName } from "@metro";
import { constants } from "@metro/common";

import { state } from "./state";

// permissions spacebar doesn't enforce, which Discord's client would still block
const ignored = () => {
    const P = constants.Permissions;
    return [P.USE_EXTERNAL_STICKERS];
};

const disrespected = (permission: unknown) =>
    !!state.endpoints && state.config.disrespectPermissions !== false && ignored().includes(permission as bigint);

export function patchPermissions() {
    const utils = findByProps("can", "canEveryoneRole", "computePermissions");
    const store = Object.getPrototypeOf(findByStoreName("PermissionStore"));

    return [
        instead("can", utils, function (this: unknown, args: any[], can: Function) {
            return disrespected(args[0]?.permission) || can.apply(this, args);
        }),
        instead("can", store, function (this: unknown, args: any[], can: Function) {
            return disrespected(args[0]) || can.apply(this, args);
        }),
        instead("canWithPartialContext", store, function (this: unknown, args: any[], can: Function) {
            return disrespected(args[0]) || can.apply(this, args);
        }),
    ];
}
