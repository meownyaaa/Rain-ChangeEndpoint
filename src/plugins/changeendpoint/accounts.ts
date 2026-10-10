import { intercept } from "@api/flux";
import { instead } from "@api/patcher";
import { findByProps, findByStoreName } from "@metro";

import { currentInstance, linkAccount, setInstance, state } from "./state";

const linkedElsewhere = (userId: string) => {
    const linked = state.config.accounts[userId];
    return linked != null && linked !== currentInstance();
};

export function patchAccounts() {
    const user = findByStoreName("UserStore")?.getCurrentUser?.();
    if (user) linkAccount(user.id);

    return [
        intercept(payload => {
            if (payload.type === "CONNECTION_OPEN" && payload.user?.id) linkAccount(payload.user.id);
            // validation of an account on another server goes to the wrong server and would log it out
            else if (payload.type === "MULTI_ACCOUNT_VALIDATE_TOKEN_FAILURE" && payload.userId && linkedElsewhere(payload.userId))
                return { type: "MULTI_ACCOUNT_VALIDATE_TOKEN_SUCCESS" };
            return null;
        }),
        instead("switchAccount", findByProps("switchAccount", "validateMultiAccountTokens"), function (this: unknown, args: any[], switchAccount: Function) {
            const target = state.config.accounts[args[0]];
            if (target && target !== currentInstance() && !setInstance(target)) return Promise.resolve();
            return switchAccount.apply(this, args);
        }),
    ];
}
