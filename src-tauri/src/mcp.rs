//! MCP (Model Context Protocol) client — Scarlettt as an MCP *host*.
//!
//! The local model does not "speak MCP"; MCP is a protocol between this app (the
//! host) and MCP *servers*. This module owns the host half: it reads the server
//! config, spawns and supervises servers, lists the tools they expose, and calls
//! them. The chat loop (elsewhere) is what translates those tools into Ollama's
//! `tools`/`tool_calls` function-calling format and back — nothing here touches
//! Ollama.
//!
//! Only the **client** side of `rmcp` is used. Scarlettt is never itself an MCP
//! server, so there is no server handler, no advertised capabilities, and the unit
//! handler `()` is passed to `serve` — it declines every server-initiated request
//! (sampling, roots), which for a v1 host is the correct, minimal surface.
//!
//! ## Why the supervisor lives in Rust
//!
//! A stdio MCP server is a *child process*, and the webview has no `child_process`
//! — so local servers can only be spawned and reaped from here, exactly like the
//! bundled Ollama engine is (`ollama.rs`). This is the simpler of the two
//! supervisors: there is no "borrowed vs owned" split (we always spawn our own),
//! and no port to reclaim — an orphaned stdio server gets EOF on stdin when its
//! parent dies and well-behaved servers exit on their own. `kill_on_drop(true)` is
//! the backstop for the ones that do not.
//!
//! ## The locking rule (do not break it)
//!
//! `RunningService` is not `Clone`, but its `.peer()` handle is. Every call that
//! must `.await` (list/call) therefore clones the peer *under the lock*, drops the
//! lock, and only then awaits — so `std::sync::Mutex` (matching the rest of
//! `AppState`) is safe, because the lock is never held across an `.await`. Start
//! builds the service *before* taking the lock; shutdown drains the map *before*
//! awaiting the cancels. If you ever hold this lock across an await, you have
//! reintroduced the deadlock this shape exists to avoid.
//!
//! ## Secrets never touch the config file
//!
//! The config file (`mcp_servers.json`) holds `command`, `args`, non-secret `env`,
//! and the *names* of secret env vars — never their values. A secret's value lives
//! in the macOS Keychain and is resolved into the child's environment only at spawn
//! (`resolve_env`). So the config is safe to read back to the UI in full, and a
//! pasted config can never carry a plaintext token into a file on disk.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use rmcp::{
    ServiceExt,
    model::CallToolRequestParams,
    service::{RoleClient, RunningService},
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, ConfigureCommandExt,
        StreamableHttpClientTransport, TokioChildProcess,
    },
};
use http::header::{HeaderName, HeaderValue};

/// The live `rmcp` client for one connected server. `()` is the (empty) client
/// handler — see the module docs.
pub type McpService = RunningService<RoleClient, ()>;

/// The supervised set of running servers, keyed by the config id the user gave
/// them. Shared out of `AppState`; a plain `std::sync::Mutex` is deliberate (see
/// the locking rule above). The value is the live service directly — per-server
/// metadata (command, args, …) is read from the config file, not duplicated here.
pub type McpServers = Arc<Mutex<HashMap<String, McpService>>>;

// ---------------------------------------------------------------------------
// Config — persisted in the app data dir, secrets excluded.
// ---------------------------------------------------------------------------

fn default_true() -> bool {
    true
}

/// One server's launch spec — either **stdio** (a local child process, via
/// `command`/`args`/`env`) or **remote** (a Streamable-HTTP endpoint, via
/// `url`/`headers`). Presence of `url` selects remote; otherwise `command` selects
/// stdio. `secrets` names the values kept in the Keychain — env vars for stdio,
/// header names for remote — merged in at start.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ServerConfig {
    /// stdio: the executable. None for a remote server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    /// stdio: non-secret environment, stored inline. Secret values never live here.
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// remote: the Streamable-HTTP endpoint. None for a stdio server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// remote: non-secret HTTP headers, stored inline. Secret values never live here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
    /// Names of secret values kept in the Keychain — env var names for stdio, header
    /// names for remote — resolved at start. The value is never written to disk.
    #[serde(default)]
    pub secrets: Vec<String>,
    /// Whether the chat loop may use this server. Off does not stop a running
    /// server; it governs auto-use — starting is still explicit.
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// The whole config file: `{ "mcpServers": { "<id>": { … } } }`, matching the
/// convention other MCP hosts use so a config can be pasted across.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct McpConfig {
    #[serde(rename = "mcpServers", default)]
    pub servers: HashMap<String, ServerConfig>,
}

/// Read the config, treating a missing file as an empty config (the first-run
/// case) rather than an error — but a *malformed* file is an error, since silently
/// discarding a user's servers would be worse than refusing to load.
pub fn read_config(path: &Path) -> Result<McpConfig, String> {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s)
            .map_err(|e| format!("{} is not valid JSON: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(McpConfig::default()),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

/// Overwrite the config file (pretty-printed, since a human may open it).
pub fn write_config(path: &Path, config: &McpConfig) -> Result<(), String> {
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Could not serialize MCP config: {e}"))?;
    std::fs::write(path, json).map_err(|e| format!("Could not write {}: {e}", path.display()))
}

// ---------------------------------------------------------------------------
// Secrets — macOS Keychain, namespaced by build and by server.
// ---------------------------------------------------------------------------

// Namespaced by build the same way the data dir and engine port are, so the dev
// build cannot read the shipped build's tokens (and vice-versa). Compile-time, so
// it holds regardless of how the app was launched.
#[cfg(debug_assertions)]
const KEYCHAIN_SERVICE_PREFIX: &str = "com.scarlettt.local.mcp";
#[cfg(not(debug_assertions))]
const KEYCHAIN_SERVICE_PREFIX: &str = "com.scarlettt.mcp";

fn keychain_entry(server_id: &str, key: &str) -> Result<keyring::Entry, String> {
    // Service namespaces by server id so two servers may hold a same-named key
    // (e.g. both wanting `API_KEY`) without colliding.
    keyring::Entry::new(&format!("{KEYCHAIN_SERVICE_PREFIX}.{server_id}"), key)
        .map_err(|e| format!("Keychain unavailable for {server_id}/{key}: {e}"))
}

/// Store one secret env value. The value is never logged or returned anywhere.
pub fn set_secret(server_id: &str, key: &str, value: &str) -> Result<(), String> {
    keychain_entry(server_id, key)?
        .set_password(value)
        .map_err(|e| format!("Could not store secret '{key}' for '{server_id}': {e}"))
}

/// Read one secret, or `None` if it was never set. `None` is not an error — a
/// declared-but-unset secret is a normal state the spawn path tolerates.
pub fn get_secret(server_id: &str, key: &str) -> Result<Option<String>, String> {
    match keychain_entry(server_id, key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Could not read secret '{key}' for '{server_id}': {e}")),
    }
}

/// Delete one secret. Deleting one that isn't there is success — this runs on
/// server deletion, where idempotence matters more than a missing-key error.
pub fn delete_secret(server_id: &str, key: &str) -> Result<(), String> {
    match keychain_entry(server_id, key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Could not delete secret '{key}' for '{server_id}': {e}")),
    }
}

/// The full environment for a server: its inline (non-secret) env plus each
/// declared secret resolved from the Keychain. A declared secret with no stored
/// value is logged and skipped rather than failing the spawn — the server reports
/// for itself if it truly needs it, and that message is more useful than ours.
pub fn resolve_env(cfg: &ServerConfig, server_id: &str) -> HashMap<String, String> {
    let mut env = cfg.env.clone();
    for key in &cfg.secrets {
        match get_secret(server_id, key) {
            Ok(Some(value)) => {
                env.insert(key.clone(), value);
            }
            Ok(None) => log::warn!(
                "MCP server '{server_id}' declares secret '{key}' but no value is stored"
            ),
            Err(e) => log::warn!("MCP server '{server_id}' secret '{key}': {e}"),
        }
    }
    env
}

// ---------------------------------------------------------------------------
// Lifecycle — spawn, stop, inspect, tear down.
// ---------------------------------------------------------------------------

/// Start a stdio MCP server and register it under `id`.
///
/// The transport is built and the initialize handshake awaited *before* the map is
/// locked, so a slow-starting server never blocks callers inspecting the set. A
/// second start under a live id is refused rather than leaking the first child.
pub async fn start_server(servers: &McpServers, id: String, cfg: &ServerConfig) -> Result<(), String> {
    // Refuse before connecting — a duplicate start would orphan the first child or
    // leak the first connection, with nothing left tracking it.
    if servers.lock().unwrap().contains_key(&id) {
        return Err(format!("MCP server '{id}' is already running"));
    }

    // `url` selects remote (Streamable HTTP); otherwise `command` selects stdio.
    let service = if let Some(url) = &cfg.url {
        connect_remote(&id, url, cfg).await?
    } else if let Some(command) = &cfg.command {
        spawn_stdio(&id, command, cfg).await?
    } else {
        return Err(format!("MCP server '{id}' has neither a command nor a url"));
    };

    servers.lock().unwrap().insert(id, service);
    Ok(())
}

/// Spawn and connect a local stdio server.
async fn spawn_stdio(id: &str, command: &str, cfg: &ServerConfig) -> Result<McpService, String> {
    let env = resolve_env(cfg, id);
    let transport = TokioChildProcess::new(
        tokio::process::Command::new(command).configure(|cmd| {
            cmd.args(&cfg.args);
            for (k, v) in &env {
                cmd.env(k, v);
            }
            // A GUI-launched macOS app inherits a minimal PATH that usually lacks
            // the Homebrew/nvm locations where `npx`/`node`/`uvx` live, so a server
            // that spawns fine from a terminal fails to spawn from the packaged
            // app. Unless the config sets PATH itself, append the common tool
            // locations to the inherited PATH rather than replacing it.
            //
            // Unix only: these are Unix paths joined with ':', and Windows separates
            // PATH with ';' — appending them there would corrupt PATH. On Windows the
            // tools live on the normal PATH already, so nothing needs adding.
            #[cfg(unix)]
            if !env.contains_key("PATH") {
                let base = std::env::var("PATH").unwrap_or_default();
                let extra = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
                let joined = if base.is_empty() {
                    extra.to_string()
                } else {
                    format!("{base}:{extra}")
                };
                cmd.env("PATH", joined);
            }
            // Backstop for servers that do not exit on stdin EOF: if this app dies
            // without a clean shutdown, tokio kills the child on drop.
            cmd.kill_on_drop(true);
        }),
    )
    .map_err(|e| format!("Failed to spawn MCP server '{id}' ({command}): {e}"))?;

    // The initialize handshake runs here; a server that spawns but never speaks MCP
    // fails at this await rather than being registered as if it were ready.
    ()
        .serve(transport)
        .await
        .map_err(|e| format!("MCP server '{id}' failed to initialize: {e}"))
}

/// Connect to a remote Streamable-HTTP server. No process to supervise — the only
/// state is the connection, torn down by the same `cancel()` as a stdio service.
async fn connect_remote(id: &str, url: &str, cfg: &ServerConfig) -> Result<McpService, String> {
    // Inline headers plus any secret headers resolved from the Keychain. An invalid
    // header name/value is skipped with a warning rather than failing the connect.
    let mut custom_headers = HashMap::new();
    for (k, v) in resolve_headers(cfg, id) {
        match (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(&v)) {
            (Ok(name), Ok(value)) => {
                custom_headers.insert(name, value);
            }
            _ => log::warn!("MCP server '{id}': skipping invalid header '{k}'"),
        }
    }

    let mut config = StreamableHttpClientTransportConfig::default();
    config.uri = Arc::from(url);
    config.custom_headers = custom_headers;
    // `from_config` uses rmcp's own internal HTTP client, so this does not touch our
    // (older) reqwest — sidestepping the two-version-of-reqwest problem entirely.
    let transport = StreamableHttpClientTransport::from_config(config);

    ()
        .serve(transport)
        .await
        .map_err(|e| format!("MCP server '{id}' failed to connect ({url}): {e}"))
}

/// The HTTP headers for a remote server: its inline (non-secret) headers plus each
/// declared secret header resolved from the Keychain. Mirrors `resolve_env`.
fn resolve_headers(cfg: &ServerConfig, server_id: &str) -> HashMap<String, String> {
    let mut headers = cfg.headers.clone().unwrap_or_default();
    for key in &cfg.secrets {
        match get_secret(server_id, key) {
            Ok(Some(value)) => {
                headers.insert(key.clone(), value);
            }
            Ok(None) => log::warn!(
                "MCP server '{server_id}' declares secret header '{key}' but no value is stored"
            ),
            Err(e) => log::warn!("MCP server '{server_id}' secret '{key}': {e}"),
        }
    }
    headers
}

/// Stop one server and unregister it. A clean `cancel()` (drains the peer, then the
/// child) rather than a hard kill; unknown ids are a no-op success so teardown is
/// idempotent.
pub async fn stop_server(servers: &McpServers, id: &str) -> Result<(), String> {
    let service = servers.lock().unwrap().remove(id);
    if let Some(service) = service {
        let _ = service.cancel().await;
    }
    Ok(())
}

/// The tools one server exposes, as canonical MCP JSON (`name`, `description`,
/// `inputSchema`). Returned as serialized values on purpose: `inputSchema` maps
/// verbatim onto an Ollama tool's `function.parameters`, so handing back the wire
/// shape keeps the later Ollama-mapping layer decoupled from `rmcp`'s Rust types.
pub async fn list_tools(servers: &McpServers, id: &str) -> Result<Vec<Value>, String> {
    let peer = {
        let map = servers.lock().unwrap();
        map.get(id)
            .map(|s| s.peer().clone())
            .ok_or_else(|| format!("MCP server '{id}' is not running"))?
    };

    let tools = peer
        .list_all_tools()
        .await
        .map_err(|e| format!("Listing tools from '{id}' failed: {e}"))?;

    Ok(tools
        .iter()
        .map(|t| serde_json::to_value(t).unwrap_or(Value::Null))
        .collect())
}

/// Invoke one tool on one server. `arguments` is the object the model produced in
/// its tool call; a non-object (including `null`) is sent as no arguments. The
/// result is the serialized `CallToolResult` — `{ content: [...], isError }` — so
/// the caller can surface an `isError` back to the model without this module
/// knowing anything about the chat loop.
pub async fn call_tool(
    servers: &McpServers,
    id: &str,
    tool: &str,
    arguments: Value,
) -> Result<Value, String> {
    let peer = {
        let map = servers.lock().unwrap();
        map.get(id)
            .map(|s| s.peer().clone())
            .ok_or_else(|| format!("MCP server '{id}' is not running"))?
    };

    let params = CallToolRequestParams::new(tool.to_string());
    let params = match arguments {
        Value::Object(map) => params.with_arguments(map),
        _ => params,
    };

    let result = peer
        .call_tool(params)
        .await
        .map_err(|e| format!("Calling '{tool}' on '{id}' failed: {e}"))?;

    serde_json::to_value(result)
        .map_err(|e| format!("Could not serialize the result of '{tool}': {e}"))
}

/// The ids of every currently running server, for the Settings list and
/// diagnostics. Cheap and lock-scoped — no await.
pub fn running_ids(servers: &McpServers) -> Vec<String> {
    servers.lock().unwrap().keys().cloned().collect()
}

/// Tear down every running server. Called from the app's exit handler for the same
/// reason the Ollama child is killed there: quitting must not leave supervised
/// subprocesses behind. The map is drained under the lock, then each service is
/// cancelled outside it — never awaiting while locked.
pub async fn shutdown_all(servers: &McpServers) {
    let drained: Vec<McpService> = {
        let mut map = servers.lock().unwrap();
        map.drain().map(|(_, v)| v).collect()
    };
    for service in drained {
        let _ = service.cancel().await;
    }
}

// ---------------------------------------------------------------------------
// Ollama mapping — MCP tools <-> Ollama function-calling wire shapes.
//
// MCP and Ollama describe tools almost identically: an MCP tool's `inputSchema`
// *is* a JSON Schema, which is exactly what an Ollama function's `parameters`
// wants, so the schema crosses over verbatim. The two gaps this layer closes are
// (1) names must be globally unique across servers, so each is namespaced
// `serverid__toolname` with a reverse map back to the route, and (2) a tool
// *result* is a content array that has to be flattened to the plain text a
// `role:"tool"` message carries. Consumed by the chat tool loop in `lib.rs`.
// ---------------------------------------------------------------------------

/// Separator between server id and tool name in the function name the model sees.
/// Double underscore so an ordinary single-underscore tool name is unambiguous.
const TOOL_NAMESPACE_SEP: &str = "__";

/// Ollama function names must be identifier-ish; a server id may not be (spaces,
/// dots). Map anything outside `[A-Za-z0-9_-]` to `_`. Routing is by the reverse
/// map, not by parsing this back, so a lossy collision only costs a name, not a
/// misroute.
fn sanitize_ident(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect()
}

/// The globally-unique function name the model sees for one server's tool.
pub fn namespace_tool(server_id: &str, tool_name: &str) -> String {
    format!("{}{}{}", sanitize_ident(server_id), TOOL_NAMESPACE_SEP, tool_name)
}

/// Where a namespaced tool name routes: which server, and the tool's real name
/// there (the name to send back over MCP, un-namespaced).
pub struct ToolRoute {
    pub server_id: String,
    pub tool_name: String,
}

/// One MCP tool (as canonical MCP JSON) rendered as an Ollama function definition.
/// `inputSchema` becomes `parameters` unchanged; a tool with no schema still gets a
/// valid empty object-schema, since some models reject a tool without one.
pub fn ollama_tool_def(namespaced_name: &str, mcp_tool: &Value) -> Value {
    let mut function = serde_json::Map::new();
    function.insert("name".into(), Value::String(namespaced_name.to_string()));
    if let Some(desc) = mcp_tool.get("description").and_then(|d| d.as_str()) {
        function.insert("description".into(), Value::String(desc.to_string()));
    }
    let parameters = mcp_tool
        .get("inputSchema")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({ "type": "object", "properties": {} }));
    function.insert("parameters".into(), parameters);

    serde_json::json!({ "type": "function", "function": Value::Object(function) })
}

/// Build the Ollama `tools` array from the live tools of the given servers, plus
/// the reverse map from each namespaced function name back to its route. Servers
/// that fail to list are logged and skipped, not fatal — one broken server should
/// not deny the model every other server's tools.
pub async fn collect_tools(
    servers: &McpServers,
    ids: &[String],
) -> (Vec<Value>, HashMap<String, ToolRoute>) {
    let mut defs = Vec::new();
    let mut routes = HashMap::new();
    for id in ids {
        let tools = match list_tools(servers, id).await {
            Ok(t) => t,
            Err(e) => {
                log::warn!("Skipping tools from '{id}': {e}");
                continue;
            }
        };
        for tool in &tools {
            let Some(name) = tool.get("name").and_then(|n| n.as_str()) else {
                continue;
            };
            let namespaced = namespace_tool(id, name);
            defs.push(ollama_tool_def(&namespaced, tool));
            routes.insert(
                namespaced,
                ToolRoute { server_id: id.clone(), tool_name: name.to_string() },
            );
        }
    }
    (defs, routes)
}

/// Flatten a tool result (serialized `CallToolResult`) into the plain text a
/// `role:"tool"` message carries back to the model, plus whether it was an error.
/// Non-text content (images, resources) is named rather than dropped, so the model
/// knows something was there. The error flag is returned separately so the caller
/// can decide how to frame it — the model still sees the text either way.
pub fn flatten_tool_result(result: &Value) -> (String, bool) {
    let is_error = result.get("isError").and_then(|v| v.as_bool()).unwrap_or(false);
    let text = result
        .get("content")
        .and_then(|c| c.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| match item.get("type").and_then(|t| t.as_str()) {
                    Some("text") => item.get("text").and_then(|t| t.as_str()).map(str::to_string),
                    Some(other) => Some(format!("[{other} content omitted]")),
                    None => None,
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    (text, is_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn namespacing_sanitizes_the_server_id_only() {
        // Spaces/dots in the id become underscores; the tool name is left intact,
        // and the double-underscore separator keeps a single-underscore tool name
        // unambiguous.
        assert_eq!(namespace_tool("my server", "read_file"), "my_server__read_file");
        assert_eq!(namespace_tool("fs.local", "list"), "fs_local__list");
    }

    #[test]
    fn tool_def_maps_input_schema_to_parameters_verbatim() {
        let mcp_tool = json!({
            "name": "read_file",
            "description": "Read a file",
            "inputSchema": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }
        });
        let def = ollama_tool_def("fs__read_file", &mcp_tool);
        assert_eq!(def["type"], "function");
        assert_eq!(def["function"]["name"], "fs__read_file");
        assert_eq!(def["function"]["description"], "Read a file");
        // The schema crosses over unchanged.
        assert_eq!(def["function"]["parameters"], mcp_tool["inputSchema"]);
    }

    #[test]
    fn tool_def_supplies_an_empty_schema_when_the_tool_has_none() {
        let def = ollama_tool_def("srv__ping", &json!({ "name": "ping" }));
        assert_eq!(def["function"]["parameters"], json!({ "type": "object", "properties": {} }));
        // No description key at all rather than a null one.
        assert!(def["function"].get("description").is_none());
    }

    #[test]
    fn flatten_joins_text_and_names_non_text_content() {
        let result = json!({
            "content": [
                { "type": "text", "text": "line one" },
                { "type": "image", "data": "…", "mimeType": "image/png" },
                { "type": "text", "text": "line two" }
            ],
            "isError": false
        });
        let (text, is_error) = flatten_tool_result(&result);
        assert_eq!(text, "line one\n[image content omitted]\nline two");
        assert!(!is_error);
    }

    #[test]
    fn flatten_surfaces_the_error_flag() {
        let result = json!({ "content": [{ "type": "text", "text": "boom" }], "isError": true });
        let (text, is_error) = flatten_tool_result(&result);
        assert_eq!(text, "boom");
        assert!(is_error);
    }

    #[test]
    fn remote_and_stdio_configs_both_parse() {
        let json = r#"{"mcpServers":{
            "remote":{"url":"https://x/mcp","headers":{"X-Foo":"bar"},"secrets":["Authorization"]},
            "fs":{"command":"npx","args":["-y","srv"]}
        }}"#;
        let cfg: McpConfig = serde_json::from_str(json).unwrap();

        let remote = &cfg.servers["remote"];
        assert_eq!(remote.url.as_deref(), Some("https://x/mcp"));
        assert!(remote.command.is_none());
        assert_eq!(remote.headers.as_ref().unwrap()["X-Foo"], "bar");
        assert!(remote.enabled, "enabled defaults to true when omitted");

        let stdio = &cfg.servers["fs"];
        assert_eq!(stdio.command.as_deref(), Some("npx"));
        assert!(stdio.url.is_none());
    }

    /// Native end-to-end against a real stdio MCP server. Ignored by default (it
    /// spawns `npx` and downloads a package); run with:
    ///   cargo test --lib mcp::tests::real_stdio -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "native: spawns a real MCP server via npx"]
    async fn real_stdio_server_start_list_call() {
        use std::sync::{Arc, Mutex};
        let servers: McpServers = Arc::new(Mutex::new(HashMap::new()));
        let cfg = ServerConfig {
            command: Some("npx".to_string()),
            args: vec![
                "-y".to_string(),
                "@modelcontextprotocol/server-everything".to_string(),
            ],
            env: HashMap::new(),
            url: None,
            headers: None,
            secrets: vec![],
            enabled: true,
        };

        start_server(&servers, "everything".to_string(), &cfg)
            .await
            .expect("real server should start");

        let tools = list_tools(&servers, "everything").await.expect("list tools");
        let names: Vec<String> = tools
            .iter()
            .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(String::from))
            .collect();
        assert!(names.iter().any(|n| n == "echo"), "echo present, got {names:?}");
        assert!(names.iter().any(|n| n == "get-sum"), "get-sum present, got {names:?}");

        let echo = call_tool(&servers, "everything", "echo", serde_json::json!({ "message": "hello mcp" }))
            .await
            .expect("call echo");
        let (echo_text, echo_err) = flatten_tool_result(&echo);
        assert!(!echo_err, "echo not an error: {echo_text}");
        assert!(echo_text.contains("hello mcp"), "echo returned: {echo_text:?}");

        let sum = call_tool(&servers, "everything", "get-sum", serde_json::json!({ "a": 17, "b": 25 }))
            .await
            .expect("call get-sum");
        let (sum_text, sum_err) = flatten_tool_result(&sum);
        assert!(!sum_err, "get-sum not an error: {sum_text}");
        assert!(sum_text.contains("42"), "get-sum returned: {sum_text:?}");

        shutdown_all(&servers).await;
        assert!(running_ids(&servers).is_empty(), "server unregistered after shutdown");
    }

    /// Native: connects to a running Figma Dev Mode MCP server (Streamable HTTP on
    /// :3845) and lists its tools. Proves the remote transport against a real server.
    ///   cargo test --lib mcp::tests::real_remote_figma -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "native: needs Figma desktop with the Dev Mode MCP server running"]
    async fn real_remote_figma_connect() {
        use std::sync::{Arc, Mutex};
        let servers: McpServers = Arc::new(Mutex::new(HashMap::new()));
        let cfg = ServerConfig {
            command: None,
            args: vec![],
            env: HashMap::new(),
            url: Some("http://127.0.0.1:3845/mcp".to_string()),
            headers: None,
            secrets: vec![],
            enabled: true,
        };

        start_server(&servers, "figma".to_string(), &cfg)
            .await
            .expect("connect to Figma Dev Mode MCP server");

        let tools = list_tools(&servers, "figma").await.expect("list Figma tools");
        let names: Vec<String> = tools
            .iter()
            .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(String::from))
            .collect();
        eprintln!("Figma tools: {names:?}");
        assert!(!names.is_empty(), "Figma exposes some tools");

        shutdown_all(&servers).await;
    }
    #[test]
    fn resolve_headers_keeps_inline_and_skips_unset_secrets() {
        let cfg = ServerConfig {
            command: None,
            args: vec![],
            env: HashMap::new(),
            url: Some("https://x".to_string()),
            headers: Some(HashMap::from([("X-Foo".to_string(), "bar".to_string())])),
            // No Keychain value stored for this key under a unique test id, so it is
            // skipped (get_secret → None, or an unavailable Keychain → skipped too).
            secrets: vec!["scarlettt-test-unset-secret".to_string()],
            enabled: true,
        };
        let headers = resolve_headers(&cfg, "scarlettt-test-nonexistent-server");
        assert_eq!(headers.get("X-Foo").map(String::as_str), Some("bar"));
        assert!(!headers.contains_key("scarlettt-test-unset-secret"));
    }
}
