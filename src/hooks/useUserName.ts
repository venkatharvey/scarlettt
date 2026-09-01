import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

const STORAGE_KEY = "scarlettt_user_name";

/**
 * The OS account's first name, for the home-screen greeting.
 *
 * Cached in `localStorage` so it's available synchronously on the first render.
 * Without that the hero line would mount name-less and gain the name a frame
 * later — a visible twitch on the very screen the app opens to. The backend is
 * still asked on every launch, so a renamed account catches up.
 *
 * `undefined` means "not known yet or not available"; callers must read fine
 * without it.
 */
export function useUserName(): string | undefined {
    const [name, setName] = useState<string | undefined>(() => {
        try {
            return localStorage.getItem(STORAGE_KEY) ?? undefined;
        } catch {
            return undefined;
        }
    });

    useEffect(() => {
        invoke<string | null>("get_user_name")
            .then(resolved => {
                if (!resolved) return;
                setName(resolved);
                try {
                    localStorage.setItem(STORAGE_KEY, resolved);
                } catch {
                    // Cache is an optimisation; the name still renders this run.
                }
            })
            .catch(error => console.error("Error getting user name:", error));
    }, []);

    return name;
}
