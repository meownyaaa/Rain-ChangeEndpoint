import { logger } from "@lib/utils/logger";
import { definePlugin } from "@plugins";

import { patchAccounts } from "./accounts";
import { interceptBoosts, patchBoostsAndLimits } from "./boosts";
import { patchChannelIconEditor } from "./channelIconEditor";
import { collectChannelIcons, loadChannelIcons, patchChannelIcons } from "./channelIcons";
import { guardWebSocket, installGlobalEnv } from "./env";
import { patchGateway, patchGatewayEarly } from "./gateway";
import { patchLabels } from "./labels";
import { patchLogin } from "./login";
import { patchMessageMembers } from "./members";
import { patchNetwork } from "./network";
import { patchInvites, patchInvitesEarly } from "./invites";
import { patchPermissions } from "./permissions";
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
    version: "0.10.5",
    requiresRestart: true,
    async eagerStart() {
        // rain holds back Discord's startup until eager plugins finish, so the server is known before any request
        await loadConfig();
        await loadChannelIcons();
        installGlobalEnv();
        unpatches.push(guardWebSocket(), ...patchNetwork(), ...patchReactions(), ...patchGatewayEarly(), ...collectChannelIcons(), ...patchMessageMembers(), ...interceptBoosts(), ...patchInvitesEarly());
    },
    start() {
        for (const patch of [patchGateway, patchRoles, patchAccounts, patchLogin, patchLabels, patchVoice, patchChannelIcons, patchPermissions, patchBoostsAndLimits, patchChannelIconEditor, patchInvites]) {
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
