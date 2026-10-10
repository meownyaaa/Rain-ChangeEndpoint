import { findByFilePath, findByProps } from "@metro";

export function openAccountSwitcher() {
    findByFilePath("modules/multi_account/native/openManageAccountsModal.tsx")?.default?.();
}

export const isAccountSwitcherOpen = () => {
    const nav = findByProps("getRootNavigationRef")?.getRootNavigationRef?.();
    return nav?.getCurrentRoute?.()?.name === "MANAGE_ACCOUNTS";
};
