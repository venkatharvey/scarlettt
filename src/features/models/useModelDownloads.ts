import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useOllama, PullResponse } from "../../hooks/useOllama";
import { isOutdatedClientError } from "../../hooks/useOllamaRuntime";

export interface DownloadState {
    status: string;
    completed?: number;
    total?: number;
}

export interface DownloadFailure {
    model: string;
    message: string;
    /** The registry refused the client as too old — offer an update, not a retry. */
    outdatedClient: boolean;
}

/**
 * Owns in-flight model downloads for the whole models section, so the list and
 * the detail page show the same progress rather than each tracking its own.
 * Mount this once, at the level that renders both.
 */
export function useModelDownloads(onInstalled: () => void) {
    const { pullModel, cancelModelDownload } = useOllama();
    // Held in a ref so `start` doesn't need re-creating when the callback changes.
    const onInstalledRef = useRef(onInstalled);
    useEffect(() => { onInstalledRef.current = onInstalled; }, [onInstalled]);
    const [downloads, setDownloads] = useState<Record<string, DownloadState>>({});
    // Kept so a refused pull can explain itself instead of just vanishing.
    const [failure, setFailure] = useState<DownloadFailure | null>(null);
    // Ollama reports progress per layer, so `completed` drops back to zero as
    // each new blob starts. Holding the high-water mark stops the bar rewinding.
    const highWater = useRef<Record<string, { completed: number; total: number }>>({});

    useEffect(() => {
        const unlisten = listen<PullResponse & { model: string }>('ollama-pull-progress', (event) => {
            const { model, ...update } = event.payload;

            setDownloads(prev => {
                // Ignore stragglers for a download that already finished or was cancelled.
                if (!(model in prev)) return prev;

                if (update.completed != null && update.total != null) {
                    const seen = highWater.current[model] ?? { completed: 0, total: 0 };
                    if (update.completed > seen.completed) {
                        highWater.current[model] = { completed: update.completed, total: update.total };
                    }
                    const best = highWater.current[model] ?? seen;
                    return {
                        ...prev,
                        [model]: {
                            status: update.status,
                            completed: Math.max(update.completed, best.completed),
                            total: update.total || best.total,
                        },
                    };
                }
                // Status-only frames: "pulling manifest", "verifying sha256", …
                return { ...prev, [model]: { status: update.status } };
            });
        });
        return () => { unlisten.then(u => u()); };
    }, []);

    const clear = useCallback((model: string) => {
        delete highWater.current[model];
        setDownloads(prev => {
            const next = { ...prev };
            delete next[model];
            return next;
        });
    }, []);

    const start = useCallback(async (model: string) => {
        highWater.current[model] = { completed: 0, total: 0 };
        setFailure(null);
        setDownloads(prev => ({ ...prev, [model]: { status: "Starting…" } }));
        try {
            await pullModel(model);
            onInstalledRef.current();
        } catch (error) {
            // Cancelling rejects the pull; that's expected, not a failure to report.
            const message = String(error);
            if (!message.includes("Cancelled")) {
                console.error('Error downloading model:', error);
                setFailure({ model, message, outdatedClient: isOutdatedClientError(message) });
            }
        } finally {
            clear(model);
        }
    }, [pullModel, clear]);

    const cancel = useCallback(async (model: string) => {
        try {
            await cancelModelDownload(model);
        } catch (error) {
            console.error('Error cancelling download:', error);
        }
    }, [cancelModelDownload]);

    return { downloads, start, cancel, failure, dismissFailure: () => setFailure(null) };
}

/** "1.2GB / 2.0GB · 60%", or the bare status when Ollama hasn't sent byte counts. */
export function describeDownload(state: DownloadState, formatBytes: (b: number) => string): string {
    if (state.completed == null || !state.total) return state.status || "Starting…";
    const percent = Math.round((state.completed / state.total) * 100);
    return `${formatBytes(state.completed)} / ${formatBytes(state.total)} · ${percent}%`;
}

export function downloadPercent(state: DownloadState): number | null {
    if (state.completed == null || !state.total) return null;
    return Math.min(100, Math.round((state.completed / state.total) * 100));
}
