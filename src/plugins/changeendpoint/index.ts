import { logger } from "@lib/utils/logger";
import { definePlugin } from "@plugins";

import { patchAccounts } from "./accounts";
import { guardWebSocket, installGlobalEnv } from "./env";
import { patchGateway, patchGatewayEarly } from "./gateway";
import { patchLabels } from "./labels";
import { patchLogin } from "./login";
import { patchNetwork } from "./network";
import { patchReactions } from "./reactions";
import { patchRoles } from "./roles";
import ChangeEndpointSettings from "./settings";
import { loadConfig } from "./state";
import { patchVoice } from "./voice";

let unpatches: (() => unknown)[] = [];

export default definePlugin({
    name: "ChangeEndpoint",
    description: "Connect to Spacebar and other Discord-compatible servers",
    author: [{ name: "hazel", id: 0n }],
    id: "changeendpoint",
    version: "0.5.5",
    requiresRestart: true,
    async eagerStart() {
        // rain holds back Discord's startup until eager plugins finish, so the server is known before any request
        await loadConfig();
        installGlobalEnv();
        unpatches.push(guardWebSocket(), ...patchNetwork(), ...patchReactions(), ...patchGatewayEarly());
    },
    start() {
        for (const patch of [patchGateway, patchRoles, patchAccounts, patchLogin, patchLabels, patchVoice]) {
            try {
                unpatches.push(...patch());
            } catch (e) {
                logger.error(`[ChangeEndpoint] ${patch.name} failed`, e);
            }
        }
    },
    stop() {
        for (const unpatch of unpatches) unpatch();
        unpatches = [];
    },
    settings() {
        return ChangeEndpointSettings();
    },
});
