import { instead } from "@api/patcher";
import { deleteJsxCreate, onJsxCreate } from "@api/react/jsx";
import { showToast } from "@api/ui/toasts";
import { findByFilePath, findByProps, findByStoreName } from "@metro";
import { Button, Stack, TableRowGroup, Text } from "@metro/common/components";
import React, { useState } from "react";

import { channelIconUrl, getChannelIcon, setChannelIcon } from "./channelIcons";
import { state } from "./state";

type Channel = { id: string; name?: string };

// IconUploader hands over either a data uri or an image object, the api wants a data uri
function toDataUri(image: any): string | null {
    if (typeof image === "string") return image.startsWith("data:") ? image : null;
    const base64 = image?.base64 ?? image?.data;
    const mime = image?.mime ?? image?.type ?? "image/png";
    if (typeof base64 === "string") return base64.startsWith("data:") ? base64 : `data:${mime};base64,${base64}`;
    return null;
}

function ChannelIconSection({ channel }: { channel: Channel }) {
    const IconUploader = findByFilePath("components_native/common/IconUploader.tsx")?.default;
    const [icon, setIcon] = useState(getChannelIcon(channel.id) ?? null);
    const [busy, setBusy] = useState(false);

    const save = async (value: string | null) => {
        setBusy(true);
        try {
            const { body } = await findByProps("get", "post", "put", "patch", "del", "V8APIError").patch({ url: `/channels/${channel.id}`, body: { icon: value } });
            const next = body?.icon ?? null;
            setChannelIcon(channel.id, next);
            setIcon(next);
            showToast(value ? "Channel icon updated" : "Channel icon removed");
        } catch (e) {
            console.warn("[ChangeEndpoint] channel icon update failed", e);
            showToast("Couldn't update the channel icon");
        } finally {
            setBusy(false);
        }
    };

    const onUpload = (image: unknown) => {
        console.log("[ChangeEndpoint] channel icon upload", typeof image, image && typeof image === "object" ? Object.keys(image) : String(image).slice(0, 40));
        const uri = toDataUri(image);
        if (!uri) return showToast("Couldn't read that image");
        save(uri);
    };

    return (
        <TableRowGroup title="Channel Icon">
            <Stack style={{ padding: 12 }} spacing={12}>
                {IconUploader && (
                    <IconUploader type="guild" icon={icon} name={channel.name ?? ""} makeURL={(hash: string) => channelIconUrl(channel.id, hash)} onUpload={onUpload} disabled={busy} />
                )}
                {icon && <Button text="Remove icon" variant="destructive" size="sm" disabled={busy} onPress={() => save(null)} />}
                <Text variant="text-sm/normal" color="text-muted">Shown in the channel list in place of the default icon.</Text>
            </Stack>
        </TableRowGroup>
    );
}

export function patchChannelIconEditor() {
    const unpatches: (() => unknown)[] = [];
    // the class isn't exported, so it's patched the first time Discord creates it, before it renders
    const onCreate = (Overview: any, element: unknown) => {
        if (unpatches.length || !Overview?.prototype?.renderChannelInfo) return element;
        unpatches.push(
            instead("renderChannelInfo", Overview.prototype, function (this: any, args: any[], render: Function) {
                const rendered = render.apply(this, args);
                const channel: Channel | undefined = this.props?.channel ?? findByStoreName("ChannelSettingsStore")?.getChannel?.();
                if (!state.endpoints || !channel?.id || !this.props?.canManageChannels) return rendered;
                return [rendered, <ChannelIconSection key="change-endpoint-channel-icon" channel={channel} />];
            }),
        );
        return element;
    };
    onJsxCreate("ChannelSettingsOverview", onCreate);
    return [() => deleteJsxCreate("ChannelSettingsOverview", onCreate), () => unpatches.forEach(unpatch => unpatch())];
}
