import { NavigationNative } from "@metro/common";
import { Button, Stack, TableRowGroup, Text, TextInput } from "@metro/common/components";
import React, { useState } from "react";
import { Alert, ScrollView } from "react-native";

import { endpointsOf, type Server } from "./config";
import { discover } from "./discovery";
import { currentInstance, removeCustom, saveCustom } from "./state";

export default function ServerEditor({ server }: { server?: Server }) {
    const navigation = NavigationNative.useNavigation();
    const [name, setName] = useState(server?.name ?? "");
    const [host, setHost] = useState(server?.host ?? "");
    const [api, setApi] = useState(server?.api ?? "");
    const [gateway, setGateway] = useState(server?.gateway ?? "");
    const [cdn, setCdn] = useState(server?.cdn ?? "");
    const [status, setStatus] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const detect = async () => {
        setBusy(true);
        setStatus("Looking up the server...");
        try {
            const found = await discover(host);
            setHost(found.host);
            setApi(found.api);
            setGateway(found.gateway);
            setCdn(found.cdn);
            if (!name.trim() && found.name) setName(found.name);
            setStatus("Found the server's endpoints.");
        } catch (e) {
            setStatus(`${(e as Error).message}. Fill in the endpoints yourself.`);
        } finally {
            setBusy(false);
        }
    };

    const draft = (): Server => ({
        id: server?.id ?? `custom-${Date.now().toString(36)}`,
        name: name.trim() || host.trim(),
        host: host.trim(),
        api: api.trim(),
        gateway: gateway.trim(),
        cdn: cdn.trim(),
    });

    const save = async () => {
        const next = draft();
        if (!next.host || !endpointsOf(next)) return setStatus("Enter at least the server address.");
        await saveCustom(next);
        navigation.goBack();
    };

    const remove = () => {
        if (!server) return;
        if (server.id === currentInstance()) return setStatus("Switch to another server before deleting this one.");
        Alert.alert("Delete server", `Delete ${server.name}? Accounts linked to it stay saved but won't switch servers.`, [
            { text: "Cancel", style: "cancel" },
            { text: "Delete", style: "destructive", onPress: () => removeCustom(server.id).then(() => navigation.goBack()) },
        ]);
    };

    return (
        <ScrollView>
            <Stack style={{ paddingVertical: 24, paddingHorizontal: 12 }} spacing={16}>
                <TableRowGroup title="Server">
                    <Stack style={{ padding: 12 }} spacing={12}>
                        <TextInput label="Address" placeholder="example.com" value={host} onChange={setHost} autoCapitalize="none" autoCorrect={false} keyboardType="url" isClearable />
                        <Button text={busy ? "Looking up..." : "Detect endpoints"} variant="secondary" disabled={busy || !host.trim()} onPress={detect} />
                        <TextInput label="Name" placeholder={host || "My server"} value={name} onChange={setName} isClearable />
                    </Stack>
                </TableRowGroup>
                <TableRowGroup title="Endpoints">
                    <Stack style={{ padding: 12 }} spacing={12}>
                        <TextInput label="API" placeholder={host ? `https://api.${host}/api` : "https://api.example.com/api"} value={api} onChange={setApi} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
                        <TextInput label="Gateway" placeholder={host ? `wss://gateway.${host}` : "wss://gateway.example.com"} value={gateway} onChange={setGateway} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
                        <TextInput label="CDN" placeholder={host ? `https://cdn.${host}` : "https://cdn.example.com"} value={cdn} onChange={setCdn} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
                        <Text variant="text-sm/normal" color="text-muted">Empty fields use api., gateway. and cdn. in front of the address.</Text>
                    </Stack>
                </TableRowGroup>
                {status && <Text variant="text-sm/medium" color="text-default">{status}</Text>}
                <Button text="Save" onPress={save} disabled={busy} />
                {server && <Button text="Delete server" variant="destructive" onPress={remove} />}
            </Stack>
        </ScrollView>
    );
}
