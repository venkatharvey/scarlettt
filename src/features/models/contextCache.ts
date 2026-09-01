import { InstalledModel, ModelDetails } from "../../hooks/useSystemInfo";
import { runtimeKvBytesPerToken } from "./modelFacts";

/**
 * The inputs `resolveContext` needs, cached per model so a context can be derived
 * **synchronously** at mount.
 *
 * Why this exists: the inputs live behind two awaits (`/api/tags` then
 * `/api/show`). They are fast — ~30ms measured — but "fast" is not "available",
 * and until they land the app has no context to send. That used to mean sending
 * none at all, which is Ollama's 4096 applied silently and then inherited by every
 * later request that reuses the loaded instance. A cached answer removes the
 * window entirely rather than shrinking it.
 *
 * The *inputs* are cached rather than the resolved number, because the number also
 * depends on live memory and the user's settings. Caching the answer would replay
 * a context derived from a machine state that no longer holds; caching the inputs
 * lets it be re-derived correctly on the spot.
 *
 * Keyed on Ollama's `digest`, not the name: a tag can be re-pulled to different
 * weights, and a stale architecture puts the per-token cost several-fold out. Same
 * reasoning as LM Studio invalidating its GGUF metadata cache on mtime + size, and
 * as `check_ollama_integrity` keying on size + mtime here.
 */
export interface CachedModelFacts {
    digest?: string | null;
    modelMax?: number;
    kvBytesPerToken?: number;
    architecture?: string;
    weightsBytes: number;
}

const STORAGE_KEY = "scarlettt_model_facts";

type Store = Record<string, CachedModelFacts>;

function read(): Store {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

/** Synchronous — this is the whole point. Returns undefined on a first-ever run. */
export function cachedFacts(model?: string): CachedModelFacts | undefined {
    if (!model) return undefined;
    return read()[model];
}

/**
 * Records what the async lookup found. A differing `digest` overwrites without
 * ceremony — the entry describes one set of weights, so a re-pull invalidates it.
 */
export function rememberFacts(model: string, entry: InstalledModel, details: ModelDetails | null): void {
    const facts: CachedModelFacts = {
        digest: entry.digest,
        modelMax: details?.context_length ?? undefined,
        kvBytesPerToken: runtimeKvBytesPerToken(details?.kv_bytes_per_token),
        architecture: details?.family ?? entry.family ?? undefined,
        weightsBytes: entry.size,
    };
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...read(), [model]: facts }));
    } catch {
        // A full or unavailable localStorage costs the fast path, not correctness —
        // the async resolve still runs.
    }
}
