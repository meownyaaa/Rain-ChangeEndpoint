import { intercept } from "@api/flux";
import { instead } from "@api/patcher";
import { findByProps, findByStoreName } from "@metro";

import { onGatewaySocket } from "./env";
import { accountLog, currentInstance, linkAccount, setInstance, state } from "./state";

const linkedElsewhere = (userId: string) => {
    const linked = state.config.accounts[userId];
    return linked != null && linked !== currentInstance();
};

const LOGGED = /^(LOGIN|LOGOUT|MULTI_ACCOUNT|CONNECTION_OPEN$|CONNECTION_CLOSED|CONNECTION_INTERRUPTED|SESSION|REGISTER|AUTH_SESSION|PASSWORD|MFA|USER_SETTINGS_ACCOUNT)/;

// only ids, flags and errors, never tokens
function describe(payload: Record<string, any>) {
    const parts: string[] = [];
    const user = payload.user?.id ?? payload.userId ?? payload.user_id;
    if (user) parts.push(`user ${user}`);
    for (const key of ["code", "reason", "status", "error", "message", "isSwitchingAccount", "isLogin", "source"]) {
        const value = payload[key];
        if (value == null || typeof value === "function") continue;
        const text = typeof value === "object" ? JSON.stringify(value) : String(value);
        if (!/token/i.test(key)) parts.push(`${key} ${text.slice(0, 160)}`);
    }
    if (Array.isArray(payload.users)) parts.push(`users ${payload.users.map((u: { id?: string }) => u?.id).join(",")}`);
    return parts.join(", ");
}

export function patchAccounts() {
    const user = findByStoreName("UserStore")?.getCurrentUser?.();
    if (user) linkAccount(user.id);
    accountLog(`start on ${currentInstance()} as ${user?.id ?? "nobody"}`);

    return [
        onGatewaySocket(ws => {
            const url = String(ws.url).replace(/\?.*/, "");
            accountLog(`gateway open ${url}`);
            ws.addEventListener("close", e => accountLog(`gateway close ${url} ${e.code} ${e.reason ?? ""}`));
        }),
        intercept(payload => {
            if (LOGGED.test(payload.type)) accountLog(`${payload.type} ${describe(payload)} on ${currentInstance()}`);
            if (payload.type === "CONNECTION_OPEN" && payload.user?.id) linkAccount(payload.user.id);
            // validation of an account on another server goes to the wrong server and would log it out
            else if (payload.type === "MULTI_ACCOUNT_VALIDATE_TOKEN_FAILURE" && payload.userId && linkedElsewhere(payload.userId))
                return { type: "MULTI_ACCOUNT_VALIDATE_TOKEN_SUCCESS" };
            return null;
        }),
        instead("switchAccount", findByProps("switchAccount", "validateMultiAccountTokens"), function (this: unknown, args: any[], switchAccount: Function) {
            const target = state.config.accounts[args[0]];
            accountLog(`switchAccount ${args[0]} linked to ${target ?? "nothing"}, on ${currentInstance()}`);
            if (target && target !== currentInstance() && !setInstance(target)) return Promise.resolve();
            return switchAccount.apply(this, args);
        }),
    ];
}
