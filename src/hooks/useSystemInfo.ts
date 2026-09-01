import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';

export interface SystemInfo {
    total_memory: number;
    available_memory: number;
    cpu_cores: number;
    cpu_brand: string;
    arch: string;
    os: string;
    unified_memory: boolean;
    free_disk: number;
    /** Bytes the GPU will hold — see `gpu_working_set` in system.rs. */
    gpu_working_set?: number | null;
}

export interface InstalledModel {
    name: string;
    size: number;
    parameter_size?: string | null;
    quantization_level?: string | null;
    family?: string | null;
    /** Ollama's content hash — the identity `contextCache` keys against. */
    digest?: string | null;
    /** `/api/tags` capabilities — `["completion", …]` for a chat model, `["embedding"]`
     *  for one that can't chat. Lets the library hide non-chat models. Empty/absent is
     *  "unknown, not incapable" (older Ollama), so callers must be permissive. */
    capabilities?: string[];
}

/** From `/api/show` — only available once the model is on disk. */
export interface ModelDetails {
    capabilities: string[];
    family?: string | null;
    parameter_size?: string | null;
    quantization_level?: string | null;
    context_length?: number | null;
    kv_bytes_per_token?: number | null;
    license?: string | null;
}

/** The badge a model gets in the library — all of them memory verdicts. */
export type Fit = 'good' | 'tight' | 'cpu-offload' | 'too-large' | 'unknown';

/**
 * Weights sit in memory for the whole session, plus headroom for the KV cache
 * and context — roughly 20% on top for a typical context length.
 */
const RUNTIME_OVERHEAD = 1.2;

/**
 * Below this share of RAM the machine still has room to do anything else.
 * One of the four terms in `memoryCeilingBytes`, which is what Auto spends —
 * every term there is also a term in `fitForRequired`, so Auto cannot pick a
 * context that its own badge then calls a tight fit.
 */
export const COMFORTABLE_SHARE = 0.7;
/** Above this it will swap or fail outright. */
const MAX_SHARE = 0.85;

/**
 * Safety margin under the GPU's working set. The reported figure is what Metal
 * will hold when nothing else wants it — but the app's own window, the compositor
 * and any other GPU client are drawing from the same pool, so aiming at the limit
 * exactly means crossing it whenever the desktop is busy.
 */
const GPU_COMFORTABLE_SHARE = 0.85;

/**
 * The most this machine can hold *on the GPU*, or undefined when unknown.
 *
 * Separate from the RAM budget because they are different limits and the smaller
 * one wins. On a 16GB M1 Pro the RAM budget allows 11.2 GiB while the GPU tops
 * out near 9 GiB — a model between the two loads happily and then runs part of
 * itself on the CPU at a fifth of the speed.
 */
export function gpuCeilingBytes(system?: SystemInfo): number | undefined {
    if (!system?.gpu_working_set) return undefined;
    return system.gpu_working_set * GPU_COMFORTABLE_SHARE;
}

/**
 * Floor under the free-memory cap, as a share of total RAM — the *fallback*
 * ceiling only, never the everyday one. See `compressedCeilingBytes`.
 *
 * Free memory is a volatile instantaneous reading, and letting it set the ceiling
 * outright is its own bug: measured on a machine mid-build with a browser open,
 * `available` was 5 GiB, below this model's weights — the arithmetic produced a
 * negative context and Auto would have collapsed to the 2048 minimum. Much of
 * what macOS counts as used is cache it will hand back under pressure, so a low
 * reading is a reason to be careful, not to give up.
 */
const MIN_TOTAL_SHARE = 0.45;

/**
 * The binding limit: the lowest of the RAM budget, the GPU ceiling, and what's
 * actually free — the last of those floored so a momentarily busy machine
 * moderates the context rather than destroying it.
 *
 * `available_memory` is a snapshot from whenever `get_system_info` last ran, so
 * it's approximate by nature — but approximately right beats precisely wrong,
 * which is what budgeting against total memory alone turned out to be.
 */
export type CeilingSource = "ram" | "gpu" | "free" | "reserve";

/**
 * The ceiling plus which limit produced it.
 *
 * Exists so the UI can explain a setting that appears to do nothing. On a busy
 * 16GB machine the free-memory cap is lower than any usable reserve, so changing
 * the reserve leaves the context identical — correct, but baffling without being
 * told that something else is already the tighter constraint.
 */
/**
 * The four limits, each with the name of what imposed it.
 *
 * `freeFloorShare` is the only difference between the everyday ceiling and the
 * fallback one: at 0 the free-memory term is taken raw, which is exactly the
 * threshold `fitForRequired` uses to separate "Runs well" from "Tight fit".
 */
function ceilingLimits(
    system: SystemInfo,
    reservedGb?: number,
    freeFloorShare = 0,
): Array<{ source: CeilingSource; value: number }> {
    const limits: Array<{ source: CeilingSource; value: number }> = [
        { source: "ram", value: system.total_memory * COMFORTABLE_SHARE },
    ];

    // The user's own floor. Applied against *total* rather than free memory so the
    // answer doesn't move while they read it — the free-memory cap below already
    // handles a machine that's busy right now.
    if (reservedGb && reservedGb > 0) {
        limits.push({ source: "reserve", value: system.total_memory - reservedGb * 1024 ** 3 });
    }

    const gpu = gpuCeilingBytes(system);
    if (gpu) limits.push({ source: "gpu", value: gpu });

    if (system.available_memory) {
        limits.push({
            source: "free",
            value: Math.max(system.available_memory, system.total_memory * freeFloorShare),
        });
    }
    return limits;
}

export function memoryCeilingBreakdown(system?: SystemInfo, reservedGb?: number):
    { ceiling: number; source: CeilingSource } | undefined {
    if (!system?.total_memory) return undefined;
    const lowest = ceilingLimits(system, reservedGb).reduce((a, b) => (b.value < a.value ? b : a));
    return { ceiling: lowest.value, source: lowest.source };
}

/**
 * What Auto is allowed to spend — and, deliberately, nothing more than the fit
 * badge will call comfortable.
 *
 * The free-memory term is the raw reading, the same figure `fitForRequired`
 * tests against. The two used to disagree: this took 80% of free but never less
 * than `MIN_TOTAL_SHARE` of total, so on a machine with under 45% free the floor
 * lifted the budget *above* the badge's threshold and Auto reliably proposed a
 * context its own badge then called a tight fit — 40k at "Tight fit" where a
 * manual 16k read "Runs well". Two definitions of comfortable, one of them
 * invisible. There is now one, and it lives in `fitForRequired`.
 */
export function memoryCeilingBytes(system?: SystemInfo, reservedGb?: number): number | undefined {
    if (!system?.total_memory) return undefined;
    return Math.min(...ceilingLimits(system, reservedGb).map(l => l.value));
}

/**
 * The ceiling Auto retreats to when the comfortable one can't afford a usable
 * context at all — free memory floored at `MIN_TOTAL_SHARE` of total.
 *
 * This is knowingly banking on macOS handing back cache under pressure, so it is
 * the exception rather than the rule: reserved for the case where budgeting
 * against free memory alone would collapse a 262k-capable model to 2048. A
 * context sized from this ceiling can legitimately badge as a tight fit — that
 * is the honest reading of the trade, not a bug.
 */
export function compressedCeilingBytes(system?: SystemInfo, reservedGb?: number): number | undefined {
    if (!system?.total_memory) return undefined;
    return Math.min(...ceilingLimits(system, reservedGb, MIN_TOTAL_SHARE).map(l => l.value));
}

/**
 * Adds a resident model's own bytes back into free memory, for sizing *that same
 * model*.
 *
 * `available_memory` already has the resident model subtracted out — macOS counts
 * its Metal allocation as used, so a model holding 7.3GB drops the free reading by
 * 7.3GB. Sizing that model's *next* context against the suppressed figure charges
 * it for memory it is about to release: reloading at a new context frees the old
 * allocation before placing the new one. So the memory actually available to it is
 * `available + its_own_residency`, which equals `total − held_by_everything_else`
 * and is therefore *invariant* to the model's own context. Without this, a larger
 * resident context lowers free memory, which lowers the next Auto size — a feedback
 * loop whose pathological fixed point is 8k while gigabytes are genuinely
 * reclaimable. Measured: qwen3.5:4b resident at 7.3GB on 16GB read 2.5GB free and
 * Auto collapsed to 8k; adding the 7.3GB back lifts it to the model's full window.
 *
 * The caller must gate `loadedBytes` on identity — pass it only when the loaded
 * model *is* the one being sized (`loaded.name === model`) — because a *different*
 * resident model's bytes are not freed by this reload, and crediting them would
 * over-size against memory something else holds. `useLoadedModel` falls back to any
 * resident model, so the guard is load-bearing, not defensive.
 *
 * Returns the system unchanged when there's nothing resident to credit, or when
 * `available_memory` is 0 — that 0 means *unknown* (the saturating-subtraction
 * case), and fabricating a positive figure from it would defeat every consumer
 * that deliberately treats 0 as "size from RAM and GPU instead".
 */
export function withReloadableMemory(system?: SystemInfo, loadedBytes?: number): SystemInfo | undefined {
    if (!system) return system;
    if (!loadedBytes || !system.available_memory) return system;
    return { ...system, available_memory: system.available_memory + loadedBytes };
}

/**
 * Fit for a memory figure that already accounts for everything — use this when
 * the KV cache has been computed from the real architecture, so the estimated
 * overhead below isn't applied on top of it.
 */
export function fitForRequired(requiredBytes: number | undefined, system?: SystemInfo): Fit {
    if (!requiredBytes || !system?.total_memory) return 'unknown';

    // Checked before the RAM bands: something can sit comfortably inside memory
    // and still be more than the GPU will take, which is neither "good" nor
    // "too large" — it runs, just with part of it on the CPU.
    const gpuCeiling = gpuCeilingBytes(system);
    if (gpuCeiling && requiredBytes > gpuCeiling) {
        return requiredBytes <= system.total_memory * MAX_SHARE ? 'cpu-offload' : 'too-large';
    }

    // Never "good" when it doesn't fit in memory that's actually free. It still
    // loads — macOS reclaims cache and compresses to make room — but that is the
    // mechanism behind a cold load taking minutes instead of seconds, so calling it
    // comfortable is the same total-vs-free mistake in badge form.
    const exceedsFree = !!system.available_memory && requiredBytes > system.available_memory;

    if (requiredBytes <= system.total_memory * COMFORTABLE_SHARE) {
        return exceedsFree ? 'tight' : 'good';
    }
    if (requiredBytes <= system.total_memory * MAX_SHARE) return 'tight';
    return 'too-large';
}

/** Fit when all we know is the download size — applies the cache estimate. */
export function estimateFit(sizeBytes: number | undefined, system?: SystemInfo): Fit {
    if (!sizeBytes) return 'unknown';
    return fitForRequired(sizeBytes * RUNTIME_OVERHEAD, system);
}

export function formatBytes(bytes: number): string {
    if (!bytes) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, i);
    return `${value >= 10 || i < 2 ? value.toFixed(0) : value.toFixed(1)}${units[i]}`;
}

/** Turns the "4.7GB" strings scraped off ollama.com into bytes. */
export function parseSizeString(size?: string | null): number | undefined {
    if (!size) return undefined;
    const match = /([\d.]+)\s*(TB|GB|MB|KB|B)/i.exec(size);
    if (!match) return undefined;
    const scale: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
    return parseFloat(match[1]) * scale[match[2].toUpperCase()];
}

export function useSystemInfo() {
    const [systemInfo, setSystemInfo] = useState<SystemInfo>();

    useEffect(() => {
        invoke<SystemInfo>('get_system_info')
            .then(setSystemInfo)
            .catch(error => console.error('Error getting system info:', error));
    }, []);

    /**
     * Keeps the free-memory figure current, so Auto widens the context when you
     * close something and narrows it when the machine gets busy.
     *
     * Read once at startup, it was a snapshot that never moved — Auto stayed on
     * whatever the machine happened to look like when the app opened. Only memory
     * is refreshed here; the rest of `SystemInfo` is fixed hardware.
     *
     * `MEMORY_HYSTERESIS` exists because the resolved context changes at every
     * 8192 tokens, which is only ~274MB of cache. Without a threshold, ordinary
     * churn would keep nudging the context across a step, and every change reloads
     * the model on the next message. A real change — quitting a browser — moves
     * gigabytes and clears this easily.
     */
    useEffect(() => {
        const MEMORY_HYSTERESIS = 512 * 1024 ** 2;
        const timer = window.setInterval(async () => {
            try {
                const available = await invoke<number>('get_available_memory');
                setSystemInfo(prev => {
                    if (!prev) return prev;
                    if (Math.abs(available - prev.available_memory) < MEMORY_HYSTERESIS) return prev;
                    return { ...prev, available_memory: available };
                });
            } catch (error) {
                console.error('Error refreshing available memory:', error);
            }
        }, 10_000);
        return () => window.clearInterval(timer);
    }, []);

    const listInstalledModels = useCallback(async (): Promise<InstalledModel[]> => {
        try {
            return await invoke<InstalledModel[]>('list_installed_models');
        } catch (error) {
            console.error('Error listing installed models:', error);
            return [];
        }
    }, []);

    const getModelDetails = useCallback(async (model: string): Promise<ModelDetails | null> => {
        try {
            return await invoke<ModelDetails | null>('get_model_details', { model });
        } catch (error) {
            console.error('Error getting model details:', error);
            return null;
        }
    }, []);

    return { systemInfo, listInstalledModels, getModelDetails };
}
