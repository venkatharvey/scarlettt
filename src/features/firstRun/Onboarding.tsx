import { ReactNode, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Logo } from "../../svg/Logo";
import { canChat, ModelSummary, OllamaStatus, useOllama } from "../../hooks/useOllama";
import { formatBytes } from "../../hooks/useSystemInfo";
import { baseName } from "../models/modelFacts";
import { describeDownload, useModelDownloads } from "../models/useModelDownloads";
import { ONBOARDING_SURFACE } from "../../layout";

/**
 * Everything between launching the app and having a conversation to type into.
 *
 * One screen and one flow, because the three questions it asks are the same
 * question at different stages:
 *
 *   is there data from a previous install?  -> restore it, or start fresh
 *   is the engine here?                     -> download it and start it
 *   is there a model that can chat?         -> download the first one
 *
 * These used to be two components that could not see each other: `FirstRunPrompt`
 * gated the app on the first question and `OllamaGuard` overlaid the app for the
 * other two. Because a fresh start deliberately spares the models directory, the
 * guard then found models, hid itself, and handed over an app with no
 * conversations and nothing said about what to do next. Chained here, a fresh
 * start ends where a first run does: one model downloaded, on a new chat.
 */

/**
 * The model every install starts with. Small enough (~640MB) that the first
 * download is a wait rather than an evening, and chat-capable — the only hard
 * requirement, since an embedding model would clear this screen and then fail on
 * the first message. The backend pulls this same name when it finds an empty
 * store (`wait_for_ollama_ready`), so both routes converge on one model.
 */
const FIRST_MODEL = "tinyllama";

/** How long "Ready!" holds before the chat replaces it. */
const READY_MS = 1200;

/**
 * Share of the progress bar spent fetching the engine, when it has to be fetched
 * at all. A machine that already has it gives the whole bar to the model instead
 * of starting it at 35% for no reason.
 */
const ENGINE_SHARE = 0.35;

/** How often to re-ask a silent engine, and how long before saying so. */
const PROBE_INTERVAL_MS = 3000;
const PROBE_PATIENCE = 5;

/** Whether the backend is downloading a model of its own accord right now. */
const enginePulling = (status: OllamaStatus): boolean =>
    typeof status === "object" && "PullingModel" in status;

interface PreviousData {
    sessions: number;
    messages: number;
    bytes: number;
    engine_present: boolean;
}

interface ImportableModels {
    count: number;
    names: string[];
    bytes: number;
}

interface FirstRunState {
    /** False on an ordinary launch and on a genuinely first run. */
    ask: boolean;
    previous: PreviousData | null;
    importable: ImportableModels | null;
}

export interface OnboardingResult {
    /** Exact name of the model just installed, so the app opens on it. */
    installed?: string;
    /** True when the user should land on an empty new chat. */
    startNewChat?: boolean;
    /**
     * Where a fresh start put the previous data. Set only on that path, and only so
     * the app can say so — a fresh start is now reversible from Settings, and nobody
     * would guess that from a screen that simply moved on.
     */
    archivedPath?: string;
}

type Phase =
    /** Working out which of the questions above still needs asking. */
    | "checking"
    /** Data from a previous install: restore it, or start fresh. */
    | "welcome"
    /** The first-model ask. */
    | "model"
    /** Engine and/or model downloading. */
    | "working"
    | "ready";

/**
 * The app's own vocabulary, not this screen's. It started out with `text-5xl`
 * semibold headings, `rounded-full` pill buttons and `#171717` — none of which
 * appear anywhere else in the app, so onboarding looked like a different product
 * and then handed you over to this one. These are the tokens the rest of the UI
 * uses: the 24px/32px hero line the chat greeting is set in, `#0A0A0A` for text
 * and fills (`#171717` survives in exactly two other places), `#525252` and
 * `#737373` for the two muted tiers, and `rounded-lg` buttons at
 * `text-sm leading-[18px]`.
 */
const HEADING = "font-normal text-[24px] leading-[32px] tracking-[-0.4px] text-fg";
const SUB = "text-sm leading-[18px] text-fg-secondary";
const DETAIL = "text-xs leading-4 text-fg-muted";
//
// `border border-transparent` on the *filled* variants is not decoration. A 1px
// border is 2px of box height, so a bordered secondary next to a border-less primary
// stands 2px taller and the pair sits a pixel out of line — measured 34px against
// 36px on the welcome screen's two buttons, and 56px against 58px on its two panels,
// whose inner text was also inset by a pixel more on one than the other. Each variant
// declares its border in full rather than inheriting a width and overriding a colour:
// two Tailwind border-colour utilities on one element resolve by stylesheet order,
// not by the order you wrote them.
const PRIMARY =
    "px-3 py-2 rounded-lg border border-transparent bg-inverse text-inverse-fg text-sm leading-[18px] transition-colors hover:bg-inverse-hover disabled:opacity-50";
const SECONDARY =
    "px-3 py-2 rounded-lg border border-line-strong text-fg text-sm leading-[18px] transition-colors hover:bg-hover disabled:opacity-50";
const PANEL = "w-full rounded-lg border border-transparent bg-surface px-3 py-2.5 flex flex-col gap-0.5 text-left";

function Screen({ children }: { children: ReactNode }) {
    return (
        // The window has no title bar of its own, so without a drag region this
        // screen cannot be moved — and it is the first thing a new install shows.
        // Tauri matches the exact event target, so only this bare background
        // drags; the buttons inside are unaffected.
        <div
            className="fixed inset-0 z-50 flex flex-col items-center justify-center px-6"
            style={{ backgroundColor: ONBOARDING_SURFACE }}
            data-tauri-drag-region
        >
            <div className="flex flex-col items-center w-full max-w-[420px] text-center gap-6">
                <Logo size={32} color="rgb(var(--fg))" />
                {children}
            </div>
        </div>
    );
}

function ProgressBar({ fraction, label }: { fraction: number; label: string }) {
    return (
        <div className="w-full max-w-[280px] flex flex-col items-center gap-2.5">
            <div className="w-full h-1 bg-line rounded-full overflow-hidden">
                <div
                    className="h-full bg-inverse transition-all duration-300"
                    style={{ width: `${Math.round(fraction * 100)}%` }}
                />
            </div>
            <p className={DETAIL}>{label}</p>
        </div>
    );
}

export default function Onboarding({ onDone }: { onDone: (result: OnboardingResult) => void }) {
    const { getOllamaStatus, startOllamaService, listModels, getRemoteModelSize } = useOllama();

    /** `undefined` while unknown — the probe below must not race the answer. */
    const [firstRun, setFirstRun] = useState<FirstRunState | null | undefined>(undefined);
    const [phase, setPhase] = useState<Phase>("checking");
    const [status, setStatus] = useState<OllamaStatus>("Checking");
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** Set once the user chooses a fresh start, which changes what follows says. */
    const [freshStart, setFreshStart] = useState(false);
    /** Exact download size, from the registry. Null when it can't be read. */
    const [modelBytes, setModelBytes] = useState<number | null>(null);
    /** Which already-installed model to open the first chat on (case 3). */
    const [pickedModel, setPickedModel] = useState<string | null>(null);

    /** Whether the engine had to be fetched too, so the bar can share itself. */
    const engineNeeded = useRef(false);
    /** onDone is a handover: it must happen once. */
    const handedOver = useRef(false);
    /** Guards the model step against being started twice by a status re-emit. */
    const modelStepStarted = useRef(false);
    /** Consecutive probes that could not reach the engine's API. */
    const failures = useRef(0);
    /** Where a fresh start put the previous data, for the handover to report. */
    const archivedPath = useRef<string | undefined>(undefined);
    /** Whether a probe has already come back empty — the render needs to know. */
    const [checking, setChecking] = useState(false);
    /**
     * The live status, for the probe to read. The probe's interval closes over the
     * render that created it, and the status it needs arrives from an event on a
     * later one.
     */
    const statusRef = useRef<OllamaStatus>("Checking");
    useEffect(() => { statusRef.current = status; }, [status]);

    const finish = (result: OnboardingResult) => {
        if (handedOver.current) return;
        handedOver.current = true;
        onDone(result);
    };

    /**
     * The last step, whichever route got here: name the model that is now
     * installed so the app opens on it rather than on whatever localStorage
     * remembers, which after a fresh start may be a model that is gone.
     */
    const handOverInstalled = async () => {
        // Retried rather than read once. One read is a single point of failure with
        // no fallback: on a first install there is no *other* chat model to fall
        // back to, so if `/api/tags` has not caught up with the pull that just
        // returned, this hands back no model at all — and App then opens the chat on
        // its hardcoded default, which names a model that was never on the machine.
        // Reasoned, not observed: whether Ollama's tags can lag its own completed
        // pull is untested here.
        let chosen: ModelSummary | undefined;
        for (let attempt = 0; attempt < 4 && !chosen; attempt++) {
            if (attempt) await new Promise(resolve => window.setTimeout(resolve, 400));
            const installed = await listModels().catch(() => [] as ModelSummary[]);
            chosen =
                installed.find(m => baseName(m.name) === FIRST_MODEL) ??
                installed.filter(canChat)[0];
        }
        setPhase("ready");
        window.setTimeout(
            () => finish({
                installed: chosen?.name,
                startNewChat: true,
                archivedPath: archivedPath.current,
            }),
            READY_MS,
        );
    };

    const { downloads, start: startPull, failure, dismissFailure } = useModelDownloads(() => {
        void handOverInstalled();
    });

    // The engine's own progress. Separate from the model's because they are
    // separate downloads reported through separate events.
    useEffect(() => {
        const unlisten = listen<OllamaStatus>("ollama-status-update", e => setStatus(e.payload));
        return () => { unlisten.then(u => u()); };
    }, []);

    useEffect(() => {
        invoke<FirstRunState>("first_run_state")
            .then(state => {
                setFirstRun(state);
                if (state.ask) setPhase("welcome");
            })
            // A detection failure must not block the app. The worst case is that
            // the question isn't asked, which leaves the previous data untouched.
            .catch(() => setFirstRun(null));
        // Asked up front, not only when a model list fails: the restore/fresh
        // branch never reaches the probe below, and without this the download step
        // would begin not knowing whether the engine is even on disk.
        getOllamaStatus().then(setStatus).catch(() => {});
        getRemoteModelSize(FIRST_MODEL).then(setModelBytes).catch(() => setModelBytes(null));
    }, []);

    /**
     * Is a model needed at all? Only answerable once the engine is answering, so
     * this polls: at launch the engine is still booting and "no models" and "not
     * up yet" look identical from here.
     */
    useEffect(() => {
        if (firstRun === undefined || phase !== "checking") return;
        let cancelled = false;

        const probe = async () => {
            try {
                // Chat-capable only: an install that is nothing but embedding
                // models would clear this screen and fail on the first message.
                const models = (await listModels()).filter(canChat);
                if (cancelled) return;
                failures.current = 0;
                if (models.length > 0) finish({});
                // The backend pulls the first model itself when it starts against
                // an empty store (`wait_for_ollama_ready`), so an empty list does
                // not mean nothing is happening. Asking for a download while that
                // one runs offered a button over a live download and then ignored
                // it when it finished — observed on this machine, in the log:
                // "No models found. Pulling 'tinyllama' as initial model…" landed
                // while the ask was on screen. Follow it instead.
                else if (enginePulling(statusRef.current)) setPhase("working");
                else setPhase("model");
            } catch {
                // Not answering yet. Find out whether it is even trying.
                const current = await getOllamaStatus().catch(() => "Stopped" as OllamaStatus);
                if (cancelled) return;
                setStatus(current);
                setChecking(true);
                // Counted FIRST, before any branch. Counting inside the branches is
                // what let an engine that keeps answering `Stopped` restart for
                // ever: that path returned early, so patience never ran out and the
                // screen oscillated between "Starting up" and a bare fill —
                // observed, three frames of it, in the preview's "failing" engine.
                const spent = ++failures.current >= PROBE_PATIENCE;

                // No binary at all: the ask covers the engine as well as the model.
                if (current === "Missing") { setPhase("model"); return; }

                // "checking" is a gate with the whole app behind it, so it must not
                // be somewhere we can stay indefinitely. The old guard could: it was
                // an overlay *inside* the shell and got out of the way whenever the
                // status read Running. Give up here instead, onto the model screen,
                // which carries the error, a retry and a way past.
                if (spent) {
                    // `Missing` has already returned above, so `Stopped` is the
                    // only "never came up" case left to distinguish here.
                    setError(current === "Stopped"
                        ? "The local engine didn't start. Retry, or continue without a model."
                        : "The local engine is running but isn't answering. Retry, or continue without a model.");
                    setPhase("model");
                    return;
                }
                if (current === "Stopped") startOllamaService(false).catch(() => {});
            }
        };

        void probe();
        const timer = window.setInterval(probe, PROBE_INTERVAL_MS);
        return () => { cancelled = true; window.clearInterval(timer); };
    }, [firstRun, phase, status]);

    /**
     * Once the engine is up, the model. It may already be there — the backend
     * pulls it itself when it starts against an empty store — in which case this
     * is just the handover.
     */
    useEffect(() => {
        if (phase !== "working" || status !== "Running" || modelStepStarted.current) return;
        modelStepStarted.current = true;
        void (async () => {
            const installed = await listModels().catch(() => [] as ModelSummary[]);
            if (installed.some(m => baseName(m.name) === FIRST_MODEL)) {
                void handOverInstalled();
            } else {
                void startPull(FIRST_MODEL);
            }
        })();
    }, [phase, status]);

    // A refused pull returns to the ask, where it can be read and retried.
    useEffect(() => {
        if (failure) setPhase("model");
    }, [failure]);

    /**
     * The engine giving up while we wait on it.
     *
     * `wait_for_ollama_ready` emits `Stopped` after 30 seconds of a server that
     * never answers, and `start_ollama_service` has long since returned `Ok` by
     * then — it returns once the process is *spawned*. Nothing here reacted to
     * that, so "working" was a terminal state: the bar sat at 0% under
     * "Preparing…" for ever, with the whole app gated behind it.
     */
    useEffect(() => {
        if (phase !== "working") return;
        if (status !== "Stopped" && status !== "Missing") return;
        modelStepStarted.current = false;
        setError("The local engine didn't start. Retry, or continue without a model.");
        setPhase("model");
    }, [phase, status]);

    // The backend starting its own pull *after* the ask was already on screen —
    // the same race as in the probe, arriving from the other direction.
    useEffect(() => {
        if (phase === "model" && enginePulling(status)) setPhase("working");
    }, [phase, status]);

    const runFirstRunChoice = async (label: string, work: () => Promise<unknown>, next: Phase) => {
        setBusy(label);
        setError(null);
        try {
            const outcome = await work();
            // `archive_previous_data` answers with the directory it created. Held so
            // the handover can tell the user where their conversations went.
            if (typeof outcome === "string") archivedPath.current = outcome;
            // Acknowledged as soon as the work lands, not when onboarding ends: the
            // data has already been archived, deleted or adopted by this point, so
            // asking again on the next launch would be asking about nothing.
            await invoke("acknowledge_first_run");
            setFirstRun(null);
            setBusy(null);
            setPhase(next);
        } catch (e) {
            setError(String(e));
            setBusy(null);
        }
    };

    /**
     * Case 3: adopt what Ollama already has, and open a chat on the chosen model.
     *
     * The capability check has to come *after* adopting. The list on that screen is a
     * scan of manifest filenames on disk (`scan_models`), which cannot say whether a
     * model can hold a conversation — only `/api/tags` reports that, and only for
     * models in this app's own store. So an embedding model is pickable, and the honest
     * place to say so is here, rather than letting the first message come back with
     * `"all-minilm" does not support chat`.
     */
    const adoptAndChat = async (name: string) => {
        setBusy("adopt");
        setError(null);
        try {
            await invoke("import_shared_models");
            await invoke("acknowledge_first_run");
            const installed = await listModels().catch(() => [] as ModelSummary[]);
            const entry = installed.find(m => m.name === name);
            if (entry && !canChat(entry)) {
                setBusy(null);
                setError(`${name} can't hold a conversation — it looks like an embedding model. Pick another, or download one.`);
                return;
            }
            setFirstRun(null);
            finish({ installed: entry?.name ?? name, startNewChat: true });
        } catch (e) {
            setError(String(e));
            setBusy(null);
        }
    };

    const install = async () => {
        setError(null);
        dismissFailure();
        modelStepStarted.current = false;
        setPhase("working");
        if (status === "Running") return; // the effect above takes it from here
        // Only a missing binary is a download. A present-but-stopped engine just
        // starts, and reserving a third of the bar for that would stall it there.
        engineNeeded.current = status === "Missing";
        try {
            // Downloads the engine when it's missing, starts it, and — against an
            // empty store — pulls the first model itself. Its status events drive
            // the rest of this screen.
            await startOllamaService(true);
        } catch (e) {
            setError(String(e));
            setPhase("model");
        }
    };

    const isDownloading = typeof status === "object" && "Downloading" in status;
    const isStarting = status === "Starting";
    const isPulling = typeof status === "object" && "PullingModel" in status;
    const engineBusy = isDownloading || isStarting || isPulling;

    const pull = downloads[FIRST_MODEL];
    // The engine's share is only reserved when the engine is actually being
    // fetched. Its own first-run pull reports through the status event, ours
    // through the pull event, so the model's fraction can come from either.
    const engineShare = engineNeeded.current ? ENGINE_SHARE : 0;
    const engineFraction = isDownloading ? status.Downloading.progress : engineBusy || status === "Running" ? 1 : 0;
    const modelFraction = isPulling
        ? status.PullingModel.progress
        : pull?.completed != null && pull.total
            ? pull.completed / pull.total
            : 0;
    const barFraction = engineShare * engineFraction + (1 - engineShare) * modelFraction;
    const barLabel = isDownloading
        ? "Downloading the engine…"
        : isStarting
            ? "Starting the engine…"
            : pull
                ? `${FIRST_MODEL} · ${describeDownload(pull, formatBytes)}`
                : isPulling
                    ? `Downloading ${FIRST_MODEL}…`
                    : "Preparing…";

    const problem = error ?? failure?.message ?? null;

    if (phase === "checking") {
        // The bare fill is for the first instant only — one call away from knowing,
        // where a flash of copy is worse than the surface the app is about to show
        // anyway. Once a probe has come back empty-handed we are *waiting*, and
        // waiting silently behind a contentless gate is the failure this screen kept
        // producing, so anything past the first attempt says so.
        if (!engineBusy && !checking) {
            return <div className="fixed inset-0 z-50" style={{ backgroundColor: ONBOARDING_SURFACE }} />;
        }
        return (
            <Screen>
                <div className="flex flex-col gap-1">
                    <h1 className={HEADING}>Starting up</h1>
                    <p className={SUB}>Getting the local engine ready.</p>
                </div>
                <ProgressBar fraction={barFraction} label={barLabel} />
            </Screen>
        );
    }

    if (phase === "welcome") {
        const { previous, importable } = firstRun ?? { previous: null, importable: null };

        // Two different people reach this screen, and they are not being asked the same
        // thing. With data from a previous install it is "restore, or start over".
        // Without it — someone new to Scarlettt who already runs Ollama — there is
        // nothing to restore and no download to wait for, only a choice of which model
        // already on the machine to open a chat on.
        if (!previous) {
            const names = importable?.names ?? [];
            const chosen = pickedModel ?? names[0];
            return (
                <Screen>
                    <div className="flex flex-col gap-1">
                        <h1 className={HEADING}>Welcome to Scarlettt</h1>
                        <p className={SUB}>
                            {names.length === 1
                                ? "There is already a model on this machine — Scarlettt can use it as it is."
                                : "There are already models on this machine. Pick one to start with."}
                        </p>
                    </div>

                    {/* Scrolls rather than growing: this is however many models the
                        user's own Ollama happens to hold, which is not a number this
                        screen gets to assume. */}
                    <div className="w-full flex flex-col gap-1 max-h-[220px] overflow-y-auto">
                        {names.map(name => (
                            <button
                                key={name}
                                disabled={!!busy}
                                onClick={() => setPickedModel(name)}
                                className={`w-full rounded-lg border px-3 py-2.5 text-left text-sm leading-[18px] text-fg transition-colors disabled:opacity-50 ${
                                    name === chosen
                                        ? "border-fg bg-surface"
                                        : "border-line hover:bg-hover"
                                }`}
                            >
                                {name}
                            </button>
                        ))}
                    </div>

                    <p className={DETAIL}>
                        {formatBytes(importable?.bytes ?? 0)} on disk, shared without copying —
                        removing a model here can't remove it from your Ollama.
                    </p>

                    {problem && <p className="text-sm leading-[18px] text-bad-fg">{problem}</p>}

                    <div className="flex items-center gap-2">
                        <button
                            className={PRIMARY}
                            disabled={!!busy || !chosen}
                            onClick={() => chosen && void adoptAndChat(chosen)}
                        >
                            {busy === "adopt" ? "Starting…" : "Start chat"}
                        </button>
                        {/* Necessary, not decorative: if every model they have is an
                            embedding model, adopting cannot give them a chat, and this
                            is the only way off the screen. */}
                        <button
                            className={SECONDARY}
                            disabled={!!busy}
                            onClick={() => {
                                setError(null);
                                setFreshStart(true);
                                void runFirstRunChoice("fresh", async () => {}, "model");
                            }}
                        >
                            Download one instead
                        </button>
                    </div>
                </Screen>
            );
        }

        return (
            <Screen>
                <div className="flex flex-col gap-1">
                    <h1 className={HEADING}>Welcome back</h1>
                    <p className={SUB}>Scarlettt found data from a previous installation.</p>
                </div>

                <div className="w-full flex flex-col gap-2">
                    <div className={PANEL}>
                        <p className="text-sm leading-[18px] text-fg">
                            {previous.sessions} {previous.sessions === 1 ? "conversation" : "conversations"}
                            {previous.messages > 0 && `, ${previous.messages} messages`}
                        </p>
                        <p className={DETAIL}>
                            {formatBytes(previous.bytes)} on disk
                            {previous.engine_present && " · engine already downloaded"}
                        </p>
                    </div>

                    {/* Reported separately because these are not ours. They live in
                        Ollama's own store and may belong to an Ollama the user
                        installed themselves, so the app offers to share them
                        rather than to take them. */}
                    {importable && (
                        <div className={`${PANEL} bg-transparent !border-dashed !border-line-strong`}>
                            <p className="text-sm leading-[18px] text-fg">
                                {importable.count} {importable.count === 1 ? "model" : "models"} already on this machine
                            </p>
                            <p className={DETAIL}>
                                {importable.names.slice(0, 3).join(", ")}
                                {importable.names.length > 3 && ` and ${importable.names.length - 3} more`}
                                {" · "}{formatBytes(importable.bytes)}, shared without copying
                            </p>
                        </div>
                    )}
                </div>

                {problem && <p className="text-sm leading-[18px] text-bad-fg">{problem}</p>}

                <div className="flex items-center gap-2">
                    <button
                        className={PRIMARY}
                        disabled={!!busy}
                        onClick={() => runFirstRunChoice(
                            "restore",
                            // Nothing to move: the data is already where the app
                            // reads it. Adopting the models is the only work, and
                            // only when there are any. Back to `checking`, which
                            // decides whether those models can actually chat.
                            async () => { if (importable) await invoke("import_shared_models"); },
                            "checking",
                        )}
                    >
                        {busy === "restore" ? "Restoring…" : "Restore everything"}
                    </button>
                    <button
                        className={SECONDARY}
                        disabled={!!busy}
                        onClick={() => {
                            setError(null);
                            setFreshStart(true);
                            // Archives, and asks nothing. There used to be a
                            // keep-or-delete follow-up here; deciding that mid-onboarding
                            // meant an irreversible click before the user had seen the
                            // app at all. It is set aside either way now, and Settings
                            // holds the decision for as long as they want.
                            void runFirstRunChoice("fresh", () => invoke("archive_previous_data"), "model");
                        }}
                    >
                        {busy === "fresh" ? "Setting aside…" : "Start fresh"}
                    </button>
                </div>

                <p className={DETAIL}>
                    Starting fresh sets your conversations aside rather than deleting them. You can
                    restore or delete them any time in Settings.
                </p>
            </Screen>
        );
    }

    if (phase === "ready") {
        return (
            <Screen>
                <div className="flex flex-col gap-1">
                    <h1 className={HEADING}>Ready</h1>
                    <p className={SUB}>Opening a new chat.</p>
                </div>
                <div className="animate-pulse flex gap-1.5">
                    <div className="h-1.5 w-1.5 bg-fg-faint rounded-full" />
                    <div className="h-1.5 w-1.5 bg-fg-faint rounded-full" />
                    <div className="h-1.5 w-1.5 bg-fg-faint rounded-full" />
                </div>
            </Screen>
        );
    }

    // "model" and "working" — the same screen, its button replaced by the bar.
    //
    // The action is named on the button and explained *under* it. It read the other
    // way round at first — an explanation above a button labelled "Start fresh" —
    // which left the button itself saying nothing about what it would do, on the one
    // screen a new install cannot skip.
    return (
        <Screen>
            <h1 className={HEADING}>{freshStart ? "Starting fresh" : "Welcome to Scarlettt"}</h1>

            {phase === "working" ? (
                <>
                    <p className={SUB}>This only happens once.</p>
                    <ProgressBar fraction={barFraction} label={barLabel} />
                </>
            ) : (
                <div className="flex flex-col items-center w-full gap-4">
                    {problem && (
                        <p className="text-sm leading-5 text-bad-fg">{problem}</p>
                    )}
                    <button className={PRIMARY} onClick={install}>
                        Download a model
                    </button>
                    <div className="flex flex-col gap-1">
                        <p className={SUB}>Download your first model to start chatting.</p>
                        {/* Kept to one line: all three clauses at once wrapped, and a
                            wrapped 12px caption under a button reads as a warning. The
                            engine clause only earns its place when there is no engine
                            to borrow, which is the only time it is a surprise. */}
                        <p className={DETAIL}>
                            {FIRST_MODEL}
                            {modelBytes ? ` · ${formatBytes(modelBytes)}` : ""}
                            {status === "Missing" ? " · with the engine" : ""}
                            {" · runs on this machine"}
                        </p>
                    </div>
                    {/* Only offered once something has actually gone wrong. The app
                        without a model is a models library and a chat that says so,
                        which beats a screen with no way past it. */}
                    {problem && (
                        <button
                            className="text-xs leading-4 text-fg-secondary transition-colors hover:text-fg"
                            // Carries `archivedPath` too. Skipping after a fresh
                            // start is exactly the path where the toast matters
                            // most: the download failed, so nothing else on screen
                            // has mentioned that their conversations were set aside,
                            // and without this they would never learn where they went.
                            onClick={() => finish({
                                startNewChat: true,
                                archivedPath: archivedPath.current,
                            })}
                        >
                            Skip for now
                        </button>
                    )}
                </div>
            )}
        </Screen>
    );
}
