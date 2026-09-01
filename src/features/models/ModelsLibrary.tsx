import { useEffect, useRef, useState } from "react";
import { NO_AUTOCORRECT } from "../../inputProps";
import { useOllama, RemoteModel, canChat } from "../../hooks/useOllama";
import {
    useSystemInfo, InstalledModel, Fit, SystemInfo,
    estimateFit, formatBytes, parseSizeString,
} from "../../hooks/useSystemInfo";
import ModelDetailPage from "./ModelDetailPage";
import DownloadingRow from "./DownloadingRow";
import { useModelDownloads } from "./useModelDownloads";
import { useOllamaRuntime } from "../../hooks/useOllamaRuntime";
import { baseName, publisherFor, deviceNoun, isCloudOnly } from "./modelFacts";
import { useSettings } from "../../hooks/useSettings";
import Newsstand from "../../svg/Newsstand";
import KeyboardArrowDown from "../../svg/KeyboardArrowDown";

type SortKey = "fit" | "popular" | "newest" | "alpha";

/** A search term → extra words to look for in a model's text (name, provider,
 *  capabilities, description). Bridges the near-misses: a capability searched by
 *  another word (reasoning → thinking) and a task "skill" searched by intent
 *  (coding → code/coder, writing → creative). Exact chip names and plain words
 *  already match by substring; this only adds what they'd miss. */
const SEARCH_ALIASES: Record<string, string[]> = {
    // a capability, searched by a different word than its chip
    reasoning: ["thinking"], reason: ["thinking"],
    function: ["tools"], functions: ["tools"], "function calling": ["tools"],
    image: ["vision"], images: ["vision"], multimodal: ["vision"], visual: ["vision"],
    voice: ["audio"], speech: ["audio"],
    // a task / skill, searched by intent (mostly found in name + description)
    coding: ["code", "coder"], programming: ["code", "coder"], developer: ["code", "coder"],
    writing: ["write", "creative", "story"], creative: ["writing", "story"],
    math: ["math"], maths: ["math"],
    embeddings: ["embedding", "embed"],
    chat: ["chat", "instruct"],
};

/** The dropdown applied on top of the text search. Mostly real capability-chip names,
 *  matched against `capabilities`. `writing` is the exception — there's no "writing"
 *  chip (models don't declare it), so it's a *task* filter matched against the model's
 *  name and description, the same intent the search alias uses. See `matchesCapability`. */
type CapabilityFilter = "all" | "tools" | "vision" | "thinking" | "audio" | "writing";
const CAPABILITY_FILTERS: [CapabilityFilter, string][] = [
    ["all", "All capabilities"],
    ["tools", "Tools"],
    ["vision", "Vision"],
    ["thinking", "Thinking"],
    ["audio", "Audio"],
    ["writing", "Writing"],
];

/** Words that mark a model as writing/creative-focused, for the `writing` filter.
 *  `writ` covers write/writing/writer/written; `creativ` covers creative/creativity.
 *  Chosen to avoid false positives: bare "story" would match "hi**story**", "novel"
 *  matches the ML cliché "novel approach", and "author" matches "authoritative" — so
 *  the safer stems `storytell`/`stories`/`fiction` stand in for them. */
const WRITING_TERMS = ["writ", "creativ", "storytell", "stories", "fiction", "prose", "poet", "roleplay"];

/** How well a fit verdict answers "can I run this?" — best first. */
const FIT_RANK: Record<Fit, number> = { good: 0, tight: 1, 'cpu-offload': 2, unknown: 3, 'too-large': 4 };

const FIT_LABEL: Record<Fit, string> = {
    good: "Runs well",
    tight: "Tight fit",
    'cpu-offload': "Spills to CPU",
    'too-large': "Too large",
    unknown: "Unknown",
};

const FIT_CLASS: Record<Fit, string> = {
    good: "bg-good-bg text-good-fg border-good-line",
    tight: "bg-warn-bg text-warn-fg border-warn-line",
    'cpu-offload': "bg-bad-bg text-bad-fg border-bad-line",
    'too-large': "bg-bad-bg text-bad-fg border-bad-line",
    unknown: "bg-hover text-fg-secondary border-line",
};

const FIT_HINT: Record<Fit, string> = {
    good: "Comfortably within this machine's memory.",
    tight: "Should load, but leaves little room for other apps.",
    'cpu-offload': "Fits in memory but not on the GPU — part of it would run on the CPU, several times slower.",
    'too-large': "Needs more memory than this machine has — expect swapping or a failure to load.",
    unknown: "Size unknown, so the fit can't be estimated.",
};

/**
 * How many size lookups run at once, and how many results are applied per render.
 *
 * The catalog is 235 models now, not 20, so firing every lookup at once is a
 * request storm and applying each result on its own is 235 re-renders of a
 * 235-row list. Both are bounded; rows fill in progressively either way.
 */
/**
 * Measured against the real registry, not guessed: 48 concurrent manifest GETs
 * complete in 1.78s with no 429 or 503 and no rate limiting observed, which puts
 * the full 235-model fill at ~9s against ~21s at 12. The registry is latency-bound
 * per request, so the concurrency is doing all the work here.
 *
 * Not raised further because there is no *published* limit — 48 is measured safe
 * rather than proven safe, and a burst that gets refused would leave rows unpriced.
 */
const SIZE_FETCH_CONCURRENCY = 48;
const SIZE_FLUSH_EVERY = 25;

/** Runs `work` over `items` with at most `limit` in flight. */
async function pooled<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (next < items.length) await work(items[next++]);
        }),
    );
}

/**
 * The badge for one listing row.
 *
 * `sizeBytes` is the registry's exact figure and wins when present; `model.size`
 * is the rounded string scraped off a model page, which is all the search path
 * still supplies.
 */
function fitForListing(model: RemoteModel | undefined, systemInfo?: SystemInfo, sizeBytes?: number): Fit {
    return estimateFit(sizeBytes ?? parseSizeString(model?.size), systemInfo);
}

function FitBadge({ fit }: { fit: Fit }) {
    return (
        <span
            title={FIT_HINT[fit]}
            className={`flex-shrink-0 px-2 py-0.5 rounded-full border text-xs leading-4 ${FIT_CLASS[fit]}`}
        >
            {FIT_LABEL[fit]}
        </span>
    );
}

/**
 * The only action on a list row. Downloading and switching models happen on the
 * detail page, so a multi-GB pull can't bypass the memory and speed figures.
 */
function DetailsButton() {
    return (
        <span className="flex-shrink-0 flex items-center gap-0.5 px-2 py-0.5 text-xs leading-4 text-fg-secondary">
            Details
            <span className="-rotate-90 flex"><KeyboardArrowDown size={14} color="currentColor" /></span>
        </span>
    );
}

function Meta({ children }: { children: React.ReactNode }) {
    return <span className="text-xs leading-4 text-fg-muted">{children}</span>;
}

interface ModelsLibraryProps {
    currentModel?: string;
    onModelSelect?: (model: string) => void;
    /** Open straight onto this model's page — used by the missing-model notice. */
    initialModel?: string;
    /**
     * Prime the search box instead. For a name the library doesn't carry, where a
     * detail page would render empty and search is the only useful landing.
     */
    initialQuery?: string;
}

export default function ModelsLibrary({ currentModel, onModelSelect, initialModel, initialQuery }: ModelsLibraryProps) {
    const { searchRemoteModels, getRemoteModelSize } = useOllama();
    const { systemInfo, listInstalledModels } = useSystemInfo();
    const { settings } = useSettings();

    const [installed, setInstalled] = useState<InstalledModel[]>([]);
    // Fetched live from ollama.com rather than hardcoded — an empty search query
    // returns the current popular listing, so the browse view never goes stale.
    const [catalog, setCatalog] = useState<Record<string, RemoteModel>>({});
    const [catalogOrder, setCatalogOrder] = useState<string[]>([]);
    const [sortBy, setSortBy] = useState<SortKey>("fit");
    const [capabilityFilter, setCapabilityFilter] = useState<CapabilityFilter>("all");
    // The fit sort needs sizes, which arrive per model after the listing. Sorting
    // as each one lands would shuffle the list under the cursor, so hold the
    // listing order until they're all in and reorder once.
    const [sizesReady, setSizesReady] = useState(false);
    /** Exact download sizes by model name, from the registry. */
    const [sizes, setSizes] = useState<Record<string, number>>({});
    // Read by the search effect to skip what the catalog already priced. A ref,
    // not the state itself, so that effect doesn't re-run on every size flush.
    const sizesRef = useRef(sizes);
    sizesRef.current = sizes;
    const [query, setQuery] = useState(initialQuery ?? "");
    const [remoteResults, setRemoteResults] = useState<RemoteModel[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    // Opening a model swaps this pane for its detail page rather than expanding
    // inline — the readme alone is far too tall to sit inside a list row.
    const [selected, setSelected] = useState<string | null>(initialModel ?? null);
    // Owned here rather than in the detail page so an in-flight pull stays
    // visible in the list after navigating back.
    const { downloads, start: startDownload, cancel: cancelDownload, failure, dismissFailure } =
        useModelDownloads(() => loadInstalled());
    const { runtime, updating, update: updateRuntime } = useOllamaRuntime();

    useEffect(() => {
        loadInstalled();
        if (settings.offlineMode) return;
        (async () => {
            setSizesReady(false);
            // "popular" is ollama.com's own default; the client-side sorts start
            // from it too, so it's the right listing to request for all of them.
            const order = sortBy === "newest" ? "newest" : "popular";
            // Cloud-only models are dropped rather than listed: nothing here can be
            // downloaded or run locally, which is the whole point of this library.
            // They cost list slots too — 8 of the 20 the listing returns were cloud
            // in one sample, and there is no pagination to make that back.
            const listing = (await searchRemoteModels("", order)).filter(m => !isCloudOnly(m));
            setCatalogOrder(listing.map(m => m.name));
            // The listing carries names, descriptions and capabilities but not
            // sizes. Those used to come from each model's own page — two requests
            // each, which was affordable at 20 models and is not at 235. The
            // registry manifest gives the exact byte count in one small request,
            // and the row only needs the size, so the page fetch stays on the
            // detail view where the rest of its fields are actually used.
            setCatalog(Object.fromEntries(listing.map(m => [m.name, m])));
            setSizes({});
            let batch: Record<string, number> = {};
            const flush = () => {
                if (!Object.keys(batch).length) return;
                const ready = batch;
                batch = {};
                setSizes(prev => ({ ...prev, ...ready }));
            };
            await pooled(listing, SIZE_FETCH_CONCURRENCY, async (m) => {
                const bytes = await getRemoteModelSize(m.name);
                if (bytes) batch[m.name] = bytes;
                if (Object.keys(batch).length >= SIZE_FLUSH_EVERY) flush();
            });
            flush();
            setSizesReady(true);
        })();
    }, [settings.offlineMode, sortBy]);

    const loadInstalled = async () => setInstalled(await listInstalledModels());

    // The curated catalog is only a starting point — searching also hits the full
    // Ollama library so users aren't boxed into these 17 names.
    useEffect(() => {
        if (query.trim().length < 2) {
            setRemoteResults([]);
            return;
        }
        const timer = setTimeout(async () => {
            setIsSearching(true);
            try {
                const found = (await searchRemoteModels(query.trim())).filter(m => !isCloudOnly(m));
                setRemoteResults(found);
                // Sizes for these come from the registry too. The listing used to
                // carry a scraped size for its first 8 rows and nothing for the
                // rest; this prices all of them, from the one source.
                await pooled(found, SIZE_FETCH_CONCURRENCY, async (m) => {
                    if (sizesRef.current[m.name] !== undefined) return;
                    const bytes = await getRemoteModelSize(m.name);
                    if (bytes) setSizes(prev => ({ ...prev, [m.name]: bytes }));
                });
            } finally {
                setIsSearching(false);
            }
        }, 400);
        return () => clearTimeout(timer);
    }, [query]);

    const installedNames = new Set(installed.map(m => m.name.replace(/:latest$/, '')));
    const q = query.trim().toLowerCase();
    // Search across a model's name, provider (Meta, Google, Qwen…), capabilities, and
    // description — so "gemma", "google", "vision", and "coding" all find the right
    // rows. The description carries the task "skills" (writing, coding, math);
    // SEARCH_ALIASES bridges the near-misses. Capabilities/description come from the
    // catalog entry — for an installed model, looked up by its base name.
    const matchesModel = (name: string, model?: RemoteModel): boolean => {
        if (!q) return true;
        const haystack = [name, publisherFor(name), ...(model?.capabilities ?? []), model?.description ?? ""]
            .join(" ").toLowerCase();
        if (haystack.includes(q)) return true;
        const aliases = SEARCH_ALIASES[q];
        return !!aliases && aliases.some(term => haystack.includes(term));
    };
    // A capability filter picked from the dropdown, applied on top of the text search.
    // `writing` is a task, not a chip: match it against the model's name + description
    // (which is where "creative writing", "storytelling", "-writer" live), since no
    // model reports a "writing" capability. Every other value is a real chip.
    const matchesCapability = (model?: RemoteModel, name?: string): boolean => {
        if (capabilityFilter === "all") return true;
        if (capabilityFilter === "writing") {
            const hay = [name ?? "", model?.name ?? "", model?.description ?? ""].join(" ").toLowerCase();
            return WRITING_TERMS.some(t => hay.includes(t));
        }
        return !!model?.capabilities?.includes(capabilityFilter);
    };

    // Non-chat models — the embedding model semantic search installs, above all —
    // are not things you converse with, so they don't belong in the chat-model
    // library. `canChat` is the same gate the picker uses, and it's permissive on an
    // empty capability list (unknown, not incapable), so nothing is hidden by mistake.
    const visibleInstalled = installed.filter(m =>
        canChat({ name: m.name, capabilities: m.capabilities ?? [] })
        && matchesModel(m.name, catalog[baseName(m.name)]) && matchesCapability(catalog[baseName(m.name)], m.name));
    const listed = catalogOrder.filter(name =>
        !installedNames.has(name.replace(/:latest$/, '')) && matchesModel(name, catalog[name]) && matchesCapability(catalog[name], name));
    // popular/newest are already ordered by the server, so only the two
    // client-side sorts reorder — and "fit" waits until it has the data.
    const available = (() => {
        if (sortBy === "alpha") return [...listed].sort((a, b) => a.localeCompare(b));
        if (sortBy === "fit" && sizesReady) {
            return [...listed].sort((a, b) => {
                const fa = fitForListing(catalog[a], systemInfo, sizes[a]);
                const fb = fitForListing(catalog[b], systemInfo, sizes[b]);
                if (FIT_RANK[fa] !== FIT_RANK[fb]) return FIT_RANK[fa] - FIT_RANK[fb];
                // Within the same verdict, the most capable model that still fits.
                return (sizes[b] ?? parseSizeString(catalog[b]?.size) ?? 0)
                    - (sizes[a] ?? parseSizeString(catalog[a]?.size) ?? 0);
            });
        }
        return listed;
    })();
    // Anything the listing and the installed set don't already cover.
    const extraResults = remoteResults.filter(
        m => !installedNames.has(m.name.replace(/:latest$/, '')) && !catalogOrder.includes(m.name)
            && matchesModel(m.name, m) && matchesCapability(m, m.name)
    );

    const totalMemory = systemInfo ? formatBytes(systemInfo.total_memory) : '—';

    if (selected) {
        return (
            <ModelDetailPage
                name={selected}
                installedModels={installed}
                downloads={downloads}
                onStartDownload={startDownload}
                onCancelDownload={cancelDownload}
                currentModel={currentModel}
                onBack={() => setSelected(null)}
                onModelSelect={onModelSelect}
                onInstalledChange={loadInstalled}
            />
        );
    }

    return (
        <div className="flex-1 overflow-y-auto no-scrollbar" style={{ msOverflowStyle: 'none', scrollbarWidth: 'none' }}>
            <div className="max-w-[640px] mx-auto flex flex-col gap-8 px-4 py-8">
                <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                        <Newsstand size={16} color="rgb(var(--fg))" />
                        <h1 className="text-sm leading-[18px] text-fg">Models library</h1>
                    </div>
                    {/* Grounds every badge below — the fit is relative to this machine. */}
                    <p className="text-xs leading-4 text-fg-muted">
                        {systemInfo
                            ? `${systemInfo.cpu_brand || systemInfo.arch} · ${systemInfo.cpu_cores} cores · ${totalMemory} ${systemInfo.unified_memory ? "unified memory" : "RAM"}`
                            : "Reading system information…"}
                    </p>
                    <p className="text-xs leading-4 text-fg-muted">
                        Fit is estimated from model size against your memory, so treat it as a guide rather than a guarantee — real
                        usage varies with context length and quantization.
                    </p>
                </div>

                <input
                    {...NO_AUTOCORRECT}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by name, provider, capability, or skill"
                    className="w-full px-3 py-2 text-sm leading-[18px] text-fg bg-card rounded-lg border border-line focus:outline-none focus:border-fg-faint transition-colors placeholder-fg-muted"
                />

                {/* A refused pull explains itself here rather than failing silently.
                    When the cause is a stale runtime, the fix is one click away. */}
                {failure && (
                    <div className={`flex flex-col gap-2 p-3 rounded-lg border ${failure.outdatedClient ? "bg-warn-bg border-warn-line" : "bg-bad-bg border-bad-line"}`}>
                        <p className={`text-xs leading-4 ${failure.outdatedClient ? "text-warn-fg" : "text-bad-fg"}`}>
                            {failure.outdatedClient
                                ? `${failure.model} needs a newer engine than the one installed${runtime?.version ? ` (${runtime.version})` : ""}.`
                                : `Couldn't download ${failure.model}.`}
                        </p>
                        {!failure.outdatedClient && (
                            <p className="text-xs leading-4 text-bad-fg break-words">{failure.message}</p>
                        )}
                        <div className="flex items-center gap-2">
                            {failure.outdatedClient && runtime?.managed_by_app && (
                                <button
                                    disabled={updating}
                                    className="px-3 py-1.5 rounded-lg bg-inverse text-inverse-fg text-sm leading-[18px] hover:bg-inverse-hover transition-colors disabled:opacity-50"
                                    onClick={async () => { await updateRuntime(); dismissFailure(); }}
                                >
                                    {updating ? "Updating engine…" : "Update engine"}
                                </button>
                            )}
                            {failure.outdatedClient && !runtime?.managed_by_app && (
                                <p className="text-xs leading-4 text-warn-fg">
                                    Ollama was installed outside Scarlettt, so update it the way you installed it.
                                </p>
                            )}
                            <button
                                className="px-2 py-0.5 rounded text-xs leading-4 text-fg-secondary hover:bg-hover/70 transition-colors"
                                onClick={dismissFailure}
                            >
                                Dismiss
                            </button>
                        </div>
                    </div>
                )}

                <div className="flex flex-col gap-2">
                    <p className="text-xs leading-4 text-fg-secondary">Installed</p>
                    <div className="flex flex-col">
                        {Object.entries(downloads).map(([name, state]) => (
                            <DownloadingRow
                                key={name}
                                name={name}
                                state={state}
                                onCancel={() => cancelDownload(name)}
                            />
                        ))}
                        {visibleInstalled.length === 0 && Object.keys(downloads).length === 0 ? (
                            <p className="p-2 text-sm leading-[18px] text-fg-faint">
                                {query ? "No installed models match" : "No models installed yet"}
                            </p>
                        ) : (
                            visibleInstalled.map((model) => {
                                const fit = estimateFit(model.size, systemInfo);
                                const isActive = currentModel === model.name;
                                return (
                                    <div key={model.name} className="flex flex-col">
                                        <div
                                            // "In use" beside the publisher marks the active model;
                                            // the wash stays hover-only so rows read uniformly.
                                            className="group flex items-center gap-2 p-2 rounded cursor-pointer transition-colors hover:bg-hover/70"
                                            onClick={() => setSelected(baseName(model.name))}
                                        >
                                            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                                                <div className="flex items-center gap-2 min-w-0">
                                                    <p className="text-sm leading-[18px] text-fg truncate">{model.name}</p>
                                                    <FitBadge fit={fit} />
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <Meta>{publisherFor(model.name)}</Meta>
                                                    {isActive && <Meta>In use</Meta>}
                                                </div>
                                            </div>
                                            <DetailsButton />
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>

                {settings.offlineMode ? (
                    <div className="flex flex-col gap-1 p-2 rounded bg-hover/40">
                        <p className="text-xs leading-4 text-fg-secondary">Offline mode is on</p>
                        <p className="text-xs leading-4 text-fg-muted">
                            Browsing and downloading models need internet access. Your installed models above still work
                            normally — turn offline mode off in Settings to browse.
                        </p>
                    </div>
                ) : (
                <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                        <p className="text-xs leading-4 text-fg-secondary">Available to download</p>
                        <div className="flex items-center gap-2 flex-wrap">
                            {/* Capability filter — a dropdown, applied on top of the
                                text search. Native <select> so it's a real menu. */}
                            <select
                                value={capabilityFilter}
                                onChange={(e) => setCapabilityFilter(e.target.value as CapabilityFilter)}
                                className="px-2 py-0.5 rounded text-xs leading-4 text-fg-secondary bg-hover/70 outline-none cursor-pointer hover:bg-hover transition-colors"
                            >
                                {CAPABILITY_FILTERS.map(([key, label]) => (
                                    <option key={key} value={key}>{label}</option>
                                ))}
                            </select>
                            <select
                                value={sortBy}
                                onChange={(e) => setSortBy(e.target.value as SortKey)}
                                className="px-2 py-0.5 rounded text-xs leading-4 text-fg-secondary bg-hover/70 outline-none cursor-pointer hover:bg-hover transition-colors"
                            >
                                {([
                                    ["fit", `Best for your ${deviceNoun(systemInfo?.os)}`],
                                    ["popular", "Popular"],
                                    ["newest", "Newly released"],
                                    ["alpha", "A–Z"],
                                ] as [SortKey, string][]).map(([key, label]) => (
                                    <option key={key} value={key}>{label}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                    <div className="flex flex-col">
                        {available.length === 0 && (
                            <p className="p-2 text-sm leading-[18px] text-fg-faint">
                                {/* A real wait now: the catalog is one ~1.5s request for the
                                    whole library, where it used to be 20 models. Pulsed like
                                    its "Searching…" sibling so it reads as working, not stuck. */}
                                {catalogOrder.length === 0
                                    ? <span className="animate-pulse">Loading models…</span>
                                    : "No models match"}
                            </p>
                        )}
                        {available.map((name) => (
                            <DownloadRow
                                key={name}
                                name={name}
                                details={catalog[name]}
                                sizeBytes={sizes[name]}
                                systemInfo={systemInfo}
                                onOpen={() => setSelected(baseName(name))}
                            />
                        ))}
                    </div>
                </div>
                )}

                {!settings.offlineMode && query.trim().length >= 2 && (
                    <div className="flex flex-col gap-2">
                        <p className="text-xs leading-4 text-fg-secondary">More results</p>
                        <div className="flex flex-col">
                            {isSearching && (
                                <p className="p-2 text-sm leading-[18px] text-fg-faint animate-pulse">Searching…</p>
                            )}
                            {!isSearching && extraResults.length === 0 && (
                                <p className="p-2 text-sm leading-[18px] text-fg-faint">Nothing else found</p>
                            )}
                            {extraResults.map((model) => (
                                <DownloadRow
                                    key={model.name}
                                    name={model.name}
                                    details={model}
                                    systemInfo={systemInfo}
                                    sizeBytes={sizes[model.name]}
                                    onOpen={() => setSelected(baseName(model.name))}
                                />
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function DownloadRow({ name, details, systemInfo, sizeBytes, onOpen }: {
    name: string;
    details?: RemoteModel;
    systemInfo?: SystemInfo;
    sizeBytes?: number;
    onOpen: () => void;
}) {
    const fit = fitForListing(details, systemInfo, sizeBytes);
    return (
        <div className="flex flex-col">
        <div
            className="group flex items-center gap-2 p-2 rounded cursor-pointer transition-colors hover:bg-hover/70"
            onClick={onOpen}
        >
            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                <div className="flex items-center gap-2 min-w-0">
                    <p className="text-sm leading-[18px] text-fg truncate">{name}</p>
                    <FitBadge fit={fit} />
                </div>
                <div className="flex items-center gap-2 min-w-0">
                    <Meta>{publisherFor(name)}</Meta>
                </div>
            </div>
            <DetailsButton />
        </div>
        </div>
    );
}
