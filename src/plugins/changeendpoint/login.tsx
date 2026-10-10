import { deleteJsxCreate, onJsxCreate } from "@api/react/jsx";
import { findByProps, findByStoreName } from "@metro";
import { Button } from "@metro/common/components";
import React, { cloneElement, isValidElement, useEffect, useReducer } from "react";

import { DISCORD } from "./config";
import { tokenInstance } from "./network";
import { currentInstance, onInstanceChange, serverName, servers, setInstance } from "./state";
import { openAccountSwitcher } from "./switcher";

type AnyElement = React.ReactElement<{ children?: unknown }>;

const currentToken = (): string | null | undefined => findByStoreName("AuthenticationStore")?.getToken?.();

function pickServer() {
    findByProps("showSimpleActionSheet")?.showSimpleActionSheet({
        key: "ChangeEndpointServerPicker",
        header: { title: "Log in to" },
        options: [DISCORD, ...servers().map(s => s.id)].map(id => ({
            label: id === currentInstance() ? `${serverName(id)} (current)` : serverName(id),
            onPress: () => id !== currentInstance() && setInstance(id),
        })),
    });
}

function ServerButtons() {
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    useEffect(() => onInstanceChange(rerender), []);

    // leaving Add Account without logging in goes back to the signed in account's server
    useEffect(() => {
        const token = currentToken();
        const owner = tokenInstance(token);
        return () => {
            if (!token || currentToken() !== token || !owner || owner === currentInstance()) return;
            setInstance(owner);
        };
    }, []);

    return (
        <>
            <Button variant="secondary" size="md" text={`Server: ${serverName(currentInstance())}`} onPress={pickServer} />
            <Button variant="secondary" size="md" text="Switch account" onPress={openAccountSwitcher} />
        </>
    );
}

function addServerButtons(rendered: unknown) {
    if (!isValidElement(rendered)) return rendered;
    const root = rendered as AnyElement;
    const body = root.props.children;
    if (!isValidElement(body)) return rendered;

    const content = (body as AnyElement).props.children;
    return cloneElement(
        root,
        undefined,
        cloneElement(body as AnyElement, undefined, ...(Array.isArray(content) ? content : [content]), <ServerButtons key="change-endpoint-server" />),
    );
}

// one wrapper per component, a new type every render would remount the screen
const wrappers = new WeakMap<Function, React.FC<object>>();

export function patchLogin() {
    const wrap = (Login: any, ret: React.ReactElement) => {
        let Patched = wrappers.get(Login);
        if (!Patched) wrappers.set(Login, (Patched = props => addServerButtons(Login(props)) as React.ReactElement));
        return <Patched key={ret.key} {...(ret.props as object)} />;
    };
    onJsxCreate("Login", wrap);
    return [() => deleteJsxCreate("Login", wrap)];
}
