import { BundleUpdaterManager } from "@api/native/modules";
import { NavigationNative } from "@metro/common";
import { Stack, TableRadioGroup, TableRadioRow, TableRow, TableRowGroup, TableSwitchRow, TextInput } from "@metro/common/components";
import React, { useEffect, useReducer } from "react";
import { Alert, ScrollView } from "react-native";

import { DISCORD, endpointsOf, type Server } from "./config";
import ServerEditor from "./editor";
import { currentInstance, save, serverName, servers, setBoostCount, setDisrespectPermissions, setInstance, state } from "./state";
import { openAccountSwitcher } from "./switcher";

const apiLabel = (server: Server) => endpointsOf(server)?.api.replace(/^\/\//, "");

export default function ChangeEndpointSettings() {
    const navigation = NavigationNative.useNavigation();
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    useEffect(() => navigation.addListener("focus", rerender), [navigation]);

    const current = currentInstance();
    const endpoints = state.endpoints;

    const choose = (id: string) => {
        if (id === current) return;
        Alert.alert("Switch server", `Discord will restart and connect to ${serverName(id)}.`, [
            { text: "Cancel", style: "cancel" },
            { text: "Restart", onPress: () => setInstance(id) && save().then(() => BundleUpdaterManager.reload()) },
        ]);
    };

    const edit = (server?: Server) =>
        navigation.push("RAIN_CUSTOM_PAGE", {
            title: server ? server.name : "Add server",
            render: () => <ServerEditor server={server} />,
        });

    return (
        <ScrollView>
            <Stack style={{ paddingVertical: 24, paddingHorizontal: 12 }} spacing={24}>
                <TableRadioGroup title="Server" value={current} onChange={choose}>
                    <TableRadioRow label="Discord" subLabel="discord.com/api" value={DISCORD} />
                    {servers().map(s => (
                        <TableRadioRow key={s.id} label={s.name} subLabel={apiLabel(s)} value={s.id} />
                    ))}
                </TableRadioGroup>
                <TableRowGroup title="Accounts">
                    <TableRow label="Switch account" subLabel="Opens Discord's account switcher, for when a server can't be reached and the app is stuck" arrow onPress={openAccountSwitcher} />
                </TableRowGroup>
                <TableRowGroup title="Custom servers">
                    {state.config.customs.map(s => (
                        <TableRow key={s.id} label={s.name} subLabel={s.host} arrow onPress={() => edit(s)} />
                    ))}
                    <TableRow label="Add server" arrow onPress={() => edit()} />
                </TableRowGroup>
                <TableRowGroup title="Behaviour">
                    <TableSwitchRow
                        label="Disrespect permissions"
                        subLabel="Ignore permissions that Spacebar servers don't enforce. For now this lets you send and forward stickers from other guilds without the Use External Stickers permission."
                        value={state.config.disrespectPermissions}
                        onValueChange={(value: boolean) => {
                            setDisrespectPermissions(value);
                            rerender();
                        }}
                    />
                </TableRowGroup>
                <TableRowGroup title="Boosts">
                    <Stack style={{ padding: 12 }} spacing={8}>
                        <TextInput
                            label="Boost count"
                            description="How many boosts every guild shows. The boost level follows from it like on Discord (2, 7 and 14 boosts), and 14 or more unlocks all boost perks. Restart to apply."
                            defaultValue={String(state.config.boostCount)}
                            keyboardType="number-pad"
                            onChange={(text: string) => {
                                if (/^\d+$/.test(text)) setBoostCount(Number(text));
                            }}
                        />
                    </Stack>
                </TableRowGroup>
                {endpoints && (
                    <TableRowGroup title="Endpoints">
                        <TableRow label="API" subLabel={endpoints.api} />
                        <TableRow label="Gateway" subLabel={endpoints.gateway} />
                        <TableRow label="CDN" subLabel={endpoints.cdnHost} />
                    </TableRowGroup>
                )}
            </Stack>
        </ScrollView>
    );
}
