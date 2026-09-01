import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "scarlettt_settings";

export type ContextMode = "auto" | "manual";

/** Light, dark, or follow the OS. `auto` resolves to the system setting at runtime. */
export type ThemePreference = "light" | "dark" | "auto";

export interface Settings {
    /**
     * "auto" picks the largest context that still leaves the machine comfortable;
     * "manual" applies contextCeiling, clamped to what each model supports.
     */
    contextMode: ContextMode;
    contextCeiling: number;
    /**
     * Blocks this app's outbound internet requests. Local Ollama traffic is
     * unaffected, so chat keeps working — only model browsing and downloading stop.
     */
    offlineMode: boolean;
    /**
     * Gigabytes deliberately left for everything else on the machine. Auto sizes
     * context under this, so it's the one control for "stop the model eating my
     * computer" — a question you cannot answer with a token count, since the same
     * count costs 3.5x more memory on one model than another.
     */
    reservedMemoryGb: number;
    /**
     * Seconds to keep the model in memory after a reply, or -1 for as long as the
     * app is open. Ollama's own default is five minutes; this is sent explicitly
     * on every request so that default never applies.
     */
    keepAliveSeconds: number;
    /**
     * Native notifications for things that finish while you're in another app.
     *
     * Shared by both modes — it is a statement about how you want to be interrupted,
     * not about where a model runs. Defaults on, because the case it exists for
     * (walking away from a long reply) is the common one, and it can only ever fire
     * when the window is unfocused. macOS still asks the first time one is raised.
     */
    pushNotifications: boolean;
    /**
     * Whether chat history is indexed for search-by-meaning. When on, a tiny local
     * embedding model (~45MB) is downloaded and every message is embedded, so search
     * finds conversations by what they're about rather than exact words. Off stops the
     * download, the indexing and the semantic layer — keyword search still works.
     *
     * Defaults on, matching the behaviour before it was a setting, so a returning
     * user's index keeps working; it is applied to the backend on launch exactly like
     * `offlineMode`. Nothing about it leaves the machine.
     */
    semanticSearch: boolean;
    /**
     * Light, dark, or follow the system. Defaults to `auto`, which tracks the OS
     * appearance live; the user can pin light or dark. Applied to `<html data-theme>`
     * by `useTheme`.
     */
    theme: ThemePreference;
}

export const DEFAULT_SETTINGS: Settings = {
    contextMode: "auto",
    contextCeiling: 8192,
    offlineMode: false,
    // Chosen so the shipped default matches the previous behaviour on a 16GB
    // machine: 16 - 4 sits just above the RAM budget, so it binds nothing until
    // the user raises it.
    reservedMemoryGb: 4,
    // Five minutes, matching what Ollama would have done — so enabling this
    // setting changed nobody's behaviour on upgrade. The value is now ours; it
    // only happens to agree.
    keepAliveSeconds: 300,
    pushNotifications: true,
    // On by default: the feature already shipped this way, so making it a setting
    // must not silently turn a returning user's search-by-meaning off.
    semanticSearch: true,
    // Follow the system by default; the user can pin light or dark.
    theme: "auto",
};

function read(): Settings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
    } catch {
        return DEFAULT_SETTINGS;
    }
}

/**
 * Settings live in localStorage alongside the other preferences (selected model,
 * sidebar width). The `storage` listener keeps separate windows in step.
 */
export function useSettings() {
    const [settings, setSettings] = useState<Settings>(() => read());

    useEffect(() => {
        const sync = (e: StorageEvent) => {
            if (e.key === STORAGE_KEY) setSettings(read());
        };
        window.addEventListener("storage", sync);
        // Same-window updates don't fire `storage`, so components share this one.
        const local = () => setSettings(read());
        window.addEventListener("scarlettt:settings-changed", local);
        return () => {
            window.removeEventListener("storage", sync);
            window.removeEventListener("scarlettt:settings-changed", local);
        };
    }, []);

    const update = useCallback((patch: Partial<Settings>) => {
        const next = { ...read(), ...patch };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        setSettings(next);
        window.dispatchEvent(new Event("scarlettt:settings-changed"));
    }, []);

    return { settings, update };
}
