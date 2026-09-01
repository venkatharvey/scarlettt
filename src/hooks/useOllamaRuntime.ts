import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Signature state of the app's own Ollama — reported, never enforced. */
export interface OllamaIntegrity {
    managed: boolean;
    /** null when the check couldn't run here, which is not the same as failing. */
    verified: boolean | null;
    detail?: string | null;
}

export interface OllamaRuntime {
    version?: string | null;
    path?: string | null;
    /** False for a system install — shown, but never replaced by this app. */
    managed_by_app: boolean;
    outdated: boolean;
    latest?: string | null;
}

/** Ollama's own message when the registry refuses a client that's too old. */
export function isOutdatedClientError(message: string): boolean {
    return /requires a newer version of ollama/i.test(message);
}

export function useOllamaRuntime() {
    const [runtime, setRuntime] = useState<OllamaRuntime | null>(null);
    const [integrity, setIntegrity] = useState<OllamaIntegrity | null>(null);
    const [latest, setLatest] = useState<string | null>(null);
    const [checking, setChecking] = useState(false);
    const [updating, setUpdating] = useState(false);
    // Tracked apart from `updating` so the check button doesn't claim to be
    // updating while what's actually running is a fresh install.
    const [installing, setInstalling] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            setRuntime(await invoke<OllamaRuntime>('get_ollama_runtime'));
        } catch (e) {
            console.error('Failed to read Ollama runtime:', e);
        }
        try {
            // Cached on size+mtime in Rust, so this is nearly free after the first call.
            setIntegrity(await invoke<OllamaIntegrity>('check_ollama_integrity'));
        } catch (e) {
            console.error('Failed to check Ollama integrity:', e);
        }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    /**
     * Backstop for the failure mode that started all this: work reporting success
     * while the runtime is actually gone.
     *
     * The commands now await their downloads and return real errors, so this
     * should never be the thing that catches a problem. It exists because it once
     * *was* possible to end an install with no Ollama and a cheerful UI, and a
     * status of Missing arriving mid-operation is unambiguous evidence of that
     * whatever the command claims.
     */
    const busyRef = useRef(false);
    busyRef.current = updating || installing;

    useEffect(() => {
        const stop = listen<unknown>('ollama-status-update', event => {
            if (busyRef.current && event.payload === 'Missing') {
                setError('Ollama is missing after that operation. Restart Scarlettt and try again.');
                refresh();
            }
        });
        return () => { stop.then(off => off()); };
    }, [refresh]);

    /** Deliberately manual — no version check runs unless asked, so startup
     *  makes no network request and offline mode stays honest. */
    const checkForUpdate = useCallback(async () => {
        setChecking(true);
        setError(null);
        try {
            setLatest(await invoke<string>('check_ollama_update'));
        } catch (e) {
            setError(String(e));
        } finally {
            setChecking(false);
        }
    }, []);

    /**
     * Downloads Ollama into the app's own data directory and switches to it. The
     * user's own install is left alone — it simply stops being what the app runs.
     */
    const installManaged = useCallback(async () => {
        setInstalling(true);
        setError(null);
        try {
            await invoke('install_managed_ollama');
            await refresh();
        } catch (e) {
            setError(String(e));
        } finally {
            setInstalling(false);
        }
    }, [refresh]);

    const update = useCallback(async () => {
        setUpdating(true);
        setError(null);
        try {
            await invoke('update_ollama');
            await refresh();
        } catch (e) {
            setError(String(e));
        } finally {
            setUpdating(false);
        }
    }, [refresh]);

    return { runtime, integrity, latest, checking, updating, installing, error, refresh, checkForUpdate, update, installManaged };
}
