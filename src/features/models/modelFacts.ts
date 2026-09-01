// Facts about models and hardware that no API will tell us, plus the estimates
// derived from them. Everything here is approximate by nature — the UI labels it
// as an estimate rather than presenting it as measured.

// The memory ceiling Auto targets is computed by `memoryCeilingBytes` and passed
// in, so the fit badge and Auto read the same limit and can't drift apart.

/**
 * Peak memory bandwidth in GB/s. Local inference reads every weight once per
 * token, so bandwidth — not core count — sets the ceiling on generation speed.
 */
const APPLE_SILICON_BANDWIDTH: Array<[RegExp, number]> = [
    [/M1 Ultra/i, 800], [/M1 Max/i, 400], [/M1 Pro/i, 200], [/M1/i, 68],
    [/M2 Ultra/i, 800], [/M2 Max/i, 400], [/M2 Pro/i, 200], [/M2/i, 100],
    [/M3 Ultra/i, 800], [/M3 Max/i, 300], [/M3 Pro/i, 150], [/M3/i, 100],
    [/M4 Max/i, 546], [/M4 Pro/i, 273], [/M4/i, 120],
];

/** Real throughput lands well under theoretical peak. */
const BANDWIDTH_EFFICIENCY = 0.75;

export function memoryBandwidth(cpuBrand?: string): number | undefined {
    if (!cpuBrand) return undefined;
    return APPLE_SILICON_BANDWIDTH.find(([pattern]) => pattern.test(cpuBrand))?.[1];
}

/**
 * Rough tokens/sec: each generated token requires streaming the whole model
 * through memory once, so speed ≈ bandwidth / model size.
 */
export function estimateTokensPerSecond(sizeBytes?: number, cpuBrand?: string): number | undefined {
    const bandwidth = memoryBandwidth(cpuBrand);
    if (!bandwidth || !sizeBytes) return undefined;
    const sizeGB = sizeBytes / 1024 ** 3;
    return (bandwidth * BANDWIDTH_EFFICIENCY) / sizeGB;
}

export function describeSpeed(tokensPerSecond?: number): string | undefined {
    if (!tokensPerSecond) return undefined;
    if (tokensPerSecond >= 40) return "faster than you can read";
    if (tokensPerSecond >= 15) return "comfortable reading pace";
    if (tokensPerSecond >= 7) return "usable, visibly typing";
    if (tokensPerSecond >= 3) return "slow but workable";
    return "painfully slow";
}

/** Ollama's default context unless a request overrides it. */
export const DEFAULT_CONTEXT = 4096;

/** Never resolve below this — a smaller window makes chat forget almost at once. */
const MIN_CONTEXT = 2048;

/**
 * The KV cache is not the only thing that grows with context — llama.cpp also
 * allocates compute and graph buffers per token. Measured with `ollama ps`
 * across two architectures:
 *
 *   llama3.2:1b   raw KV 32KB/token   measured ~102KB   overhead ~70KB
 *   qwen2.5:7b    raw KV 56KB/token   measured ~120KB   overhead ~65KB
 *
 * The overhead is near-constant per token rather than proportional to the cache,
 * so it's added, not multiplied. An earlier 3× multiplier was fitted to the 1B
 * alone and over-charged the 7B by ~40%, capping context well below what fits.
 */
const COMPUTE_BUFFER_BYTES_PER_TOKEN = 68 * 1024;

/** Per-token memory including those buffers, not just the KV cache. */
export function runtimeKvBytesPerToken(kvBytesPerToken?: number | null): number | undefined {
    return kvBytesPerToken ? kvBytesPerToken + COMPUTE_BUFFER_BYTES_PER_TOKEN : undefined;
}

/**
 * Per-token cost measured directly with `ollama ps`, keyed on the architecture
 * `/api/show` reports as `general.architecture`.
 *
 * These exist because the arithmetic can't be done for every model. A hybrid SSM
 * leaves `head_count_kv` null, so `runtimeKvBytesPerToken` returns nothing and the
 * size-based estimate takes over — and that estimate charged qwen3.5:9b 147KB per
 * token against a measured 33.5KB, a 4.5× over-count that pinned a 262k-capable
 * model at 32k. There is no formula to fix: SSM layers hold fixed state while
 * attention layers cost per token, and nothing in the API says which is which.
 *
 * Measured on an M1 Pro by loading at four context sizes and differencing the
 * reported allocation; the slope was linear from 32k to 123k.
 *
 * **Keys are normalised, because the architecture string is not stable.** The
 * same family reports `qwen35` for one tag and `qwen3_5` for another, so a
 * literal key silently matched nothing and this whole table sat dead: qwen3.5
 * fell through to the size estimate it exists to override, and a 4b was sized
 * at 88.8KB per token against a family measurement of 33.5KB.
 *
 * **These are per-architecture, but they were measured on one model each.** Cost
 * per token follows layer count and head dimensions, so a figure taken on a 9b
 * is an approximation for its 4b sibling — a safe one, since the smaller model
 * cannot cost more — and would *under*-charge a larger one. If a bigger member
 * of a listed family appears, measure it and key it by size rather than letting
 * it inherit this number.
 */
const MEASURED_BYTES_PER_TOKEN: Record<string, number> = {
    // ~34 KB/token at f16 (which validated the earlier 33.5), but the engine now
    // spawns with `OLLAMA_KV_CACHE_TYPE=q8_0` (see `start_ollama_process`), and the
    // 8-bit cache cuts the measured slope to ~19 KB/token — differenced from
    // `ollama ps` at 8k vs 32k. This value is COUPLED to that env var: if the
    // engine ever stops quantizing the KV cache, put this back to ~34, or Auto will
    // size a context the memory can't actually hold.
    qwen35: 19.5 * 1024,
};

/**
 * Architecture names as a lookup key: lowercased, with the separators Ollama is
 * inconsistent about removed. `qwen3_5`, `qwen35` and `Qwen3.5` all collapse to
 * `qwen35`. Only separators go — `qwen3` stays distinct from `qwen35`.
 */
function architectureKey(architecture: string): string {
    return architecture.toLowerCase().replace(/[._\-\s]/g, "");
}

/**
 * The manual picker's rungs — few enough to render as buttons a human clicks.
 *
 * Doubling all the way to 256k left the top of the range unusable in practice:
 * the jump from 64k to 128k is 64k wide, and on a 16GB machine the useful sizes
 * live inside that gap. The steps above 64k are therefore 32k apart, and every
 * value is a multiple of `AUTO_GRANULARITY` so the manual ladder and Auto agree
 * on what a clean context length looks like.
 */
export const CONTEXT_STEPS = [
    2048, 4096, 8192, 16384, 32768, 65536,
    98304,   // 96k
    131072,  // 128k
    163840,  // 160k
    196608,  // 192k
    262144,  // 256k
];

/**
 * Auto rounds down to this instead of using the ladder above. Powers of two were
 * never a llama.cpp requirement — 81,920, 98,304, 114,688 and 122,880 all load and
 * report back exactly what was asked. Quantising Auto to doublings just discarded
 * fit: on a 16GB M1 Pro the ladder jumps 65,536 → 131,072, and 131,072 is over the
 * GPU ceiling, so everything usable above 64k was unreachable.
 */
const AUTO_GRANULARITY = 8192;

export interface ContextInputs {
    /** Maximum the model was trained for. */
    modelMax?: number | null;
    /** Bytes of KV cache per token — from /api/show for installed models. */
    kvBytesPerToken?: number | null;
    /** `general.architecture`, for the measured table. */
    architecture?: string | null;
    weightsBytes?: number;
    /**
     * The smaller of the RAM budget and the GPU ceiling — `memoryCeilingBytes`.
     * Passing the RAM budget alone is what let Auto propose a context that loads
     * and then runs partly on the CPU.
     */
    memoryCeiling?: number;
    /**
     * `compressedCeilingBytes` — used *only* when `memoryCeiling` can't afford a
     * single granularity step, so a busy machine moderates the context instead of
     * collapsing it to the 2048 minimum. Omitting it just means no rescue.
     */
    memoryCeilingFallback?: number;
}

/**
 * Bytes per token of context, best source first: a figure measured on this
 * architecture, then the exact calculation from the model's own dimensions, then
 * an estimate from file size.
 */
export function contextBytesPerToken(
    { architecture, kvBytesPerToken, weightsBytes }: ContextInputs,
): number | undefined {
    const measured = architecture ? MEASURED_BYTES_PER_TOKEN[architectureKey(architecture)] : undefined;
    return measured ?? kvBytesPerToken ?? estimateKvBytesPerToken(weightsBytes);
}

/**
 * The context actually sent to Ollama, given the user's preference and what this
 * machine and model can bear.
 */
export function resolveContext(
    mode: "auto" | "manual",
    ceiling: number,
    inputs: ContextInputs,
): number {
    const { modelMax, weightsBytes, memoryCeiling, memoryCeilingFallback } = inputs;
    const max = modelMax || DEFAULT_CONTEXT;

    if (mode === "manual") {
        // Clamp the floor to the model's own max too: a model trained below
        // MIN_CONTEXT (tinyllama, 2048) would otherwise be sent a num_ctx above its
        // ceiling. The Auto branch already does this in its final line.
        return Math.min(Math.max(MIN_CONTEXT, Math.min(ceiling, max)), max);
    }

    // `== null`, not `!memoryCeiling`: a ceiling of exactly 0 is a real answer (the
    // user reserved all of RAM), not "unknown". Treating 0 as unknown returned
    // DEFAULT_CONTEXT here, so reserving *everything* produced 4096 — more context
    // than reserving slightly less, which is backwards. A real 0 now falls through
    // and lands on the MIN_CONTEXT floor below, which is monotonic.
    if (!weightsBytes || memoryCeiling == null) return Math.min(DEFAULT_CONTEXT, max);

    const perToken = contextBytesPerToken(inputs);
    if (!perToken) return Math.min(DEFAULT_CONTEXT, max);

    const affordableUnder = (limit: number): number => {
        const budget = limit - weightsBytes;
        if (budget <= 0) return 0;
        const affordable = Math.min(Math.floor(budget / perToken), max);
        // Round down to a clean multiple rather than snapping to the manual ladder —
        // that ladder's 65,536 → 131,072 gap is exactly where the usable sizes live.
        return Math.floor(affordable / AUTO_GRANULARITY) * AUTO_GRANULARITY;
    };

    // Spend the comfortable ceiling first. Every limit inside it is also a limit
    // inside `fitForRequired`, and this rounds *down*, so whatever comes back here
    // is a context the fit badge will call good.
    const comfortable = affordableUnder(memoryCeiling);

    // Only when that affords nothing at all — a machine so busy that free memory
    // barely covers the weights — is the compressed ceiling worth the trade. Using
    // it whenever it was merely larger is what made Auto's answer read "Tight fit"
    // on an ordinary working machine.
    //
    // The rescue is capped at a single step rather than spending that ceiling in
    // full, because the compressed ceiling doesn't move with free memory: spending
    // it whole made the curve run backwards, handing a machine with 4GB free a 40k
    // context while one with 4.5GB free — genuinely better off — got 8k. One step
    // is what "moderate the context rather than destroy it" is worth here.
    const rescue = memoryCeilingFallback
        ? Math.min(affordableUnder(memoryCeilingFallback), AUTO_GRANULARITY)
        : 0;
    const granular = comfortable >= AUTO_GRANULARITY ? comfortable : Math.max(comfortable, rescue);

    return Math.max(Math.min(MIN_CONTEXT, max), Math.min(granular, max));
}

/**
 * Publisher isn't in Ollama's API at all — `details.family` is the architecture,
 * not who released it. Official models are recognisable by name; anything else
 * falls back to its namespace.
 */
const PUBLISHERS: Array<[RegExp, string]> = [
    [/^llama|^codellama/i, "Meta"],
    [/^qwen/i, "Alibaba"],
    [/^gemma|^codegemma/i, "Google"],
    [/^phi/i, "Microsoft"],
    [/^mistral|^mixtral|^codestral/i, "Mistral AI"],
    [/^deepseek/i, "DeepSeek"],
    [/^command-r/i, "Cohere"],
    [/^granite/i, "IBM"],
    [/^nemotron/i, "NVIDIA"],
    [/^falcon/i, "TII"],
    [/^yi/i, "01.AI"],
    [/^starcoder/i, "BigCode"],
    [/^smollm/i, "Hugging Face"],
    [/^olmo/i, "Allen Institute"],
    [/^tinyllama/i, "TinyLlama project"],
    [/^dolphin/i, "Cognitive Computations"],
];

export function publisherFor(name: string): string {
    const hit = PUBLISHERS.find(([pattern]) => pattern.test(name));
    if (hit) return hit[1];
    // Namespaced community upload, e.g. "someone/their-model".
    if (name.includes('/')) return name.split('/')[0];
    return "Community";
}

/**
 * Context window and tool support for the curated catalog. `/api/show` only
 * answers for models already on disk, and these are exactly the ones a user is
 * deciding about *before* downloading — so they're recorded here and shown as
 * estimates until the real values are readable.
 */
export const CATALOG_FACTS: Record<string, { context: number; tools: boolean }> = {
    'llama3.2:1b': { context: 131072, tools: true },
    'llama3.2': { context: 131072, tools: true },
    'llama3.1': { context: 131072, tools: true },
    'qwen2.5:0.5b': { context: 32768, tools: true },
    'qwen2.5:3b': { context: 32768, tools: true },
    'qwen2.5:7b': { context: 32768, tools: true },
    'qwen2.5:14b': { context: 32768, tools: true },
    'gemma2:2b': { context: 8192, tools: false },
    'gemma2': { context: 8192, tools: false },
    'gemma2:27b': { context: 8192, tools: false },
    'phi3': { context: 4096, tools: false },
    'mistral': { context: 32768, tools: true },
    'deepseek-r1:1.5b': { context: 131072, tools: false },
    'deepseek-r1:8b': { context: 131072, tools: false },
    'codellama': { context: 16384, tools: false },
    'tinyllama': { context: 2048, tools: false },
    'llama3.1:70b': { context: 131072, tools: true },
};

/**
 * KV cache cost per token when we can't read the architecture. Scales with
 * parameter count; the constant is fitted to typical 4-8B models.
 */
export function estimateKvBytesPerToken(sizeBytes?: number): number | undefined {
    if (!sizeBytes) return undefined;
    const sizeGB = sizeBytes / 1024 ** 3;
    return Math.round(sizeGB * 24 * 1024);
}

/**
 * Strips the tag from a model reference: "dolphin3:latest" -> "dolphin3",
 * "qwen2.5:7b" -> "qwen2.5". The detail page works on the base model and lets
 * you pick the tag, so it must never be handed an already-tagged name.
 */
export function baseName(name: string): string {
    const colon = name.indexOf(':');
    return colon === -1 ? name : name.slice(0, colon);
}

/** "Mac" / "PC" / "Linux" — for labelling the hardware-fit sort. */
export function deviceNoun(os?: string): string {
    if (os === "macos") return "Mac";
    if (os === "windows") return "PC";
    // Everything else takes the generic noun. "Best for your Linux" was wrong —
    // Mac and PC are things you own, Linux is an operating system, and the
    // sentence needs a noun in that slot. The fallback also covers whatever
    // `std::env::consts::OS` reports next without reading as a bug.
    return "machine";
}

/**
 * Context lengths in the "k" everyone actually means — 1024, not 1000.
 *
 * Dividing by 1000 turned the clean powers of two the app works in into labels
 * that read as arbitrary: 32,768 became "33k" and 131,072 became "131k". The
 * whole field writes those as 32k and 128k, and Ollama's own model pages do too,
 * so a decimal "k" here is both uglier and out of step with the numbers a user
 * sees everywhere else.
 */
export function formatCount(n: number): string {
    if (n >= 1024) return `${Math.round(n / 1024)}k`;
    return String(n);
}

/**
 * Whether a listed model runs only on Ollama's cloud, with no weights to pull.
 *
 * These publish a single `:cloud` tag, and ollama.com prints "-" where the file
 * size would be, so they used to arrive here with no size at all and land on the
 * "Unknown" badge — which reads as "we couldn't measure it" when the truth is
 * that there is nothing to measure and nothing to run locally.
 *
 * The `cloud` capability chip alone is not the signal: gemma4 carries it for its
 * `:cloud` tag while still publishing local weights from `e2b` to `31b`. What
 * separates them is whether any downloadable parameter size is listed at all.
 */
export function isCloudOnly(model?: { capabilities?: string[]; parameter_sizes?: string[] } | null): boolean {
    if (!model?.capabilities?.includes("cloud")) return false;
    return !model.parameter_sizes?.length;
}

/** A single tag that resolves to the cloud — `cloud`, `31b-cloud`, `preview-cloud`. */
export function isCloudTag(tag: string): boolean {
    return tag === "cloud" || tag.endsWith("-cloud");
}
