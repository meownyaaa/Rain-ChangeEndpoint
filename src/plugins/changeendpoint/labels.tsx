import { deleteJsxCreate, onJsxCreate } from "@api/react/jsx";
import React, { cloneElement, isValidElement } from "react";

import { serverName, state } from "./state";

type AnyElement = React.ReactElement<{ children?: unknown }>;
type User = { id: string; username: string };

const serverOf = (userId: unknown) => (typeof userId === "string" ? state.config.accounts[userId] : undefined);

const textOf = (c: React.ReactNode) => (isValidElement(c) ? (c as AnyElement).props.children : undefined);

// landing page rows render the username and discriminator as sibling texts, label the last one
function appendToName(node: React.ReactNode, username: string, suffix: string): React.ReactNode {
    if (!isValidElement(node)) return node;
    const element = node as AnyElement;
    const children = element.props.children as React.ReactNode;
    if (Array.isArray(children)) {
        let last = -1;
        if (children.some(c => textOf(c) === username))
            for (let i = 0; i < children.length; i++) if (typeof textOf(children[i]) === "string") last = i;
        const next = children.map((c: React.ReactNode, i: number) => {
            if (i === last) return cloneElement(c as AnyElement, undefined, `${textOf(c)}${suffix}`);
            return last === -1 ? appendToName(c, username, suffix) : c;
        });
        return cloneElement(element, undefined, ...next);
    }
    if (children === username) return cloneElement(element, undefined, `${username}${suffix}`);
    return isValidElement(children) ? cloneElement(element, undefined, appendToName(children, username, suffix)) : element;
}

const rowWrappers = new WeakMap<Function, React.FC<{ user: User }>>();

export function patchLabels() {
    // quick switcher in the You sheet: value is the user id
    const radioRow = (_: unknown, ret: React.ReactElement<{ value?: unknown; subLabel?: unknown }>) => {
        const server = serverOf(ret.props.value);
        if (!server) return ret;
        const name = serverName(server);
        const subLabel = typeof ret.props.subLabel === "string" && ret.props.subLabel ? `${name} · ${ret.props.subLabel}` : name;
        return cloneElement(ret, { subLabel });
    };

    const listItem = (Row: any, ret: React.ReactElement<{ user: User }>) => {
        let Patched = rowWrappers.get(Row);
        if (!Patched) {
            Patched = props => {
                const rendered = Row(props) as React.ReactNode;
                const server = serverOf(props.user?.id);
                return (server ? appendToName(rendered, props.user.username, ` · ${serverName(server)}`) : rendered) as React.ReactElement;
            };
            rowWrappers.set(Row, Patched);
        }
        return <Patched key={ret.key} {...ret.props} />;
    };

    onJsxCreate("TableRadioRow", radioRow);
    onJsxCreate("AccountSwitcherListItem", listItem);
    return [() => deleteJsxCreate("TableRadioRow", radioRow), () => deleteJsxCreate("AccountSwitcherListItem", listItem)];
}
