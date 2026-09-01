import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";

/**
 * The MCP-server config and live state, owned in one hook so SettingsPage never
 * imports `invoke` (matching useOllamaRuntime/usePreviousData). The config file is
 * the single source of truth for which servers exist and which are enabled; secret
 * *values* never pass through here — only their names, in `secrets`.
 */

export interface McpServerConfig {
    /** stdio: the executable. Absent for a remote (url) server. */
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    /** remote: a Streamable-HTTP endpoint. Absent for a stdio server. */
    url?: string;
    /** remote: non-secret HTTP headers. */
    headers?: Record<string, string>;
    /** Secret names whose values live in the Keychain — env vars for stdio, header
     *  names for remote. */
    secrets?: string[];
    enabled?: boolean;
}

export interface McpConfig {
    mcpServers: Record<string, McpServerConfig>;
}

// Trust-on-first-use: a server's first *start* for a given command+args is
// confirmed once, then remembered. Re-arms when the spec changes (a new command or
// args means new code), which is why the value is a hash of exactly those.
const TRUST_KEY = "scarlettt_mcp_trusted";

function specHash(server: McpServerConfig): string {
    // Re-arms trust when the thing that actually runs/connects changes.
    return server.url ? `url:${server.url}` : `${server.command} ${(server.args ?? []).join(" ")}`;
}

function loadTrust(): Record<string, string> {
    try {
        return JSON.parse(localStorage.getItem(TRUST_KEY) || "{}");
    } catch {
        return {};
    }
}

function isTrusted(id: string, server: McpServerConfig): boolean {
    return loadTrust()[id] === specHash(server);
}

function rememberTrust(id: string, server: McpServerConfig): void {
    const trusted = loadTrust();
    trusted[id] = specHash(server);
    try {
        localStorage.setItem(TRUST_KEY, JSON.stringify(trusted));
    } catch {
        /* storage full / disabled — worst case the prompt shows again */
    }
}

/** The confirm shown before a server's first start: the exact program that runs,
 *  its arguments, non-secret env, and which values come from the Keychain (names
 *  only — the app cannot read them back). Informs; it does not sandbox. */
function trustBody(server: McpServerConfig): string {
    const secrets = server.secrets ?? [];

    // Remote: what endpoint, and what headers go to it.
    if (server.url) {
        const lines = [
            "This connects to a server over the network and can send your requests to it.",
            "",
            "URL:",
            `  ${server.url}`,
        ];
        const headers = Object.entries(server.headers ?? {});
        if (headers.length || secrets.length) {
            lines.push("", "Headers:");
            for (const [k, v] of headers) lines.push(`  ${k}: ${v}`);
            for (const key of secrets) lines.push(`  ${key}: from Keychain`);
        }
        return lines.join("\n");
    }

    // Stdio: what program runs, with what arguments and environment.
    const lines = [
        "This starts a program on your machine. It can read files and reach the network.",
        "",
        "Command:",
        `  ${server.command}`,
    ];
    for (const arg of server.args ?? []) lines.push(`  ${arg}`);
    const env = Object.entries(server.env ?? {});
    if (env.length || secrets.length) {
        lines.push("", "Environment:");
        for (const [k, v] of env) lines.push(`  ${k}=${v}`);
        for (const key of secrets) lines.push(`  ${key} → from Keychain`);
    }
    return lines.join("\n");
}

/** Turn a raw backend start/connect error into one plain sentence a person can act on,
 *  shown under the server's own row. The backend reason ("tcp connect error: Connection
 *  refused (os error 61)") tells a user nothing to do; this says what went wrong and what
 *  to try next, and names Figma's Dev Mode server specially since it's the common case. */
function friendlyStartError(raw: string, id: string, server: McpServerConfig): string {
    const msg = raw.toLowerCase();
    const isFigma = id.toLowerCase() === "figma" || (server.url ?? "").includes("3845");

    // Offline mode refuses the start before any connection is attempted.
    if (msg.includes("offline mode is on")) {
        return "Offline mode is on, so Scarlettt won’t start MCP servers. Turn it off in Settings, then try again.";
    }
    // Remote server: the connection was refused — nothing is listening there yet.
    if (server.url && (msg.includes("refused") || msg.includes("failed to connect") ||
        msg.includes("trying to connect") || msg.includes("tcp connect") ||
        msg.includes("connect error") || msg.includes("dns") || msg.includes("no route"))) {
        return isFigma
            ? "Can’t reach Figma. Open the Figma desktop app, turn on Preferences → Enable Dev Mode MCP Server, and open a design file — then try again."
            : `Can’t reach the server at ${server.url}. Make sure it’s running, then try again.`;
    }
    // Remote server: reachable but slow or silent.
    if (server.url && (msg.includes("timed out") || msg.includes("timeout"))) {
        return isFigma
            ? "Figma didn’t respond in time. Make sure a design file is open in the desktop app, then try again."
            : `The server at ${server.url} didn’t respond in time. Try again in a moment.`;
    }
    // Local (stdio) server: the program couldn’t be launched.
    if (msg.includes("failed to spawn") || msg.includes("no such file") ||
        msg.includes("not found") || msg.includes("permission denied")) {
        const cmd = server.command ? `“${server.command}”` : "the command";
        return `Couldn’t run ${cmd}. Check it’s installed and correct in the config, then try again.`;
    }
    // Started, but never completed the MCP handshake.
    if (msg.includes("failed to initialize")) {
        return "The server started but didn’t respond correctly. Check its command and arguments in the config.";
    }
    // Misconfigured entry.
    if (msg.includes("neither a command nor a url")) {
        return "This server has no command or URL set. Add one in the config above, then try again.";
    }
    // Already connected — benign, but say so plainly.
    if (msg.includes("already running")) {
        return "This server is already connected.";
    }
    // Anything unrecognized: still lead with plain language, keep a short reason.
    const tail = raw.replace(`MCP server '${id}' `, "").trim();
    return server.url ? `Couldn’t connect. ${tail}` : `Couldn’t start. ${tail}`;
}

/** Drop one key from a record without mutating it (unused-var-safe, unlike destructuring). */
function withoutKey<T>(obj: Record<string, T>, key: string): Record<string, T> {
    if (!(key in obj)) return obj;
    const next = { ...obj };
    delete next[key];
    return next;
}

/** The toggle shows "Connecting…" for at least this long before revealing the result,
 *  so an instant refusal still reads as an attempt the app made, not a dead click. */
const MIN_CONNECTING_MS = 2000;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function useMcpServers() {
    const [config, setConfig] = useState<McpConfig>({ mcpServers: {} });
    const [running, setRunning] = useState<string[]>([]);
    const [toolCounts, setToolCounts] = useState<Record<string, number>>({});
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    // Per-row start/connect failures, in plain language, keyed by server id. Separate
    // from `error` (config read/write problems) so each shows under its own server row.
    const [startErrors, setStartErrors] = useState<Record<string, string>>({});
    // Servers mid-attempt: while true the row shows the toggle on and "Connecting…".
    const [connecting, setConnecting] = useState<Record<string, boolean>>({});

    const refresh = useCallback(async () => {
        try {
            const [cfg, run] = await Promise.all([
                invoke<McpConfig>("mcp_read_config"),
                invoke<string[]>("mcp_running_servers"),
            ]);
            setConfig(cfg?.mcpServers ? cfg : { mcpServers: {} });
            setRunning(run);
            // Tool counts only for running servers — a stopped one can't be listed.
            const counts: Record<string, number> = {};
            await Promise.all(
                run.map(async (id) => {
                    try {
                        const tools = await invoke<unknown[]>("mcp_list_tools", { id });
                        counts[id] = tools.length;
                    } catch {
                        /* a server that can't list tools just shows no count */
                    }
                }),
            );
            setToolCounts(counts);
            setError(null);
        } catch (e) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    // Auto-connect on launch: once the config has loaded, reconnect every server the
    // user left on (`enabled`) that is already trusted — silently, no prompt, since a
    // first connect is what earns trust. Runs once. This is what makes "on" survive a
    // restart even though the running set itself does not.
    const autoConnectedRef = useRef(false);
    useEffect(() => {
        if (autoConnectedRef.current || loading) return;
        autoConnectedRef.current = true;
        const toStart = Object.entries(config.mcpServers ?? {})
            .filter(([id, s]) => s.enabled !== false && !running.includes(id) && isTrusted(id, s))
            .map(([id]) => id);
        if (toStart.length === 0) return;
        void (async () => {
            await Promise.all(toStart.map((id) => invoke("mcp_start_server", { id }).catch(() => {})));
            await refresh();
        })();
    }, [loading, config, running, refresh]);

    // Running state is a snapshot; refresh it when the window regains focus and
    // whenever a tool event fires (a send just used, or failed to use, a server).
    useEffect(() => {
        const onFocus = () => void refresh();
        const onToolEvent = () => void refresh();
        window.addEventListener("focus", onFocus);
        window.addEventListener("scarlettt:settings-changed", onFocus);
        return () => {
            window.removeEventListener("focus", onFocus);
            window.removeEventListener("scarlettt:settings-changed", onToolEvent);
        };
    }, [refresh]);

    /** Merge servers from the editor into the saved config — never replace. Adding a
     *  server must not drop the others: the editor is usually handed a single-server
     *  snippet (that's how MCP configs are shared), and writing it straight wiped
     *  everything else. Existing servers are kept; a pasted id updates that one.
     *  Removal is the row's Delete button, not deletion from this text. Reads the
     *  current config fresh so a stale editor can't revert a toggle or a delete.
     *  Returns the merged result. */
    const save = useCallback(async (parsed: McpConfig): Promise<McpConfig> => {
        const current = await invoke<McpConfig>("mcp_read_config").catch(() => ({ mcpServers: {} }));
        const merged: McpConfig = {
            mcpServers: { ...(current.mcpServers ?? {}), ...(parsed.mcpServers ?? {}) },
        };
        await invoke("mcp_write_config", { config: merged });
        await refresh();
        return merged;
    }, [refresh]);

    /** Start a server, gated by trust-on-first-use. While it tries, the row shows the
     *  toggle on and "Connecting…" for at least MIN_CONNECTING_MS; on failure the toggle
     *  falls back off and a plain-language reason appears under the row. Returns whether
     *  it connected, so the toggle can persist the real outcome. */
    const startServer = useCallback(async (id: string): Promise<boolean> => {
        const server = config.mcpServers?.[id];
        if (!server) return false;
        if (!isTrusted(id, server)) {
            const title = server.url ? `Connect to “${id}”?` : `Start “${id}”?`;
            const ok = await ask(trustBody(server), { title, kind: "warning" });
            if (!ok) return false;
            rememberTrust(id, server);
        }
        setStartErrors(prev => withoutKey(prev, id));      // clear any prior reason
        setConnecting(prev => ({ ...prev, [id]: true }));  // toggle on + "Connecting…"
        const started = Date.now();
        let failure: string | null = null;
        try {
            await invoke("mcp_start_server", { id });
        } catch (e) {
            // The attempt is where the real error surfaces; translate it to plain words.
            failure = friendlyStartError(String(e), id, server);
        }
        // Hold "Connecting…" to a floor so an instant refusal still reads as an attempt.
        const elapsed = Date.now() - started;
        if (elapsed < MIN_CONNECTING_MS) await delay(MIN_CONNECTING_MS - elapsed);
        if (failure) {
            const reason = failure;
            setStartErrors(prev => ({ ...prev, [id]: reason }));
        }
        setConnecting(prev => withoutKey(prev, id));       // reveal the result (off + reason, or on)
        await refresh();
        return failure === null;
    }, [config, refresh]);

    const stopServer = useCallback(async (id: string) => {
        try {
            await invoke("mcp_stop_server", { id });
            setStartErrors(prev => withoutKey(prev, id)); // stopped cleanly — drop any stale reason
        } catch (e) {
            setError(String(e));
        }
        await refresh();
    }, [refresh]);

    /** The one control per server: on connects (start, with the trust prompt on
     *  first use), off disconnects (stop). "Running" *is* "on". The choice is also
     *  persisted as `enabled`, so an on server reconnects on the next launch. */
    const toggleServer = useCallback(async (id: string, on: boolean) => {
        // Run the attempt first — startServer shows "Connecting…" and returns whether it
        // actually connected. Turning off always succeeds.
        let connected = false;
        if (on) {
            connected = await startServer(id);
        } else {
            await stopServer(id);
        }
        // Persist what actually happened, not what was asked: a server reconnects on the
        // next launch only if it truly connected, and a failed attempt (which fell the
        // toggle back off) leaves the config off to match.
        try {
            const cfg = await invoke<McpConfig>("mcp_read_config");
            if (cfg.mcpServers?.[id] && cfg.mcpServers[id].enabled !== connected) {
                cfg.mcpServers[id].enabled = connected;
                await invoke("mcp_write_config", { config: cfg });
            }
        } catch {
            /* persisting intent is best-effort */
        }
    }, [startServer, stopServer]);

    /** Delete a server: stop it, drop it from the config, purge its secrets. */
    const deleteServer = useCallback(async (id: string) => {
        const ok = await ask(
            `Remove “${id}” and any secrets stored for it? This can't be undone.`,
            { title: `Delete “${id}”?`, kind: "warning" },
        );
        if (!ok) return;
        try {
            await invoke("mcp_delete_server", { id });
        } catch (e) {
            setError(String(e));
        }
        await refresh();
    }, [refresh]);

    /** Store a secret value in the Keychain. Write-only: never read back. */
    const setSecret = useCallback(async (id: string, key: string, value: string) => {
        await invoke("mcp_set_secret", { id, key, value });
    }, []);

    const deleteSecret = useCallback(async (id: string, key: string) => {
        await invoke("mcp_delete_secret", { id, key });
    }, []);

    return {
        config,
        running,
        toolCounts,
        error,
        startErrors,
        connecting,
        loading,
        refresh,
        save,
        toggleServer,
        startServer,
        stopServer,
        deleteServer,
        setSecret,
        deleteSecret,
    };
}
