import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';

/** What Ollama has resident right now — see `LoadedModel` in ollama.rs. */
export interface LoadedModel {
    name: string;
    context_length?: number | null;
    size: number;
    size_vram: number;
    /** When Ollama will release it, per the keep-alive this app sent. */
    expires_at?: string | null;
}

/**
 * Fraction of the model running on CPU because it wouldn't fit in VRAM — 0 when
 * fully GPU-resident, `undefined` when placement can't be determined.
 *
 * A zero `size_vram` is genuinely ambiguous: it's what a build without GPU
 * support reports (the model really is all on CPU) and also what an older Ollama
 * that omits the field reports. Since the two can't be told apart, neither answer
 * can be asserted — and claiming "100% GPU" on a machine with no GPU would be the
 * exact kind of confident-but-wrong reading this whole panel exists to replace.
 */
/**
 * How long until Ollama releases this model, in whole minutes, or undefined when
 * that isn't a useful thing to say.
 *
 * `-1` keep-alive makes Ollama report a date in 2318, which as a countdown would
 * read as 154 million minutes — so anything beyond a day is treated as "held",
 * not as a number.
 */
export function releasesInMinutes(loaded?: LoadedModel, now = Date.now()): number | undefined {
    if (!loaded?.expires_at) return undefined;
    const ms = new Date(loaded.expires_at).getTime() - now;
    if (!Number.isFinite(ms) || ms <= 0) return undefined;
    const minutes = Math.round(ms / 60_000);
    return minutes > 24 * 60 ? undefined : minutes;
}

export function offloadShare(model?: LoadedModel): number | undefined {
    if (!model?.size || !model.size_vram) return undefined;
    if (model.size_vram >= model.size) return 0;
    return (model.size - model.size_vram) / model.size;
}

/**
 * The loaded model matching `name`, refreshed on a timer.
 *
 * Polling rather than event-driven because the interesting transitions aren't
 * ours to observe: Ollama loads on the first message of a chat and unloads itself
 * after five idle minutes. It's a localhost call against an already-running
 * process, so the cost is negligible.
 */
export function useLoadedModel(name?: string, intervalMs = 4000) {
    const [loaded, setLoaded] = useState<LoadedModel | null>(null);

    const refresh = useCallback(async () => {
        try {
            const models = await invoke<LoadedModel[]>('list_loaded_models');
            // Fall back to whatever is resident: the caller's `name` is the model
            // selected in the UI, which isn't necessarily the one still in memory
            // from an earlier chat — and that one is what's occupying the GPU.
            setLoaded(models.find(m => m.name === name) ?? models[0] ?? null);
        } catch (error) {
            console.error('Error listing loaded models:', error);
            setLoaded(null);
        }
    }, [name]);

    useEffect(() => {
        refresh();
        const timer = window.setInterval(refresh, intervalMs);
        return () => window.clearInterval(timer);
    }, [refresh, intervalMs]);

    return { loaded, refresh };
}
