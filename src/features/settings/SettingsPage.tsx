import { useEffect, useState } from "react";
import { useSettings, ContextMode } from "../../hooks/useSettings";
import {
    useSystemInfo, InstalledModel, ModelDetails, Fit,
    fitForRequired, formatBytes, memoryCeilingBytes, memoryCeilingBreakdown, compressedCeilingBytes,
    withReloadableMemory,
} from "../../hooks/useSystemInfo";
import { resolveContext, formatCount, runtimeKvBytesPerToken, contextBytesPerToken, CONTEXT_STEPS } from "../models/modelFacts";
import { useOllamaRuntime } from "../../hooks/useOllamaRuntime";
import { usePreviousData } from "../../hooks/usePreviousData";
import { pushPermissionGranted } from "../notices/push";
import { formatRelativeTime } from "../chat/relativeTime";
import { ask } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useLoadedModel, offloadShare, releasesInMinutes } from "../../hooks/useLoadedModel";
import Settings from "../../svg/Settings";
import MemoryBar from "./MemoryBar";

/** Mirrors the Rust `SemanticStatus` — the index's state for the section below. */
interface SemanticStatus {
    enabled: boolean;
    model_installed: boolean;
    embeddable: number;
    embedded: number;
}

/**
 * Ollama's own default is 300s. It is offered here as one choice among several
 * rather than left implicit, so the value is always this app's decision.
 */
const KEEP_ALIVE_OPTIONS = [
    { seconds: -1, label: "Always" },
    { seconds: 300, label: "5 min" },
    { seconds: 900, label: "15 min" },
    { seconds: 1800, label: "30 min" },
    { seconds: 3600, label: "1 hour" },
] as const;

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

interface SettingsPageProps {
    currentModel?: string;
}

export default function SettingsPage({ currentModel }: SettingsPageProps) {
    const { settings, update } = useSettings();
    /**
     * Whether macOS will actually deliver notifications.
     *
     * Checked, never requested — opening Settings must not trigger the system
     * prompt. Without this the toggle could sit there saying "on" while the OS
     * silently dropped everything, which is worse than having no toggle. `null`
     * (not yet known) is not the same as denied and is not drawn as it.
     */
    const [pushAllowed, setPushAllowed] = useState<boolean | null>(null);
    useEffect(() => { pushPermissionGranted().then(setPushAllowed).catch(() => setPushAllowed(null)); }, []);

    const { systemInfo, listInstalledModels, getModelDetails } = useSystemInfo();
    const { runtime, integrity, latest, checking, updating, installing, error: runtimeError, checkForUpdate, update: updateRuntime, installManaged } = useOllamaRuntime();
    // The app's own version, shown in the section below. (Auto-update was removed
    // for the open-source build.)
    const [appVersion, setAppVersion] = useState<string>();
    useEffect(() => {
        invoke<string>("get_app_version").then(setAppVersion).catch(() => {});
    }, []);
    const {
        summary: previousData, restoring, deleting, restored, error: previousDataError, restore, remove,
    } = usePreviousData();

    const [installed, setInstalled] = useState<InstalledModel[]>([]);
    const [details, setDetails] = useState<ModelDetails | null>(null);

    useEffect(() => {
        listInstalledModels().then(setInstalled);
    }, []);

    // The preview is computed against the model actually in use — the memory cost
    // of a context length varies several-fold between architectures, so a single
    // number would be meaningless without naming which model it applies to.
    const active = installed.find(m => m.name === currentModel) ?? installed[0];

    useEffect(() => {
        setDetails(null);
        if (active) getModelDetails(active.name).then(setDetails);
    }, [active?.name]);

    // What Ollama actually holds resident (`/api/ps`), used both for the "measured,
    // not predicted" block far below and — crucially — for sizing this model's
    // context. See `withReloadableMemory`: a model that is already loaded has
    // suppressed the free-memory reading by its own bytes, which it releases on
    // reload, so its own residency must be credited back before Auto sizes it.
    const { loaded } = useLoadedModel(active?.name);
    /** Only this model's own bytes, and only when it is the one loaded. */
    const heldForActive = loaded && active && loaded.name === active.name ? loaded.size : undefined;
    /** The system as this model may reload it: free memory with its own residency
        added back. Everything that *sizes or judges this model* reads this; the
        MemoryBar keeps the raw `systemInfo`, because it reports the machine now. */
    const sizingSystem = withReloadableMemory(systemInfo, heldForActive);

    // The semantic-search index's live state for the section below. Re-fetched when the
    // toggle changes, and self-polls while the model is downloading or the backfill is
    // catching up so the progress advances without reopening Settings; it stops polling
    // once the index is complete (or the feature is off).
    const [semantic, setSemantic] = useState<SemanticStatus | null>(null);
    useEffect(() => {
        let cancelled = false;
        let timer: number | undefined;
        let lastEmbedded = -1;
        let stallPolls = 0;
        const poll = async () => {
            try {
                const s = await invoke<SemanticStatus>("semantic_index_status");
                if (cancelled) return;
                setSemantic(s);
                const complete = s.model_installed && s.embedded >= s.embeddable;
                // Offline with no model can't make progress — the pull is the one
                // online step. Don't poll forever waiting for a download that can't run.
                const blockedOffline = !s.model_installed && settings.offlineMode;
                // The count stopped advancing while indexing → the backfill has stalled
                // (engine trouble). Tolerate a couple of flat polls first, so a slow
                // batch isn't mistaken for a stall, then stop.
                if (s.model_installed && s.embedded < s.embeddable) {
                    stallPolls = s.embedded === lastEmbedded ? stallPolls + 1 : 0;
                } else {
                    stallPolls = 0;
                }
                lastEmbedded = s.embedded;
                // Reschedule on the user's *intent* (settings.semanticSearch), not the
                // backend flag `s.enabled`: right after toggling on, the flag can still
                // read false for a beat, and gating on it froze the status line.
                const keepPolling = settings.semanticSearch && !complete && !blockedOffline && stallPolls < 3;
                if (keepPolling) timer = window.setTimeout(poll, 2000);
            } catch {
                // No backend (browser preview) — the section just shows the toggle.
            }
        };
        poll();
        return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
    }, [settings.semanticSearch, settings.offlineMode]);

    // One line under the toggle, describing where indexing is. Null while off or before
    // the first status arrives, so the section is just the toggle until there's
    // something true to say.
    const semanticLine: string | null = !settings.semanticSearch || !semantic
        ? null
        : !semantic.model_installed
            // The pull is the one online step, so say why it can't happen rather than
            // claiming a download is underway that offline mode is blocking.
            ? (settings.offlineMode
                ? "Offline — turn off offline mode to download the embedding model (~45MB)."
                : "Downloading the embedding model (~45MB)…")
            : semantic.embeddable === 0
                ? "No conversations to index yet."
                : semantic.embedded < semantic.embeddable
                    ? `Indexing conversations… ${semantic.embedded.toLocaleString()} of ${semantic.embeddable.toLocaleString()} messages.`
                    : `${semantic.embeddable.toLocaleString()} messages indexed.`;

    const contextInputs = {
        modelMax: details?.context_length,
        kvBytesPerToken: runtimeKvBytesPerToken(details?.kv_bytes_per_token),
        architecture: details?.family ?? active?.family,
        weightsBytes: active?.size,
        memoryCeiling: memoryCeilingBytes(sizingSystem, settings.reservedMemoryGb),
        memoryCeilingFallback: compressedCeilingBytes(sizingSystem, settings.reservedMemoryGb),
    };
    // Same source Auto uses, so the figures below describe the context it picked.
    const kvPerToken = contextBytesPerToken(contextInputs);
    const resolved = resolveContext(settings.contextMode, settings.contextCeiling, contextInputs);

    const cache = kvPerToken ? kvPerToken * resolved : undefined;
    const total = active && cache !== undefined ? active.size + cache : active?.size;
    const fit = fitForRequired(total, sizingSystem);
    /**
     * What's left *after* loading, measured against memory that's actually free —
     * not against total RAM.
     *
     * Subtracting from total quietly assumes an empty machine. It never is: with
     * ~10.5GB already held by macOS, a browser and the dev server, "leaves 8.8GB"
     * was promising more than the machine had, while the honest figure was that
     * the model wouldn't fit in free memory at all.
     */
    const headroom = sizingSystem?.available_memory && total
        ? sizingSystem.available_memory - total
        : undefined;

    const modelMax = details?.context_length;
    const steps = CONTEXT_STEPS.filter(s => !modelMax || s <= modelMax);

    // Which limit is actually deciding the context — also what the reserve options
    // are measured against, since one that isn't tighter than this does nothing.
    const ceiling = memoryCeilingBreakdown(sizingSystem, settings.reservedMemoryGb);

    /**
     * None, then every 4GB up to this machine's RAM.
     *
     * Generated from the hardware rather than filtered from a fixed list. The old
     * version offered only values that were *binding* — tighter than the automatic
     * limits — which made the control unpredictable and, in one case, a trap door:
     * with 12GB reserved on a 16GB machine, every candidate measured as
     * non-binding, the list emptied, and the setting could no longer be seen or
     * undone while it was still capping the context at 8k.
     *
     * A complete ladder is offered instead. Some rungs won't constrain anything on
     * a given machine — a 4GB reserve on 16GB never beats the GPU limit — but the
     * memory bar above names whichever limit is actually deciding, so a choice that
     * changes nothing now says so rather than being hidden.
     */
    const reserveOptions = (() => {
        if (!systemInfo?.total_memory) return [];
        const totalGb = Math.floor(systemInfo.total_memory / 1024 ** 3);
        const steps = [0];
        for (let gb = 4; gb <= totalGb; gb += 4) steps.push(gb);
        // A value saved from an older list stays on screen, so it is always visible
        // as the selection and always undoable.
        if (!steps.includes(settings.reservedMemoryGb)) steps.push(settings.reservedMemoryGb);
        return steps.sort((a, b) => a - b);
    })();

    // Nothing to install is a state you have to *discover*, so when the app owns
    // the runtime the CTA checks first and only becomes an install once a newer
    // version is actually known.
    const updateAvailable = !!latest && latest !== runtime?.version;
    // A system Ollama on PATH belongs to the user — report it, never overwrite it.
    // `update_ollama` refuses outright, so this can never be the offered action for
    // a borrowed runtime, however out of date that runtime is.
    const canUpdate = updateAvailable && !!runtime?.managed_by_app;
    const runtimeBusy = checking || updating || installing;
    // The app is running someone else's Ollama, so it can neither update it nor
    // rely on it being there. Installing its own copy is the way out.
    const borrowingOllama = !!runtime?.path && !runtime.managed_by_app;
    // Only `false` is worth showing. `null` means the check couldn't run, which is
    // not a problem — reporting it as one would train people to ignore the warning.
    const signatureMismatch = integrity?.managed === true && integrity.verified === false;

    /**
     * The runtime's one action, resolved from state the app already holds.
     *
     * This was two stacked buttons, and while the app was borrowing a system Ollama
     * the top one could never do anything: `canUpdate` requires `managed_by_app`,
     * so it stayed "Check for updates" no matter how many times it was pressed,
     * while the button that actually resolved the situation sat underneath it in
     * the secondary slot. Pressing the dead one, reading a warning, then finding
     * the live one below is a sequence with no purpose — `managed_by_app` arrives
     * with `get_ollama_runtime` on load, so the right action is known before the
     * first click.
     *
     * Ordered by what has to happen first, and the branches can't overlap:
     * `signatureMismatch` requires a managed runtime and `borrowingOllama` requires
     * the opposite.
     *
     * `filled` marks the states where there is something to do. Only the bare check
     * is passive, and it shouldn't wear the same weight as an install.
     */
    const runtimeAction = signatureMismatch
        ? { label: "Reinstall Ollama", run: installManaged, filled: true }
        : borrowingOllama
            // Always offered, current or not: the app can't update this copy and
            // loses its runtime if the copy moves. Installing fetches the current
            // release anyway, so there's no version to look up first.
            ? { label: "Install Ollama and switch", run: installManaged, filled: true }
            : canUpdate
                ? { label: `Update to ${latest}`, run: updateRuntime, filled: true }
                : { label: "Check for updates", run: checkForUpdate, filled: false };

    // Measured, not predicted. The block below is the only place in Settings that
    // reports what Ollama did rather than what this app expects it to do. `loaded`
    // itself is fetched up top, where the context sizing needs it.
    const offload = offloadShare(loaded ?? undefined);
    const releasesIn = releasesInMinutes(loaded ?? undefined);
    /**
     * What the loaded instance will cost once its window is *full*, as against
     * `loaded.size`, which is what it costs right now.
     *
     * Ollama's `/api/ps` reports the cache it has actually allocated, not the
     * cache the context reserves — MLX allocates lazily, so SIZE is byte-identical
     * at 8k and 128k until real tokens go through it. Measured on qwen3.5:4b-mlx:
     * 3.79GB at 13 tokens rising to 4.62GB at 24,568, ~36.7KB per token. Reporting
     * only the live figure invites reading a nearly-empty 128k session as costing
     * 3.8GB when it is heading for 8.4.
     *
     * Only for the model we hold details for — `active` is the *selected* model,
     * which need not be the loaded one, and another model's bytes per token would
     * be wrong by several times over.
     */
    const loadedProjection = loaded && active && loaded.name === active.name
        && loaded.context_length != null && kvPerToken
        ? active.size + loaded.context_length * kvPerToken
        : undefined;
    const clamped = loaded?.context_length != null && loaded.context_length < resolved;

    return (
        <div className="flex-1 overflow-y-auto no-scrollbar flex flex-col" style={{ msOverflowStyle: 'none', scrollbarWidth: 'none' }}>
            {/* `m-auto` centres vertically when there's room and still scrolls
                correctly when there isn't — `justify-center` would put the top of
                overflowing content out of reach. */}
            <div className="w-full max-w-[640px] m-auto flex flex-col gap-8 px-4 py-8">
                <div className="flex items-center gap-2">
                    <Settings size={16} color="rgb(var(--fg))" />
                    <h1 className="text-sm leading-[18px] text-fg">Settings</h1>
                </div>

                <div className="flex flex-col gap-3">
                    <div className="flex items-start gap-3">
                        <div className="flex flex-col gap-1 flex-1 min-w-0">
                            <p className="text-xs font-semibold leading-4 text-fg">Offline mode</p>
                            <p className="text-xs leading-4 text-fg-muted">
                                Stops this app making any internet request. Chat is unaffected — it already runs entirely
                                on your machine. Browsing and downloading models stop working until you turn it off.
                            </p>
                        </div>
                        <button
                            role="switch"
                            aria-checked={settings.offlineMode}
                            className={`flex-shrink-0 mt-0.5 w-9 h-5 rounded-full p-0.5 transition-colors ${settings.offlineMode ? "bg-inverse" : "bg-line-strong"}`}
                            onClick={() => update({ offlineMode: !settings.offlineMode })}
                        >
                            <span className={`block w-4 h-4 rounded-full bg-card transition-transform ${settings.offlineMode ? "translate-x-4" : ""}`} />
                        </button>
                    </div>
                </div>

                {/* A sibling in the same `gap-8` column as every other section, with
                    its own `border-t pt-8` and no bottom padding — the parent gap is
                    the bottom half of the rhythm. See "Settings sections are siblings". */}
                <div className="flex flex-col gap-3 border-t border-line pt-8">
                    <div className="flex items-start gap-3">
                        <div className="flex flex-col gap-1 flex-1 min-w-0">
                            <p className="text-xs font-semibold leading-4 text-fg">Notify me when I'm away</p>
                            <p className="text-xs leading-4 text-fg-muted">
                                A macOS notification when a reply finishes, when something goes wrong,
                                or when a chat's context window is nearly full. Only ever while
                                Scarlettt is in the background — nothing appears while you're looking
                                at it.
                            </p>
                            {settings.pushNotifications && pushAllowed === false && (
                                <p className="text-xs leading-4 text-warn-fg">
                                    macOS is currently blocking notifications from Scarlettt. Turn them
                                    on for it in System Settings › Notifications.
                                </p>
                            )}
                        </div>
                        <button
                            role="switch"
                            aria-checked={settings.pushNotifications}
                            className={`flex-shrink-0 mt-0.5 w-9 h-5 rounded-full p-0.5 transition-colors ${settings.pushNotifications ? "bg-inverse" : "bg-line-strong"}`}
                            onClick={() => update({ pushNotifications: !settings.pushNotifications })}
                        >
                            <span className={`block w-4 h-4 rounded-full bg-card transition-transform ${settings.pushNotifications ? "translate-x-4" : ""}`} />
                        </button>
                    </div>
                </div>

                <div className="flex flex-col gap-3 border-t border-line pt-8">
                    <div className="flex items-start gap-3">
                        <div className="flex flex-col gap-1 flex-1 min-w-0">
                            <p className="text-xs font-semibold leading-4 text-fg">Semantic search</p>
                            <p className="text-xs leading-4 text-fg-muted">
                                Search your chats by meaning, not just the exact words. A small model
                                (~45MB) runs on your machine and indexes every message — nothing leaves
                                it. Turn it off to stop indexing; the model and index stay on disk, so
                                turning it back on is instant. Keyword search works either way.
                            </p>
                            {semanticLine && (
                                <p className="text-xs leading-4 text-fg-muted">{semanticLine}</p>
                            )}
                        </div>
                        <button
                            role="switch"
                            aria-checked={settings.semanticSearch}
                            className={`flex-shrink-0 mt-0.5 w-9 h-5 rounded-full p-0.5 transition-colors ${settings.semanticSearch ? "bg-inverse" : "bg-line-strong"}`}
                            onClick={() => update({ semanticSearch: !settings.semanticSearch })}
                        >
                            <span className={`block w-4 h-4 rounded-full bg-card transition-transform ${settings.semanticSearch ? "translate-x-4" : ""}`} />
                        </button>
                    </div>
                </div>

                <div className="flex flex-col gap-3 border-t border-line pt-8">
                    <div className="flex flex-col gap-1">
                        <p className="text-xs font-semibold leading-4 text-fg">Appearance</p>
                        <p className="text-xs leading-4 text-fg-muted">
                            Light, dark, or match your system. Auto follows your system appearance and
                            switches with it.
                        </p>
                    </div>
                    <div className="flex gap-0.5 p-0.5 rounded-lg bg-hover w-fit">
                        {(["auto", "light", "dark"] as const).map(opt => (
                            <button
                                key={opt}
                                onClick={() => update({ theme: opt })}
                                aria-pressed={settings.theme === opt}
                                className={`px-3 py-1 rounded-md text-xs leading-4 capitalize transition-colors ${
                                    settings.theme === opt
                                        ? "bg-card text-fg shadow-sm"
                                        : "text-fg-muted hover:text-fg"
                                }`}
                            >
                                {opt}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="flex flex-col gap-3 border-t border-line pt-8">
                    <div className="flex flex-col gap-1">
                        <p className="text-xs font-semibold leading-4 text-fg">Context length</p>
                        <p className="text-xs leading-4 text-fg-muted">
                            How much of a conversation the model can consider at once. Ollama defaults to 4k tokens
                            regardless of what a model supports, which is why long chats start forgetting their
                            beginning. Applies to every model, capped at whatever each one supports.
                        </p>
                    </div>

                    <div className="flex flex-col">
                        {([
                            ["auto", "Auto", "Largest context that still leaves this machine comfortable."],
                            ["manual", "Fixed", "Use the same ceiling for every model."],
                        ] as [ContextMode, string, string][]).map(([mode, label, hint]) => (
                            <div
                                key={mode}
                                className="flex items-start gap-2 p-2 rounded cursor-pointer hover:bg-hover/70 transition-colors"
                                onClick={() => update({ contextMode: mode })}
                            >
                                <span className={`flex-shrink-0 mt-0.5 w-3 h-3 rounded-full border ${settings.contextMode === mode ? "border-fg border-4" : "border-line-strong"}`} />
                                <div className="flex flex-col gap-0.5">
                                    <span className="text-sm leading-[18px] text-fg">{label}</span>
                                    <span className="text-xs leading-4 text-fg-muted">{hint}</span>
                                </div>
                            </div>
                        ))}
                    </div>

                    {settings.contextMode === "manual" && (
                        <div className="flex flex-wrap gap-1 pl-2">
                            {steps.map(step => (
                                <button
                                    key={step}
                                    className={`px-2 py-1 rounded text-xs leading-4 transition-colors ${
                                        settings.contextCeiling === step
                                            ? "bg-inverse text-inverse-fg"
                                            : "bg-hover/70 text-fg-secondary hover:bg-line-strong/70"
                                    }`}
                                    onClick={() => update({ contextCeiling: step })}
                                >
                                    {formatCount(step)}
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {/* Named preview — the warning has to say which model it's about. */}
                <div className="flex flex-col gap-2">
                    <p className="text-xs font-semibold leading-4 text-fg">With your current model</p>
                    {!active ? (
                        <p className="py-2 text-sm leading-[18px] text-fg-faint">No models installed</p>
                    ) : (
                        <div className="flex flex-col gap-1 py-2">
                            <div className="flex items-center gap-2">
                                <span className="text-sm leading-[18px] text-fg">{active.name}</span>
                                <span className={`px-2 py-0.5 rounded-full border text-xs leading-4 ${FIT_CLASS[fit]}`}>
                                    {FIT_LABEL[fit]}
                                </span>
                            </div>
                            <span className="text-xs leading-4 text-fg">
                                {formatCount(resolved)} tokens
                                {modelMax && resolved < modelMax && (
                                    <span className="text-fg-muted"> · capped from {formatCount(modelMax)} supported</span>
                                )}
                            </span>
                            {total !== undefined && (
                                <span className="text-xs leading-4 text-fg-muted">
                                    {formatBytes(total)}
                                    {cache !== undefined && ` (${formatBytes(active.size)} weights + ${formatBytes(cache)} cache)`}
                                    {/* Names the free figure and the consequence. "1.3GB more
                                        than is currently free" read as a surplus, so a bigger
                                        context looked like it freed more memory. The free figure
                                        is the reload-effective one (this model's own residency
                                        added back), so it matches what Auto sized against; the
                                        "once it reloads" tag says why it differs from the bar's
                                        raw free band below. */}
                                    {headroom !== undefined && sizingSystem && (headroom > 0
                                        ? ` · leaves ${formatBytes(headroom)} of the ${formatBytes(sizingSystem.available_memory)} free${heldForActive ? ' once it reloads' : ''}`
                                        : ` · needs ${formatBytes(-headroom)} beyond the ${formatBytes(sizingSystem.available_memory)} free${heldForActive ? ' once it reloads' : ''}, so macOS will compress to fit`)}
                                </span>
                            )}
                            {fit === 'tight' && (
                                <p className="text-xs leading-4 text-warn-fg">
                                    Little memory left for anything else at this context length.
                                </p>
                            )}
                            {fit === 'too-large' && (
                                <p className="text-xs leading-4 text-bad-fg">
                                    Beyond this machine's memory — macOS will page to SSD and generation will slow to a
                                    crawl. Lower the context length or use a smaller model.
                                </p>
                            )}

                            {/* The figures above stated separately; this shows how they
                                relate, which is what actually explains the context. */}
                            {systemInfo && ceiling && (
                                <div className="pt-2">
                                    <MemoryBar
                                        systemInfo={systemInfo}
                                        required={total}
                                        weights={active.size}
                                        // Only this model's own resident bytes, and
                                        // only when it is the one loaded — the same
                                        // guarded value the sizing above credits back.
                                        loadedBytes={heldForActive}
                                        ceilingSource={ceiling.source}
                                    />
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Only meaningful for Auto — Fixed already pins the context, so a
                    memory reserve would have nothing left to influence. */}
                {settings.contextMode === "auto" && reserveOptions.length > 0 && (
                    <div className="flex flex-col gap-3 border-t border-line pt-8">
                        <div className="flex flex-col gap-1">
                            <p className="text-xs font-semibold leading-4 text-fg">Memory left for everything else</p>
                            <p className="text-xs leading-4 text-fg-muted">
                                Auto keeps its context under this, so the rest of your machine stays usable. Set in
                                gigabytes rather than tokens because the same token count costs several times more
                                memory on one model than another — this holds whichever model you pick.
                            </p>
                        </div>
                        <div className="flex flex-wrap gap-1">
                            {reserveOptions.map(gb => (
                                <button
                                    key={gb}
                                    className={`px-2 py-1 rounded text-xs leading-4 transition-colors ${
                                        settings.reservedMemoryGb === gb
                                            ? "bg-inverse text-inverse-fg"
                                            : "bg-hover/70 text-fg-secondary hover:bg-line-strong/70"
                                    }`}
                                    onClick={() => update({ reservedMemoryGb: gb })}
                                >
                                    {gb === 0 ? "None" : `${gb}GB`}
                                </button>
                            ))}
                        </div>
                        {headroom !== undefined && headroom > 0 && (
                            <p className="text-xs leading-4 text-fg-muted">
                                As set, the model leaves about {formatBytes(headroom)} of free memory.
                            </p>
                        )}
                    </div>
                )}

                {/* Measured, not estimated. Everything above this line is a
                    prediction; this is what Ollama reports it actually did. */}
                <div className="flex flex-col gap-3 border-t border-line pt-8">
                    <div className="flex flex-col gap-1">
                        <p className="text-xs font-semibold leading-4 text-fg">Keep the model in memory</p>
                        <p className="text-xs leading-4 text-fg-muted">
                            After a reply, how long the model stays loaded before its memory is released. Longer means no
                            pause when you come back to a chat; shorter gives the memory back sooner. Unlike the context
                            length, changing this doesn't reload anything — it only resets a timer.
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-1">
                        {KEEP_ALIVE_OPTIONS.map(option => (
                            <button
                                key={option.seconds}
                                className={`px-2 py-1 rounded text-xs leading-4 transition-colors ${
                                    settings.keepAliveSeconds === option.seconds
                                        ? "bg-inverse text-inverse-fg"
                                        : "bg-hover/70 text-fg-secondary hover:bg-line-strong/70"
                                }`}
                                onClick={() => update({ keepAliveSeconds: option.seconds })}
                            >
                                {option.label}
                            </button>
                        ))}
                    </div>
                    {settings.keepAliveSeconds === -1 && total !== undefined && (
                        <p className="text-xs leading-4 text-warn-fg">
                            Holds {formatBytes(total)} for as long as the app is open, whether or not you're chatting. It
                            is released when you quit.
                        </p>
                    )}
                </div>

                <div className="flex flex-col gap-2 border-t border-line pt-8">
                    <p className="text-xs font-semibold leading-4 text-fg">Loaded right now</p>
                    {!loaded ? (
                        <p className="py-2 text-xs leading-4 text-fg-muted">
                            No model in memory. Ollama loads one on your next message and releases it after about
                            five idle minutes — come back here then to see what it actually did.
                        </p>
                    ) : (
                        <div className="flex flex-col gap-1 py-2">
                            <div className="flex items-center gap-2">
                                <span className="text-sm leading-[18px] text-fg">{loaded.name}</span>
                                <span
                                    className={`px-2 py-0.5 rounded-full border text-xs leading-4 ${
                                        offload === undefined ? FIT_CLASS.unknown
                                            : offload > 0 ? "bg-bad-bg text-bad-fg border-bad-line"
                                            : "bg-good-bg text-good-fg border-good-line"
                                    }`}
                                >
                                    {offload === undefined ? "Placement unknown"
                                        : offload > 0 ? `${Math.round(offload * 100)}% on CPU`
                                        : "100% GPU"}
                                </span>
                            </div>
                            {loaded.context_length != null && (
                                <span className="text-xs leading-4 text-fg">
                                    {formatCount(loaded.context_length)} tokens
                                    {/* What the keep-alive setting above is doing, at the
                                        one place its effect is observable. */}
                                    <span className="text-fg-muted">
                                        {settings.keepAliveSeconds === -1
                                            ? " · held while the app is open"
                                            : releasesIn !== undefined
                                                ? ` · releases in ${releasesIn} min`
                                                : ""}
                                    </span>
                                    {clamped && (
                                        <span className="text-fg-muted">
                                            {" "}· asked for {formatCount(resolved)}, this model's limit is lower
                                        </span>
                                    )}
                                </span>
                            )}
                            <span className="text-xs leading-4 text-fg-muted">
                                {formatBytes(loaded.size)} now
                                {loadedProjection !== undefined && loaded.context_length != null &&
                                    ` · about ${formatBytes(loadedProjection)} with the ${formatCount(loaded.context_length)} window full`}
                                {!!offload && ` · only ${formatBytes(loaded.size_vram)} fits on the GPU`}
                            </span>
                            {!!offload && (
                                <p className="text-xs leading-4 text-bad-fg">
                                    Part of this model is running on the CPU because it didn't fit in GPU memory — that
                                    costs far more speed than the extra context is worth. Lower the context length until
                                    this reads 100% GPU.
                                </p>
                            )}
                        </div>
                    )}
                </div>

                {/* Conversations a fresh start set aside. Hidden entirely when
                    there are none — a section about data that does not exist is
                    noise on every launch but one, the same way the memory
                    reserve hides when no option is binding.

                    ONE row, however many sets are on disk. Each fresh start writes its
                    own, so a few reinstalls leave several — and being asked which of
                    three sets to bring back is a question about this app's filing
                    rather than about the user's conversations. */}
                {previousData && (
                    <div className="flex flex-col gap-3 border-t border-line pt-8">
                        <div className="flex flex-col gap-1">
                            <p className="text-xs font-semibold leading-4 text-fg">Previous conversations</p>
                            <p className="text-xs leading-4 text-fg-muted">
                                Set aside when you chose to start fresh. Restoring adds them back
                                alongside your current chats — nothing is replaced, and restoring
                                twice changes nothing. Deleting cannot be undone.
                            </p>
                            {previousDataError && (
                                <p className="text-xs leading-4 text-bad-fg">{previousDataError}</p>
                            )}
                            {restored && (
                                <p className="text-xs leading-4 text-fg">
                                    Added {restored.sessions} {restored.sessions === 1 ? "conversation" : "conversations"}
                                    {restored.messages > 0 && ` and ${restored.messages} messages`}.
                                </p>
                            )}
                        </div>

                        <div className="flex items-start gap-10">
                            <div className="flex flex-col gap-1 flex-1 min-w-0">
                                <p className="text-xs leading-4 text-fg">
                                    {previousData.sessions} {previousData.sessions === 1 ? "conversation" : "conversations"}
                                    {previousData.messages > 0 && `, ${previousData.messages} messages`}
                                </p>
                                <p className="text-xs leading-4 text-fg-muted">
                                    {previousData.sets > 1 && `From ${previousData.sets} sets, the oldest `}
                                    {previousData.sets > 1 ? "set aside " : "Set aside "}
                                    {formatRelativeTime(new Date(previousData.oldestAt * 1000).toISOString())}
                                    {previousData.bytes > 0 && ` · ${formatBytes(previousData.bytes)}`}
                                </p>
                            </div>
                            {/* Side by side, not stacked: two actions on one thing, of
                                comparable weight — a column put Delete underneath
                                Restore and read like a primary with a footnote. */}
                            <div className="flex-shrink-0 flex items-center gap-2">
                                <button
                                    disabled={restoring || deleting}
                                    onClick={restore}
                                    className="relative whitespace-nowrap px-3 py-1.5 rounded-lg text-sm leading-[18px] transition-colors disabled:opacity-50 bg-inverse text-inverse-fg hover:bg-inverse-hover"
                                >
                                    <span className={restoring ? "invisible" : undefined}>Restore</span>
                                    {restoring && (
                                        <span className="absolute inset-0 flex items-center justify-center">Restoring…</span>
                                    )}
                                </button>
                                <button
                                    disabled={restoring || deleting}
                                    onClick={async () => {
                                        // The one irreversible action on this page, so it
                                        // asks — with the same dialog the sidebar uses to
                                        // confirm deleting a chat.
                                        const sure = await ask(
                                            `Delete ${previousData.sessions} set-aside ${previousData.sessions === 1 ? "conversation" : "conversations"}? This cannot be undone.`,
                                            { title: "Delete previous conversations", kind: "warning" },
                                        );
                                        if (sure) remove();
                                    }}
                                    className="relative whitespace-nowrap px-3 py-1.5 rounded-lg text-sm leading-[18px] transition-colors disabled:opacity-50 bg-hover/70 text-fg hover:bg-line-strong/70"
                                >
                                    <span className={deleting ? "invisible" : undefined}>Delete</span>
                                    {deleting && (
                                        <span className="absolute inset-0 flex items-center justify-center">Deleting…</span>
                                    )}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Last, always. Everything above is a preference or the data
                    those preferences act on; this is the engine underneath them —
                    its version, its integrity, installing and replacing it. It is
                    also the only section that can reach out to the network and
                    rewrite a binary, which is not what should greet someone who
                    opened Settings to change a context length. */}
                {/* The app's own version. (Auto-update was removed for the
                    open-source build — ship new versions however you distribute it.) */}
                <div className="flex flex-col gap-3 border-t border-line pt-8">
                    <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-xs font-semibold leading-4 text-fg">Scarlettt version</p>
                            <span className="text-xs leading-4 text-fg">{appVersion ?? "…"}</span>
                        </div>
                    </div>
                </div>

                <div className="flex flex-col gap-3 border-t border-line pt-8">
                    {/* Stacked, top to bottom: heading, description, the one
                        action, then whatever needs saying about it. It was a
                        copy-left / action-right row, which put the CTA level with
                        the heading and left the amber note about a borrowed runtime
                        sitting *above* the button that resolves it — the
                        explanation arrived before the thing it explains. */}
                    <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-xs font-semibold leading-4 text-fg">Ollama runtime</p>
                            <span className="text-xs leading-4 text-fg">
                                {runtime?.version ? runtime.version : "not detected"}
                            </span>
                            {runtime?.outdated && (
                                <span className="px-2 py-0.5 rounded-full border text-xs leading-4 bg-warn-bg text-warn-fg border-warn-line">
                                    Outdated
                                </span>
                            )}
                            {latest && (
                                <span className="text-xs leading-4 text-fg-muted">
                                    {latest === runtime?.version ? "up to date" : `latest is ${latest}`}
                                </span>
                            )}
                        </div>
                        <p className="text-xs leading-4 text-fg-muted">
                            The engine that runs models on your machine. New models often need a recent version — an
                            old one refuses to download them.
                        </p>
                    </div>

                    {/* `self-start` so it hugs its label: the column would
                        otherwise stretch it the full 640px. */}
                    <button
                        disabled={runtimeBusy}
                        className={`relative self-start whitespace-nowrap px-3 py-1.5 rounded-lg text-sm leading-[18px] transition-colors disabled:opacity-50 ${
                            runtimeAction.filled
                                ? "bg-inverse text-inverse-fg hover:bg-inverse-hover"
                                : "bg-hover/70 text-fg hover:bg-line-strong/70"
                        }`}
                        onClick={runtimeAction.run}
                    >
                        {/* The resting label stays in the layout while a shorter
                            one is shown over it, so the button keeps its width. */}
                        <span className={runtimeBusy ? "invisible" : undefined}>
                            {runtimeAction.label}
                        </span>
                        {runtimeBusy && (
                            <span className="absolute inset-0 flex items-center justify-center">
                                {checking ? "Checking…" : updating ? "Updating…" : installing ? "Installing…" : "Please wait…"}
                            </span>
                        )}
                    </button>

                    {borrowingOllama && (
                        <p className="text-xs leading-4 text-warn-fg">
                            Scarlettt is using your own Ollama
                            {runtime?.path ? ` at ${runtime.path}` : ""}. Installing its own copy (147MB)
                            leaves yours where it is — this app just stops depending on it.
                        </p>
                    )}
                    {signatureMismatch && (
                        <p className="text-xs leading-4 text-bad-fg">
                            This copy of Ollama doesn't match the signature Scarlettt expects
                            {/* The detail is a whole sentence and usually ends in a period
                                already — appended blindly it read "…9Y9 It hasn't", and
                                normalised the other way it read "run.." */}
                            {integrity?.detail ? ` — ${integrity.detail.replace(/[.!?]?$/, ".")}` : "."} It hasn't been blocked:
                            the likeliest cause is Ollama renewing their certificate, not tampering.
                            Reinstalling fetches a fresh copy and checks it.
                        </p>
                    )}
                    {runtimeError && (
                        <p className="text-xs leading-4 text-bad-fg">{runtimeError}</p>
                    )}

                </div>

            </div>
        </div>
    );
}
