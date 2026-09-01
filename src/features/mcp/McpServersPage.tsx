import { useState } from "react";
import { NO_AUTOCORRECT } from "../../inputProps";
import { useMcpServers, McpConfig } from "../../hooks/useMcpServers";
import { useSettings } from "../../hooks/useSettings";
import Braces from "../../svg/Braces";

// Shown in the editor when nothing is configured yet, so the feature is usable
// cold — a working example the user edits rather than a blank box.
const TEMPLATE = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/a/folder"],
      "env": {},
      "secrets": [],
      "enabled": true
    }
  }
}`;

const CHIP = "px-2 py-0.5 rounded-full border text-xs leading-4";
const ACTION = "px-2.5 py-1 rounded-md text-xs leading-4 transition-colors bg-hover/70 text-fg hover:bg-line-strong/70 disabled:opacity-50";

/** A write-only entry for one secret env var. The value is set and forgotten — the
 *  app can never read it back, so there is nothing to pre-fill and nothing to echo. */
function SecretField({ name, onSave, onDelete }: {
    name: string;
    onSave: (key: string, value: string) => Promise<void>;
    onDelete: (key: string) => Promise<void>;
}) {
    const [value, setValue] = useState("");
    const [stored, setStored] = useState(false);
    const [busy, setBusy] = useState(false);

    const save = async () => {
        if (!value) return;
        setBusy(true);
        try {
            await onSave(name, value);
            setValue("");
            setStored(true);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex items-center gap-2 pl-11">
            <span className="flex-shrink-0 text-xs leading-4 font-mono text-fg-secondary">{name}</span>
            <input
                {...NO_AUTOCORRECT}
                type="password"
                autoComplete="off"
                value={value}
                onChange={(e) => { setValue(e.target.value); setStored(false); }}
                placeholder="value"
                className="flex-1 min-w-0 text-xs leading-4 border border-line rounded px-2 py-1 bg-card"
            />
            {stored && <span className={`${CHIP} bg-hover text-fg-secondary border-line flex-shrink-0`}>Stored</span>}
            <button onClick={save} disabled={busy || !value} className={`${ACTION} flex-shrink-0`}>Save</button>
            <button onClick={() => onDelete(name)} className={`${ACTION} flex-shrink-0`}>Remove</button>
        </div>
    );
}

/**
 * The MCP servers page — a first-class destination reached from the sidebar nav
 * (below the models library), not a Settings section. Config is edited as JSON and
 * persisted through the backend; the config's per-server `enabled` flag is the
 * single source of truth (there is no mirror in localStorage to drift against).
 */
export default function McpServersPage() {
    const { config, running, toolCounts, error, startErrors, connecting, loading, save, toggleServer, deleteServer, setSecret, deleteSecret } = useMcpServers();
    const { settings } = useSettings();

    // The editor is an *add* box, not a mirror of the whole config — you paste a
    // server (or several) and Add merges them in. It never holds the live config, so
    // it can't go stale and clobber a server you toggled or deleted meanwhile — which
    // is exactly how adding one used to drop the others. Starts on the template as a
    // worked example and resets to it after a successful add.
    const [jsonText, setJsonText] = useState<string>(TEMPLATE);
    const [parseError, setParseError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    const handleAdd = async () => {
        let parsed: McpConfig;
        try {
            parsed = JSON.parse(jsonText);
        } catch {
            setParseError("That isn't valid JSON.");
            return;
        }
        if (!parsed || typeof parsed !== "object" || typeof (parsed as McpConfig).mcpServers !== "object") {
            setParseError('Expected a { "mcpServers": { … } } object.');
            return;
        }
        if (Object.keys(parsed.mcpServers ?? {}).length === 0) {
            setParseError("No servers in that config to add.");
            return;
        }
        setParseError(null);
        setSaving(true);
        try {
            await save(parsed); // merges into the servers you already have — never replaces
            setJsonText(TEMPLATE); // ready for the next add; the ones you have show in the list below
        } catch (e) {
            setParseError(String(e));
        } finally {
            setSaving(false);
        }
    };

    const servers = Object.entries(config.mcpServers ?? {});

    return (
        <div className="flex-1 overflow-y-auto no-scrollbar" style={{ msOverflowStyle: 'none', scrollbarWidth: 'none' }}>
            <div className="max-w-[640px] mx-auto flex flex-col gap-6 px-4 py-8">
                <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                        <Braces size={16} color="rgb(var(--fg))" />
                        <h1 className="text-sm leading-[18px] text-fg">MCP servers</h1>
                    </div>
                    <p className="text-xs leading-4 text-fg-muted">
                        Tools your models can call. Connect as many as you like — each runs as its own process, and a
                        tools-capable model can use every one you turn on, asking before each call. Paste a server below
                        to add it; the ones you already have stay. Remove one with its Delete button.
                    </p>
                </div>

                {/* The config, as JSON — the same shape other MCP hosts use, so a config
                    can be pasted across. Carries secret names only, never values. */}
                <div className="flex flex-col gap-3">
                    <textarea
                        {...NO_AUTOCORRECT}
                        value={jsonText}
                        onChange={(e) => setJsonText(e.target.value)}
                        rows={10}
                        className="w-full font-mono text-xs leading-5 text-fg bg-card border border-line rounded-lg p-3 resize-y"
                    />
                    {parseError && <p className="text-xs leading-4 text-bad-fg">{parseError}</p>}
                    <button
                        onClick={handleAdd}
                        disabled={saving}
                        className="self-start relative whitespace-nowrap px-3 py-1.5 rounded-lg text-sm leading-[18px] transition-colors disabled:opacity-50 bg-inverse text-inverse-fg hover:bg-inverse-hover"
                    >
                        <span className={saving ? "invisible" : undefined}>Add server</span>
                        {saving && <span className="absolute inset-0 flex items-center justify-center">Adding…</span>}
                    </button>

                    {settings.offlineMode && (
                        <p className="text-xs leading-4 text-warn-fg">
                            Offline mode stops Scarlettt from calling out, but an MCP server is a separate process with its own
                            network access this app can't revoke — servers won't start while it's on, and one already running
                            keeps its own connections.
                        </p>
                    )}

                    {error && <p className="text-xs leading-4 text-bad-fg">{error}</p>}
                </div>

                {/* Server list — the config keys, with live status and controls. */}
                {loading ? (
                    <p className="text-xs leading-4 text-fg-muted">Loading…</p>
                ) : servers.length === 0 ? (
                    <p className="text-xs leading-4 text-fg-muted">No servers yet.</p>
                ) : (
                    <div className="flex flex-col gap-1">
                        {servers.map(([id, server]) => {
                            const isRunning = running.includes(id);
                            const isConnecting = !!connecting[id];
                            const showOn = isRunning || isConnecting; // optimistic while the attempt is in flight
                            const count = toolCounts[id];
                            return (
                                <div key={id} className="flex flex-col gap-2 p-2 rounded hover:bg-hover/70 transition-colors">
                                    <div className="flex items-center gap-2">
                                        {/* One control: on = connected. Flipping on shows "Connecting…" for a
                                            moment; if it can't connect it falls back off with a reason below. */}
                                        <button
                                            role="switch"
                                            aria-checked={isRunning}
                                            aria-busy={isConnecting || undefined}
                                            disabled={isConnecting}
                                            title={isConnecting ? "Connecting…" : isRunning ? "Connected — click to disconnect" : "Disconnected — click to connect"}
                                            onClick={() => void toggleServer(id, !isRunning)}
                                            className={`flex-shrink-0 w-9 h-5 rounded-full p-0.5 transition-colors ${showOn ? "bg-inverse" : "bg-line-strong"} ${isConnecting ? "opacity-70" : ""}`}
                                        >
                                            <span className={`block w-4 h-4 rounded-full bg-card transition-transform ${showOn ? "translate-x-4" : ""}`} />
                                        </button>
                                        {/* name + "(10 tools)" are one group at 0.2rem; the parent row's
                                            gap-2 (0.5rem) then separates that group from the badge. */}
                                        <div className="flex items-center gap-[0.2rem] min-w-0">
                                            <span className="text-sm leading-[18px] text-fg truncate min-w-0">{id}</span>
                                            {isRunning && count != null && (
                                                <span className="text-xs leading-4 text-fg-faint flex-shrink-0">
                                                    ({count} {count === 1 ? "tool" : "tools"})
                                                </span>
                                            )}
                                        </div>
                                        {isConnecting ? (
                                            <span className="text-xs leading-4 text-fg-faint flex-shrink-0 animate-pulse">Connecting…</span>
                                        ) : isRunning ? (
                                            <span className={`${CHIP} border-green-600 bg-green-600 text-white flex-shrink-0 inline-flex items-center gap-1.5`}>
                                                <span className="w-1.5 h-1.5 rounded-full bg-white" />
                                                Connected
                                            </span>
                                        ) : null}
                                        <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
                                            <button onClick={() => void deleteServer(id)} className={ACTION}>Delete</button>
                                        </div>
                                    </div>
                                    {/* Why the last connect attempt failed — in plain language, under
                                        its own row, so it's tied to the server it's about. */}
                                    {startErrors[id] && (
                                        <p className="text-xs leading-4 text-warn-fg pl-11">{startErrors[id]}</p>
                                    )}
                                    {/* One write-only field per declared secret name. */}
                                    {(server.secrets ?? []).map((name) => (
                                        <SecretField
                                            key={name}
                                            name={name}
                                            onSave={(key, value) => setSecret(id, key, value)}
                                            onDelete={(key) => deleteSecret(id, key)}
                                        />
                                    ))}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
