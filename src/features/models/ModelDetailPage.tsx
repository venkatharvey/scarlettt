import { useEffect, useState } from "react";
import { useOllama, RemoteModelPage, ModelVariant } from "../../hooks/useOllama";
import {
    useSystemInfo, InstalledModel, ModelDetails, Fit,
    estimateFit, fitForRequired, formatBytes, parseSizeString, memoryCeilingBytes, compressedCeilingBytes,
    withReloadableMemory,
} from "../../hooks/useSystemInfo";
import { useLoadedModel } from "../../hooks/useLoadedModel";
import {
    contextBytesPerToken, describeSpeed, estimateTokensPerSecond,
    formatCount, isCloudTag, publisherFor, resolveContext, runtimeKvBytesPerToken,
} from "./modelFacts";
import { useSettings } from "../../hooks/useSettings";
import KeyboardArrowDown from "../../svg/KeyboardArrowDown";
import DownloadingRow from "./DownloadingRow";
import ReadmePanel from "./ReadmePanel";
import { DownloadState } from "./useModelDownloads";

const FIT_LABEL: Record<Fit, string> = {
    good: "Runs well", tight: "Tight fit", 'cpu-offload': "Spills to CPU",
    'too-large': "Too large", unknown: "Unknown",
};
const FIT_CLASS: Record<Fit, string> = {
    good: "bg-good-bg text-good-fg border-good-line",
    tight: "bg-warn-bg text-warn-fg border-warn-line",
    'cpu-offload': "bg-bad-bg text-bad-fg border-bad-line",
    'too-large': "bg-bad-bg text-bad-fg border-bad-line",
    unknown: "bg-hover text-fg-secondary border-line",
};
const CONSEQUENCE: Record<Fit, string | null> = {
    good: null,
    tight: "This loads, but leaves little memory for anything else. Expect other apps to slow down, and a pause on the first message while the weights load.",
    'cpu-offload': "This fits in memory but exceeds what the GPU will hold, so llama.cpp runs the remainder on the CPU. Measured on an M1 Pro that dropped generation from 21 to 4 tokens per second — lower the context length until it fits.",
    'too-large': "This needs more memory than the machine has. macOS will page to SSD, which typically drops generation from tens of tokens per second to under one, and writes heavily to the disk the whole time. Ollama may also refuse to load it outright.",
    unknown: null,
};

/** Colour-coded like the source listing, so tool support is scannable. */
// Decorative, colour-coded chips (not the status palette). Each keeps a `dark:`
// variant — a translucent fill + a lifted text tone — since these hues have no token
// and their -50 light fills would be bright patches on a dark card.
const CAPABILITY_CLASS: Record<string, string> = {
    tools: "bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300",
    vision: "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
    thinking: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
    reasoning: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
    embedding: "bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
    completion: "bg-hover text-fg-secondary",
};

function Chip({ label }: { label: string }) {
    return (
        <span className={`px-2 py-[2px] rounded-md text-xs leading-4 ${CAPABILITY_CLASS[label] ?? "bg-hover text-fg-secondary"}`}>
            {label === "completion" ? "chat" : label}
        </span>
    );
}

function Fact({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
    return (
        <div className="flex flex-col gap-0.5" title={hint}>
            <span className="text-xs leading-4 text-fg-faint">{label}</span>
            <span className="text-xs leading-4 text-fg">{value}</span>
        </div>
    );
}

interface ModelDetailPageProps {
    /** Base model name, never tagged — the tag is chosen here. */
    name: string;
    installedModels: InstalledModel[];
    downloads: Record<string, DownloadState>;
    onStartDownload: (model: string) => void;
    onCancelDownload: (model: string) => void;
    currentModel?: string;
    onBack: () => void;
    onModelSelect?: (model: string) => void;
    onInstalledChange: () => void;
}

export default function ModelDetailPage({
    name, installedModels, downloads, onStartDownload, onCancelDownload,
    currentModel, onBack, onModelSelect, onInstalledChange,
}: ModelDetailPageProps) {
    const { getRemoteModelPage, deleteModel } = useOllama();
    const { systemInfo, getModelDetails } = useSystemInfo();
    const { settings } = useSettings();

    const [page, setPage] = useState<RemoteModelPage | null>(null);
    const [local, setLocal] = useState<ModelDetails | null>(null);
    const [loading, setLoading] = useState(true);
    const [selectedTag, setSelectedTag] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        setLoading(true);
        getRemoteModelPage(name).then(result => {
            setPage(result);
            setLoading(false);
        });
    }, [name]);

    // Cloud tags are dropped here too. A model like gemma4 publishes local weights
    // *and* a `:cloud` tag; the model belongs in the library, that tag doesn't —
    // offering it under "Download options" would offer a download that can't happen.
    const variants = (page?.variants ?? []).filter(v => !isCloudTag(v.tag));
    /**
     * An explicit choice first, then whichever tag is already on disk, then the
     * first row.
     *
     * `latest` used to come second, which meant arriving at a model you already had
     * pre-selected a tag you didn't — so the action button offered a download of a
     * different size instead of the "Currently in use" / "Remove" controls for the
     * copy sitting on the machine. Preferring the installed tag makes the page open
     * on what you actually have; list order decides only when you have none.
     */
    const variant: ModelVariant | undefined =
        variants.find(v => v.tag === selectedTag)
        ?? variants.find(v => installedModels.some(m => m.name === `${name}:${v.tag}`))
        ?? variants[0];

    const qualifiedName = variant ? `${name}:${variant.tag}` : name;
    // Whether *this tag* is on disk — switching variants switches the answer.
    const installed = installedModels.find(m => m.name === qualifiedName);

    // Re-read local details when the chosen tag changes — a different tag is a
    // different file with its own size, quantization and cache cost.
    useEffect(() => {
        setLocal(null);
        if (installed) getModelDetails(installed.name).then(setLocal);
    }, [installed?.name]);

    // If this exact tag is the loaded one, credit its resident bytes back into free
    // memory before sizing it — reloading at a new context frees the old allocation.
    // Same `withReloadableMemory` invariant Settings and Chat use; identity-guarded
    // because `useLoadedModel` falls back to any resident model.
    const { loaded } = useLoadedModel(qualifiedName);
    const heldForModel = loaded && installed && loaded.name === qualifiedName ? loaded.size : undefined;
    const sizingSystem = withReloadableMemory(systemInfo, heldForModel);

    // Prefer what Ollama measured locally; fall back to the listing.
    const sizeBytes = installed?.size ?? parseSizeString(variant?.size);
    const contextLength = local?.context_length ?? variant?.context_length;
    // Includes llama.cpp's per-token buffers, not just the KV cache.
    const contextInputs = {
        modelMax: contextLength,
        kvBytesPerToken: runtimeKvBytesPerToken(local?.kv_bytes_per_token),
        architecture: local?.family,
        weightsBytes: sizeBytes,
        memoryCeiling: memoryCeilingBytes(sizingSystem, settings.reservedMemoryGb),
        memoryCeilingFallback: compressedCeilingBytes(sizingSystem, settings.reservedMemoryGb),
    };
    const kvPerToken = contextBytesPerToken(contextInputs);

    // The context this model will actually run at, per the Settings preference.
    const effectiveContext = resolveContext(settings.contextMode, settings.contextCeiling, contextInputs);
    const cacheAtDefault = kvPerToken ? kvPerToken * effectiveContext : undefined;
    const cacheAtMax = kvPerToken && contextLength ? kvPerToken * contextLength : undefined;
    const ramAtDefault = sizeBytes && cacheAtDefault !== undefined ? sizeBytes + cacheAtDefault : sizeBytes;
    const ramAtMax = sizeBytes && cacheAtMax !== undefined ? sizeBytes + cacheAtMax : undefined;

    const fit = local?.kv_bytes_per_token
        ? fitForRequired(ramAtDefault, sizingSystem)
        : estimateFit(sizeBytes, systemInfo);
    /**
     * What's left *after* loading, measured against memory that's actually free —
     * not against total RAM.
     *
     * Subtracting from total quietly assumes an empty machine. It never is: with
     * ~10.5GB already held by macOS, a browser and the dev server, "leaves 8.8GB"
     * was promising more than the machine had, while the honest figure was that
     * the model wouldn't fit in free memory at all.
     */
    const headroom = sizingSystem?.available_memory && ramAtDefault
        ? sizingSystem.available_memory - ramAtDefault
        : undefined;
    const tps = estimateTokensPerSecond(sizeBytes, systemInfo?.cpu_brand);
    const speedWord = describeSpeed(tps);
    const fitsOnDisk = systemInfo && sizeBytes ? sizeBytes < systemInfo.free_disk : true;

    const capabilities = local?.capabilities.length
        ? local.capabilities
        : page?.capabilities.length
            ? ["completion", ...page.capabilities]
            : [];

    const isActive = currentModel === installed?.name;
    const downloading = downloads[qualifiedName];


    const handleDelete = async () => {
        if (!installed) return;
        setBusy(true);
        try {
            await deleteModel(installed.name);
            onInstalledChange();
            onBack();
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex-1 overflow-y-auto no-scrollbar" style={{ msOverflowStyle: 'none', scrollbarWidth: 'none' }}>
            <div className="max-w-[640px] mx-auto flex flex-col gap-6 px-4 py-8">
                <button
                    className="flex items-center gap-1 self-start text-xs leading-4 text-fg-secondary hover:text-fg transition-colors"
                    onClick={onBack}
                >
                    <span className="rotate-90 flex"><KeyboardArrowDown size={16} color="currentColor" /></span>
                    Models library
                </button>

                <div className="flex flex-col gap-2">
                    <div className="flex items-baseline gap-2">
                        <h1 className="text-xl leading-7 text-fg">{name}</h1>
                        <span className="text-xs leading-4 text-fg-muted">{publisherFor(name)}</span>
                    </div>
                    {page?.description && (
                        <p className="text-sm leading-[20px] text-fg-secondary">{page.description}</p>
                    )}

                    {/* Only what the provider actually returned — absent fields
                        simply don't render, so a future backend can fill them in. */}
                    <div className="flex flex-wrap items-center gap-3">
                        {page?.pulls && <span className="text-xs leading-4 text-fg-muted">{page.pulls} pulls</span>}
                        {page?.stars != null && <span className="text-xs leading-4 text-fg-muted">{page.stars} stars</span>}
                        {page?.tag_count != null && <span className="text-xs leading-4 text-fg-muted">{page.tag_count} tags</span>}
                        {page?.updated && <span className="text-xs leading-4 text-fg-muted">Updated {page.updated}</span>}
                        {page?.curated && <span className="px-2 py-[2px] rounded-md bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300 text-xs leading-4">Staff pick</span>}
                    </div>

                    {capabilities.length > 0 && (
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                            {capabilities.map(c => <Chip key={c} label={c} />)}
                        </div>
                    )}
                </div>

                {loading && <p className="text-sm leading-[18px] text-fg-faint">Loading model details…</p>}

                {/* Variant picker — the tags differ in size and fit, so this is
                    what actually decides the download. */}
                {variants.length > 0 && (
                    <div className="flex flex-col gap-2">
                        <p className="text-xs leading-4 text-fg-secondary">Download options</p>
                        <div className="flex flex-col">
                            {variants.map((v) => {
                                const vFit = estimateFit(parseSizeString(v.size), systemInfo);
                                const chosen = v.tag === variant?.tag;
                                return (
                                    <div
                                        key={v.tag}
                                        // The filled radio carries the selection; the row wash is
                                        // reserved for hover so the two states stay distinguishable.
                                        className="flex items-center gap-2 p-2 rounded cursor-pointer transition-colors hover:bg-hover/70"
                                        onClick={() => setSelectedTag(v.tag)}
                                    >
                                        <span className={`flex-shrink-0 w-3 h-3 rounded-full border ${chosen ? "border-fg border-4" : "border-line-strong"}`} />
                                        <span className="text-sm leading-[18px] text-fg truncate">
                                            {name}:{v.tag}
                                        </span>
                                        <span className={`flex-shrink-0 px-2 py-0.5 rounded-full border text-xs leading-4 ${FIT_CLASS[vFit]}`}>
                                            {FIT_LABEL[vFit]}
                                        </span>
                                        <span className="flex-1" />
                                        {v.quantization && <span className="text-xs leading-4 text-fg-muted">{v.quantization}</span>}
                                        {v.modality && <span className="text-xs leading-4 text-fg-muted">{v.modality}</span>}
                                        {v.context_length && (
                                            <span className="text-xs leading-4 text-fg-muted">{formatCount(v.context_length)}</span>
                                        )}
                                        <span className="text-xs leading-4 text-fg-muted">{v.size ?? "—"}</span>
                                        {/* Freed by moving the badge — says which tags you already have,
                                            so you don't re-download one. Fixed width keeps the size
                                            column aligned on rows without a chip. */}
                                        <span className="flex-shrink-0 w-16 flex justify-end">
                                            {installedModels.some(m => m.name === `${name}:${v.tag}`) && (
                                                <span className="px-2 py-[2px] rounded-md bg-hover/70 text-xs leading-4 text-fg-secondary">
                                                    Installed
                                                </span>
                                            )}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                <div className="grid grid-cols-3 gap-3">
                    <Fact label="Parameters" value={local?.parameter_size ?? page?.parameter_sizes.join(', ') ?? "—"} />
                    <Fact label="Architecture" value={local?.family ?? "—"} />
                    <Fact
                        label="Quantization"
                        value={local?.quantization_level ?? variant?.quantization ?? (installed ? "—" : "Q4_K_M (default)")}
                    />
                    {page?.format && <Fact label="Format" value={page.format} />}
                    {page?.domain && <Fact label="Domain" value={page.domain} />}
                    <Fact
                        label="Context window"
                        value={contextLength ? `${formatCount(contextLength)} tokens` : "—"}
                        hint="How much text the model can consider at once, prompt and reply together."
                    />
                    <Fact
                        label="Speed here"
                        value={tps ? <>~{tps.toFixed(0)} tok/s{speedWord && <span className="text-fg-muted"> · {speedWord}</span>}</> : "Unknown"}
                        hint={tps ? "Estimated from this machine's memory bandwidth." : "No bandwidth figure for this chip."}
                    />
                </div>

                <div className="flex flex-col gap-0.5">
                    <span className="text-xs leading-4 text-fg-faint">Memory</span>
                    <span className="text-xs leading-4 text-fg">
                        {ramAtDefault ? formatBytes(ramAtDefault) : "—"} at {formatCount(effectiveContext)} context
                        {sizeBytes && cacheAtDefault !== undefined && (
                            <span className="text-fg-muted"> ({formatBytes(sizeBytes)} weights + {formatBytes(cacheAtDefault)} cache)</span>
                        )}
                    </span>
                    {ramAtMax && contextLength && contextLength > effectiveContext && (
                        <span className="text-xs leading-4 text-fg-muted">
                            Rises to {formatBytes(ramAtMax)} at the full {formatCount(contextLength)} context — the cache grows with every token.
                        </span>
                    )}
                    {headroom !== undefined && (
                        <span className="text-xs leading-4 text-fg-muted">
                            {headroom > 0
                                ? `Leaves about ${formatBytes(headroom)} of the memory ${heldForModel ? "free once it reloads" : "that's currently free"}.`
                                : `Needs ${formatBytes(-headroom)} more than is free ${heldForModel ? "once it reloads" : "right now"} — macOS will compress memory to fit, which slows the first load.`}
                        </span>
                    )}
                    {CONSEQUENCE[fit] && (
                        <p className={`pt-1 text-xs leading-4 ${fit === 'too-large' ? "text-bad-fg" : "text-warn-fg"}`}>
                            {CONSEQUENCE[fit]}
                        </p>
                    )}
                    {!fitsOnDisk && (
                        <p className="pt-1 text-xs leading-4 text-bad-fg">
                            Not enough free disk — needs {formatBytes(sizeBytes!)}, only {formatBytes(systemInfo!.free_disk)} free.
                        </p>
                    )}
                </div>

                {/* A pull in flight replaces the action row entirely. */}
                {downloading ? (
                    <DownloadingRow
                        name={qualifiedName}
                        state={downloading}
                        onCancel={() => onCancelDownload(qualifiedName)}
                        compact
                    />
                ) : (
                <div className="flex items-center gap-2">
                    {installed ? (
                        <>
                            {!isActive && (
                                <button
                                    className="px-3 py-1.5 rounded-lg bg-inverse text-inverse-fg text-sm leading-[18px] hover:bg-inverse-hover transition-colors"
                                    onClick={() => onModelSelect?.(installed.name)}
                                >
                                    Use this model
                                </button>
                            )}
                            {/* Same shape as the primary button, greyed like the Installed
                                chip — it states a fact rather than offering an action. */}
                            {isActive && (
                                <span className="px-3 py-1.5 rounded-lg bg-hover/70 text-sm leading-[18px] text-fg-secondary">
                                    Currently in use
                                </span>
                            )}
                            <button
                                disabled={busy}
                                className="px-3 py-1.5 rounded-lg text-sm leading-[18px] text-bad-fg hover:bg-bad-bg transition-colors disabled:opacity-50"
                                onClick={handleDelete}
                            >
                                {busy ? "Removing…" : "Remove"}
                            </button>
                        </>
                    ) : (
                        <button
                            className="px-3 py-1.5 rounded-lg bg-inverse text-inverse-fg text-sm leading-[18px] hover:bg-inverse-hover transition-colors"
                            onClick={() => onStartDownload(qualifiedName)}
                        >
                            {`Download ${variant?.size ?? ""}`.trim()}
                        </button>
                    )}
                </div>
                )}

                {page?.readme && <ReadmePanel markdown={page.readme} />}
            </div>
        </div>
    );
}
