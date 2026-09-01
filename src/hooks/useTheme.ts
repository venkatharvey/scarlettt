import { useEffect } from "react";
import { ThemePreference } from "./useSettings";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The concrete theme to paint right now, resolving `auto` against the OS. */
function resolve(pref: ThemePreference): "light" | "dark" {
    if (pref === "auto") {
        return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
    }
    return pref;
}

/**
 * Applies the theme preference to `<html data-theme>`, which every design token keys
 * off (see src/css/index.css). For `auto` it follows the OS live, so changing the
 * system appearance repaints the app without a reload.
 *
 * An inline script in index.html sets the same attribute *before* React mounts, from
 * the persisted setting, so there's no flash of the wrong theme on a cold start; this
 * hook then keeps it in step with the setting and, under `auto`, with the system.
 */
export function useTheme(pref: ThemePreference) {
    useEffect(() => {
        const apply = () => {
            document.documentElement.setAttribute("data-theme", resolve(pref));
        };
        apply();
        if (pref !== "auto") return;
        const mq = window.matchMedia(DARK_QUERY);
        mq.addEventListener("change", apply);
        return () => mq.removeEventListener("change", apply);
    }, [pref]);
}
