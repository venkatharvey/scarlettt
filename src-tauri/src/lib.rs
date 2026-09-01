mod ollama;
mod first_run;
mod database;
mod system;
mod vector_store;
mod mcp;

use ollama::{ChatMessage, list_models as ollama_list_models, ModelSummary, pull_model as ollama_pull_model, search_remote_models as ollama_search_remote_models, remote_model_size as ollama_remote_model_size, delete_model as ollama_delete_model, RemoteModel, OllamaStatus, is_ollama_running, find_ollama_binary, start_ollama_process, stop_ollama_on_port, verify_ollama_signature, check_ollama_integrity as ollama_check_integrity, OllamaIntegrity, download_ollama, is_ollama_outdated, running_ollama_version, is_version_outdated, latest_ollama_version, OllamaRuntime, ollama_binary_version, list_installed_models as ollama_list_installed_models, InstalledModel, list_loaded_models as ollama_list_loaded_models, LoadedModel, get_model_details as ollama_get_model_details, ModelDetails, get_remote_model_page as ollama_get_remote_model_page, RemoteModelPage, set_offline as ollama_set_offline, is_offline as ollama_is_offline, OFFLINE_ERROR};
use database::{Database, ChatSession, Message, Project, SearchResult};
use std::sync::{Mutex, Arc};
use std::process::Child;
use tauri::{State, Manager, Emitter};
use log::{info, debug, error, warn};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// A tool call waiting on the user, keyed by its one-time `call_id`. The tool loop
/// parks a `oneshot` sender here and awaits the receiver; `mcp_approve_tool` takes
/// the sender out and fires the decision. Lives in `AppState`, not in the loop's
/// stack, so an approval can be delivered even if the page that showed it unmounted.
type McpPendingApprovals = Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<ToolDecision>>>>;

/// Namespaced tool names the user chose to allow for the rest of this app run
/// ("allow for session"). Checked before asking, so an approved tool is not
/// re-prompted turn after turn. In memory only — cleared on restart, deliberately.
type McpAllowlist = Arc<Mutex<HashSet<String>>>;

struct AppState {
    db: Arc<Mutex<Database>>,
    ollama_process: Arc<Mutex<Option<Child>>>,
    ollama_status: Arc<Mutex<OllamaStatus>>,
    current_downloads: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    /// Cancel flags for replies still generating, keyed by `stream_id` — the same
    /// id the token events carry, so stopping targets one reply even when another
    /// chat is generating at the same time.
    active_streams: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    /// Connected MCP servers, keyed by config id. Spawned and reaped like the
    /// Ollama child (see the exit handler in `run`); the model calls their tools
    /// through the chat loop. See `mcp.rs`.
    mcp_servers: mcp::McpServers,
    /// Tool calls parked awaiting the user's decision, keyed by `call_id`.
    mcp_pending_approvals: McpPendingApprovals,
    /// Tools the user allowed for the session, so they are not re-prompted.
    mcp_tool_allowlist: McpAllowlist,
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    info!("greet called with name: {}", name);
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Tokens and completion are broadcast on one global channel, so every payload
/// carries the id of the request that produced it. Without that, a second chat
/// started while the first is still generating would have both responses land in
/// both listeners and interleave into each other.
#[derive(Clone, serde::Serialize)]
struct ChatTokenEvent {
    stream_id: String,
    token: String,
}

#[derive(Clone, serde::Serialize)]
struct ChatDoneEvent {
    stream_id: String,
    #[serde(flatten)]
    stats: ollama::ChatStats,
}

/// Raised before a tool runs, when it is not already allowed for the session. The
/// loop then blocks on the matching `mcp_approve_tool`. Shares the reply's
/// `stream_id` so the UI can attach the prompt to the right conversation, and
/// carries a unique `call_id` that the decision is keyed on.
#[derive(Clone, serde::Serialize)]
struct ChatToolCallEvent {
    stream_id: String,
    call_id: String,
    /// The namespaced name the model called (`serverid__tool`).
    tool: String,
    /// The server id and the server-local tool name, for a friendlier prompt.
    server: String,
    tool_name: String,
    /// The arguments the model produced — shown so the user approves the *actual*
    /// call, not just the tool in the abstract.
    arguments: serde_json::Value,
    /// Whether the loop is blocking on the user for this call. False when the tool
    /// was already allowed for the session, so the UI shows it as running rather
    /// than flashing approval buttons that resolve themselves a moment later.
    needs_approval: bool,
}

/// Raised after a tool call resolves — run, denied, timed out, or cancelled — so
/// the UI can show the outcome in the transcript. `decision` records how it was
/// resolved (`allow-once` / `allow-session` / `auto` / `deny`).
#[derive(Clone, serde::Serialize)]
struct ChatToolResultEvent {
    stream_id: String,
    call_id: String,
    tool: String,
    is_error: bool,
    content: String,
    decision: String,
}

/// What the user chose for a pending tool call. Deserialized from the string the
/// frontend sends (`allow-once` / `allow-session` / `deny`).
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ToolDecision {
    /// Run it this once; ask again next time.
    AllowOnce,
    /// Run it, and stop asking for this tool for the rest of the session.
    AllowSession,
    /// Do not run it; the model is told it was declined.
    Deny,
}

/// A small model that keeps calling tools without ever answering is a real failure
/// mode; the tool loop is bounded so it always terminates.
const MAX_TOOL_TURNS: usize = 8;

/// A single tool call that hangs must not wedge the whole reply. Past this it is
/// abandoned and reported back to the model as an error it can react to.
const TOOL_CALL_TIMEOUT: Duration = Duration::from_secs(60);

/// Resolves once the cancel flag is set. The flag has no notifier, so this polls it
/// — used only to race a long-running tool call, where 100ms of latency on a Stop
/// is imperceptible.
async fn poll_cancel(cancel: &Arc<AtomicBool>) {
    while !cancel.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Sum a turn's stats into the running total. Across a tool loop this reports the
/// *total* work done — generated tokens, evaluated prompt tokens, wall-clock —
/// rather than only the last turn's, since every turn was a real request.
fn accumulate_stats(agg: &mut ollama::ChatStats, turn: &ollama::ChatStats) {
    fn add64(a: &mut Option<u64>, b: Option<u64>) {
        if let Some(v) = b {
            *a = Some(a.unwrap_or(0) + v);
        }
    }
    fn add32(a: &mut Option<u32>, b: Option<u32>) {
        if let Some(v) = b {
            *a = Some(a.unwrap_or(0) + v);
        }
    }
    add64(&mut agg.total_duration, turn.total_duration);
    add32(&mut agg.prompt_eval_count, turn.prompt_eval_count);
    add32(&mut agg.eval_count, turn.eval_count);
}

/// Run one tool call: route it, bound it by a timeout, and race it against a Stop.
/// Every failure path — unknown tool, MCP error, timeout, cancel — returns text
/// plus `is_error = true`, because the model is fed the result either way and a
/// *described* failure lets it recover where a silent one strands it.
async fn execute_tool_call(
    servers: &mcp::McpServers,
    routes: &HashMap<String, mcp::ToolRoute>,
    namespaced: &str,
    arguments: serde_json::Value,
    cancel: &Arc<AtomicBool>,
) -> (String, bool) {
    let Some(route) = routes.get(namespaced) else {
        return (format!("No tool named '{namespaced}' is available"), true);
    };
    let call = mcp::call_tool(servers, &route.server_id, &route.tool_name, arguments);
    tokio::select! {
        outcome = tokio::time::timeout(TOOL_CALL_TIMEOUT, call) => match outcome {
            Ok(Ok(result)) => mcp::flatten_tool_result(&result),
            Ok(Err(e)) => (format!("Tool call failed: {e}"), true),
            Err(_) => (
                format!("Tool '{}' timed out after {}s", route.tool_name, TOOL_CALL_TIMEOUT.as_secs()),
                true,
            ),
        },
        _ = poll_cancel(cancel) => ("Tool call cancelled".to_string(), true),
    }
}

/// How long a tool call waits for the user before it is treated as declined. Long
/// enough to read a prompt and decide; bounded so a missed event (the page that
/// showed the prompt unmounted, say) can never wedge the reply forever. This is the
/// mandatory deny-on-timeout: the loop must not be able to block indefinitely.
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);

/// Everything the tool loop needs beyond the chat request itself — the app handle
/// for events, the stream id they hang off, and the MCP/approval machinery. Bundled
/// so the loop's own signature stays about the chat.
struct ToolLoop<'a, R: tauri::Runtime> {
    app: &'a tauri::AppHandle<R>,
    stream_id: &'a str,
    servers: &'a mcp::McpServers,
    routes: &'a HashMap<String, mcp::ToolRoute>,
    pending: &'a McpPendingApprovals,
    allowlist: &'a McpAllowlist,
    cancel: &'a Arc<AtomicBool>,
}

/// Park a pending approval and wait for the decision, or deny.
///
/// The sender lives in `AppState` (not this stack frame) so the decision can arrive
/// even after the page that raised the prompt unmounted. Three things resolve it: a
/// real decision via `mcp_approve_tool`, the timeout, or the user pressing Stop —
/// the last two both deny, because a tool the user never approved must not run. The
/// registry entry is always cleaned up, whichever fires.
async fn await_approval(
    pending: &McpPendingApprovals,
    call_id: &str,
    cancel: &Arc<AtomicBool>,
    timeout: Duration,
) -> ToolDecision {
    let (tx, rx) = tokio::sync::oneshot::channel();
    pending.lock().unwrap().insert(call_id.to_string(), tx);

    let decision = tokio::select! {
        received = tokio::time::timeout(timeout, rx) => match received {
            Ok(Ok(decision)) => decision,
            // Sender dropped without sending, or the wait elapsed — either way the
            // user did not approve, so deny.
            Ok(Err(_)) | Err(_) => ToolDecision::Deny,
        },
        // Stop pressed while we were waiting: deny the pending call and unwind.
        _ = poll_cancel(cancel) => ToolDecision::Deny,
    };

    // Idempotent: if `mcp_approve_tool` already took the sender, this is a no-op.
    pending.lock().unwrap().remove(call_id);
    decision
}

/// Approve (or not), run, and report one tool call. Returns the text to hand back
/// to the model as the `role:"tool"` result — every path yields text, because the
/// model is fed a result whether the call ran, was declined, or failed.
async fn run_one_tool_call<R: tauri::Runtime>(
    ctx: &ToolLoop<'_, R>,
    namespaced: &str,
    arguments: serde_json::Value,
) -> String {
    // Covers the one window the send-time gate cannot: offline switched on *after*
    // this send began, while the model was mid-generation. Refuse without prompting
    // — there is nothing to approve for a tool that will not run.
    if ollama_is_offline() {
        warn!("MCP tool '{namespaced}' blocked: offline mode is on");
        return "Offline mode is on, so this tool was not run.".to_string();
    }

    let call_id = uuid::Uuid::new_v4().to_string();
    let route = ctx.routes.get(namespaced);
    let tool_name = route.map(|r| r.tool_name.clone()).unwrap_or_else(|| namespaced.to_string());
    let server = route.map(|r| r.server_id.clone()).unwrap_or_default();

    // Already allowed for the session → run without prompting.
    let pre_approved = ctx.allowlist.lock().unwrap().contains(namespaced);

    // Always announce the call, with its arguments, so the UI can show what ran.
    // Only calls that are not pre-approved block for a decision.
    let _ = ctx.app.emit(
        "chat-tool-call",
        ChatToolCallEvent {
            stream_id: ctx.stream_id.to_string(),
            call_id: call_id.clone(),
            tool: namespaced.to_string(),
            server,
            tool_name: tool_name.clone(),
            arguments: arguments.clone(),
            needs_approval: !pre_approved,
        },
    );
    let decision = if pre_approved {
        ToolDecision::AllowSession
    } else {
        await_approval(ctx.pending, &call_id, ctx.cancel, APPROVAL_TIMEOUT).await
    };

    let (text, is_error, label) = match decision {
        ToolDecision::Deny => ("The user declined to run this tool.".to_string(), true, "deny"),
        ToolDecision::AllowOnce | ToolDecision::AllowSession => {
            if decision == ToolDecision::AllowSession {
                ctx.allowlist.lock().unwrap().insert(namespaced.to_string());
            }
            let (text, is_error) =
                execute_tool_call(ctx.servers, ctx.routes, namespaced, arguments, ctx.cancel).await;
            let label = if pre_approved {
                "auto"
            } else if decision == ToolDecision::AllowSession {
                "allow-session"
            } else {
                "allow-once"
            };
            (text, is_error, label)
        }
    };

    // Length only, never the content — a tool result may carry sensitive data.
    if is_error {
        warn!("MCP tool '{}' [{}]: {}", namespaced, label, text);
    } else {
        info!("MCP tool '{}' [{}] ran ({} bytes)", namespaced, label, text.len());
    }

    let _ = ctx.app.emit(
        "chat-tool-result",
        ChatToolResultEvent {
            stream_id: ctx.stream_id.to_string(),
            call_id,
            tool: namespaced.to_string(),
            is_error,
            content: text.clone(),
            decision: label.to_string(),
        },
    );

    text
}

/// The bounded multi-turn tool loop, and the reason it lives here rather than in
/// `ollama.rs`: this is the one place both the Ollama primitive (`chat_turn`) and
/// the MCP client are in scope, so `ollama` need not depend on `mcp`.
///
/// Each turn streams the reply via `on_token`. If the model asked for tools, each
/// is approved (or auto-allowed), run, and the loop turns again with the results
/// appended, up to `MAX_TOOL_TURNS`. `num_ctx` and `keep_alive` ride on *every* turn
/// (Ollama resets its idle timer per request), and the cancel flag is checked
/// between turns and during each tool call and approval. Stats are summed.
async fn run_chat_with_tools<R, F>(
    ctx: &ToolLoop<'_, R>,
    model: &str,
    messages: &mut Vec<ChatMessage>,
    tools: &[serde_json::Value],
    num_ctx: u32,
    keep_alive: i64,
    on_token: &F,
) -> Result<Option<ollama::ChatStats>, String>
where
    R: tauri::Runtime,
    F: Fn(String) + Send + Sync,
{
    let mut agg = ollama::ChatStats::default();
    let mut have_stats = false;

    for _turn in 0..MAX_TOOL_TURNS {
        if ctx.cancel.load(Ordering::Relaxed) {
            return Ok(have_stats.then_some(agg));
        }

        let outcome =
            ollama::chat_turn(model, messages, tools, num_ctx, keep_alive, ctx.cancel, on_token).await?;
        if let Some(stats) = outcome.stats {
            accumulate_stats(&mut agg, &stats);
            have_stats = true;
        }

        // No tool calls means this turn is the final answer — done.
        if outcome.tool_calls.is_empty() {
            return Ok(have_stats.then_some(agg));
        }

        // Record the assistant turn — its text and the calls it made — so the model
        // sees its own request when it is called again with the results.
        messages.push(ChatMessage {
            role: "assistant".to_string(),
            content: outcome.content,
            tool_calls: outcome.tool_calls.clone(),
            tool_name: None,
        });

        for call in &outcome.tool_calls {
            if ctx.cancel.load(Ordering::Relaxed) {
                return Ok(have_stats.then_some(agg));
            }
            let text = run_one_tool_call(ctx, &call.function.name, call.function.arguments.clone()).await;
            // Ollama pairs a result with its call by the name the model emitted, so
            // `tool_name` is the namespaced name, not the server's local one.
            messages.push(ChatMessage {
                role: "tool".to_string(),
                content: text,
                tool_calls: Vec::new(),
                tool_name: Some(call.function.name.clone()),
            });
        }
    }

    warn!("MCP tool loop hit the {MAX_TOOL_TURNS}-turn cap; returning the last turn as-is");
    Ok(have_stats.then_some(agg))
}

#[tauri::command]
async fn send_chat_message<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    model: String,
    mut messages: Vec<ChatMessage>,
    // Required. The frontend derives this from the machine and the model; there
    // is deliberately no path where Ollama's 4096 default applies instead.
    num_ctx: u32,
    // Also required, and for the same reason — see `ChatRequestRef::keep_alive`.
    keep_alive: i64,
    stream_id: String,
    // Servers whose tools this send may use. Absent or empty → a plain chat with no
    // tools, byte-identical to before MCP existed. The frontend does not pass this
    // yet, so the tool loop stays dormant until it does.
    enabled_servers: Option<Vec<String>>,
) -> Result<(), String> {
    // Offline mode disables tool-calling wholesale: the tools are simply not
    // advertised, so the send is exactly a plain chat. Chat itself keeps working
    // offline because localhost Ollama traffic is deliberately allowed.
    let requested = enabled_servers.unwrap_or_default();
    let ids = if ollama_is_offline() {
        if !requested.is_empty() {
            info!("Offline mode is on; {} MCP server(s) suppressed for this send", requested.len());
        }
        Vec::new()
    } else {
        requested
    };
    info!(
        "send_chat_message called for model: {} (num_ctx: {}, keep_alive: {}s, {} MCP server(s))",
        model, num_ctx, keep_alive, ids.len()
    );

    let app_handle = app.clone();
    let token_id = stream_id.clone();
    let on_token = move |token: String| {
        let _ = app_handle.emit(
            "chat-token",
            ChatTokenEvent { stream_id: token_id.clone(), token },
        );
    };

    let cancel = Arc::new(AtomicBool::new(false));
    // The approval registry and session allowlist are cloned out of state up front
    // so nothing borrows `State` across an await.
    let (servers, pending, allowlist) = {
        let state = app.state::<AppState>();
        state.active_streams.lock().unwrap().insert(stream_id.clone(), cancel.clone());
        (
            state.mcp_servers.clone(),
            state.mcp_pending_approvals.clone(),
            state.mcp_tool_allowlist.clone(),
        )
    };

    // Build the tool set for this send from the enabled servers' live tools. Empty
    // ids skip MCP entirely, so the request is exactly a plain chat.
    let (tools, routes) = if ids.is_empty() {
        (Vec::new(), HashMap::new())
    } else {
        mcp::collect_tools(&servers, &ids).await
    };

    // When tools are present, prepend a system nudge — small models tend to
    // describe their limits instead of calling a tool, and nothing else tells them
    // otherwise (there is no system prompt on a plain chat). Added only for the
    // model call; never stored. Skipped if the caller already set a system message.
    if !tools.is_empty() && messages.first().map(|m| m.role != "system").unwrap_or(true) {
        messages.insert(0, ChatMessage {
            role: "system".to_string(),
            content: "You are connected to tools, listed for you. You CAN reach external systems \
                and take actions through those tools — do not claim you cannot when a matching tool \
                exists. When a request needs live data, an external file or app, or an action, call \
                the relevant tool first (using any URL, id, or path from the request), then reply \
                based on what it returns. Never answer that you lack access or integration if a \
                tool for it is available — call it instead of describing your limitations."
                .to_string(),
            tool_calls: Vec::new(),
            tool_name: None,
        });
    }

    let ctx = ToolLoop {
        app: &app,
        stream_id: &stream_id,
        servers: &servers,
        routes: &routes,
        pending: &pending,
        allowlist: &allowlist,
        cancel: &cancel,
    };
    let result =
        run_chat_with_tools(&ctx, &model, &mut messages, &tools, num_ctx, keep_alive, &on_token).await;

    // Deregistered before the `?`, so a failed reply doesn't leave a flag behind
    // that a later stop would find and act on.
    if let Ok(mut streams) = app.state::<AppState>().active_streams.lock() {
        streams.remove(&stream_id);
    }
    // Logged before it is propagated. A failed send used to return its reason
    // straight across IPC and nowhere else, so the log recorded the request going
    // out and then simply nothing — leaving no way to tell an engine that died from
    // a model that cannot chat from a malformed request.
    let stats = match result {
        Ok(stats) => stats,
        Err(message) => {
            error!("send_chat_message failed: {}", message);
            return Err(message);
        }
    };
    // Carries the generation stats, summed across every turn of the tool loop.
    let _ = app.emit(
        "chat-done",
        ChatDoneEvent { stream_id, stats: stats.unwrap_or_default() },
    );
    Ok(())
}

/// Ends a reply that's still generating.
///
/// Keyed by `stream_id` rather than by session, matching the token events: two
/// chats can be generating at once, and stopping one must not touch the other.
/// A missing id is not an error — the reply finished between the click and this
/// call, which is a race the user can't see and shouldn't be told about.
#[tauri::command]
fn stop_chat_message(state: State<AppState>, stream_id: String) -> Result<(), String> {
    let streams = state.active_streams.lock().map_err(|e| e.to_string())?;
    match streams.get(&stream_id) {
        Some(signal) => {
            signal.store(true, Ordering::Relaxed);
            info!("Stop requested for stream {}", stream_id);
        }
        None => info!("No active stream {} to stop", stream_id),
    }
    Ok(())
}

#[tauri::command]
async fn list_ollama_models() -> Result<Vec<ModelSummary>, String> {
    info!("list_ollama_models called");
    ollama_list_models().await
}

#[tauri::command]
async fn list_installed_models() -> Result<Vec<InstalledModel>, String> {
    info!("list_installed_models called");
    ollama_list_installed_models().await
}

#[tauri::command]
async fn get_model_details(model: String) -> Result<Option<ModelDetails>, String> {
    debug!("get_model_details called for {}", model);
    ollama_get_model_details(model).await
}

/// Polled by the UI, so this logs at debug — info would flood the log.
#[tauri::command]
async fn list_loaded_models() -> Result<Vec<LoadedModel>, String> {
    debug!("list_loaded_models called");
    ollama_list_loaded_models().await
}

#[tauri::command]
async fn get_remote_model_page(name: String) -> Result<Option<RemoteModelPage>, String> {
    info!("get_remote_model_page called for {}", name);
    ollama_get_remote_model_page(name).await
}

/// Offline mode is applied in Rust, not the UI, so a component that forgets to
/// check it still can't reach the network.
/// Describes the Ollama actually in use, so Settings can show it and decide
/// whether an update is something this app may perform.
#[tauri::command]
async fn get_ollama_runtime(app: tauri::AppHandle) -> Result<OllamaRuntime, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let binary = find_ollama_binary(app_dir.clone());

    // Prefer the running server's version — an orphan or a user-started instance
    // may not be the binary we'd find on disk.
    let version = match running_ollama_version().await {
        Some(v) => Some(v),
        None => binary.as_ref().and_then(|p| ollama_binary_version(p)),
    };

    Ok(OllamaRuntime {
        version: version.map(|(a, b, c)| format!("{}.{}.{}", a, b, c)),
        path: binary.as_ref().map(|p| p.to_string_lossy().to_string()),
        managed_by_app: binary.as_ref().map(|p| p.starts_with(&app_dir)).unwrap_or(false),
        outdated: version.map(is_version_outdated).unwrap_or(false),
        latest: None,
    })
}

/// Replaces the app-managed Ollama with the current release: stops the server,
/// removes the binary, then reuses the first-run download path to fetch and
/// start a new one. Refuses when the binary isn't ours to replace.
#[tauri::command]
async fn update_ollama(app: tauri::AppHandle) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let binary = find_ollama_binary(app_dir.clone());

    match binary.as_ref() {
        Some(path) if path.starts_with(&app_dir) => {
            info!("Updating app-managed Ollama at {:?}", path);
            // Stop our child first — the running server keeps serving the old
            // version regardless of what's on disk.
            if let Ok(mut process) = app.state::<AppState>().ollama_process.lock() {
                if let Some(mut child) = process.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
            std::fs::remove_file(path).map_err(|e| format!("Could not remove Ollama: {}", e))?;
        }
        Some(path) => {
            return Err(format!(
                "Ollama at {} was installed outside this app, so it isn't ours to update. Update it the way you installed it.",
                path.to_string_lossy()
            ));
        }
        None => {}
    }

    start_ollama_service_internal(app, true, false).await?;

    // Assert the postcondition, not the attempt. This removed the old binary
    // before fetching a new one, so a failure here leaves the user with no Ollama
    // at all — the case where claiming success is most damaging.
    match running_ollama_version().await {
        Some(v) if !is_version_outdated(v) => Ok(()),
        Some((a, b, c)) => Err(format!(
            "Ollama restarted at {}.{}.{}, which is still too old for the model registry.",
            a, b, c
        )),
        None => Err("Ollama was replaced but isn't responding. Restart Scarlettt to try again.".into()),
    }
}

/// Installs Ollama into this app's own data directory and switches to it, so the
/// app stops depending on whatever the user happens to have on PATH.
///
/// The opposite of `update_ollama`, which refuses when the binary isn't ours —
/// here it *isn't* ours yet, and that's the reason to run. The user's own install
/// is never touched or removed: `find_ollama_binary` checks the app data
/// directory before falling through to PATH, so a copy landing there simply takes
/// precedence from then on.
#[tauri::command]
async fn install_managed_ollama(app: tauri::AppHandle) -> Result<(), String> {
    // The download is an outbound request, so offline mode refuses it here rather
    // than letting it reach the network.
    if ollama_is_offline() {
        return Err(OFFLINE_ERROR.to_string());
    }

    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    info!("Installing app-managed Ollama into {:?}", app_dir);

    // Stop the server we started. It holds the port, and while it's up
    // `start_ollama_service_internal` returns early and downloads nothing — the
    // running process is only ever the one we spawned, never the user's own app.
    if let Ok(mut process) = app.state::<AppState>().ollama_process.lock() {
        if let Some(mut child) = process.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    // ...and the untracked case: a server this app started in a previous run is
    // orphaned to launchd, so it survives the line above and keeps the port.
    stop_ollama_on_port();

    start_ollama_service_internal(app, true, true).await?;

    // Report the outcome rather than the attempt. The first version of this
    // returned Ok while silently downloading nothing, which reads as success in
    // the UI and leaves the user clicking a button that does nothing.
    let binary = find_ollama_binary(app_dir.clone());
    match binary.as_ref() {
        Some(path) if path.starts_with(&app_dir) => Ok(()),
        _ => Err("Installed Ollama, but the app is still using the copy on PATH. Restart Scarlettt and try again.".into()),
    }
}

/// Reports the managed binary's signature state. Never blocks and never deletes —
/// see `OllamaIntegrity` for why this is a report rather than a gate.
#[tauri::command]
fn check_ollama_integrity(app: tauri::AppHandle) -> Result<OllamaIntegrity, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(ollama_check_integrity(app_dir))
}

#[tauri::command]
async fn check_ollama_update() -> Result<String, String> {
    info!("check_ollama_update called");
    latest_ollama_version().await
}

/// The app's own version, so Settings can show it without a network check.
#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
async fn set_offline_mode(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    ollama_set_offline(enabled);
    if enabled {
        // The flag alone stops *new* work, but a server already running holds its
        // own open sockets that the flag cannot touch. Stopping the servers is the
        // only thing that actually ends their egress — this is the piece the model
        // pull precedent never needed, because a pull is one request, not a
        // long-lived child.
        let servers = state.mcp_servers.clone();
        mcp::shutdown_all(&servers).await;
    }
    Ok(())
}

#[tauri::command]
fn get_offline_mode() -> bool {
    ollama_is_offline()
}

#[tauri::command]
fn get_system_info() -> system::SystemInfo {
    system::get_system_info()
}

/// Polled by the UI so Auto tracks memory as it frees up. Cheap by design.
#[tauri::command]
fn get_available_memory() -> u64 {
    system::get_available_memory()
}

#[tauri::command]
fn get_user_name() -> Option<String> {
    system::get_user_name()
}

#[derive(serde::Serialize, Clone)]
struct PullProgressPayload {
    model: String,
    #[serde(flatten)]
    progress: ollama::PullResponse,
}

#[tauri::command]
async fn pull_ollama_model<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    model: String,
) -> Result<(), String> {
    info!("pull_ollama_model called for model: {}", model);
    // The fetch happens inside the Ollama subprocess, which we can't restrict —
    // so offline mode refuses here, before Ollama is ever asked.
    if ollama_is_offline() {
        return Err(OFFLINE_ERROR.to_string());
    }
    let model_clone = model.clone();
    
    // Create cancellation token
    let abort_signal = Arc::new(AtomicBool::new(false));
    {
        let mut downloads = state.current_downloads.lock().map_err(|e| e.to_string())?;
        downloads.insert(model.clone(), abort_signal.clone());
    }

    let result = ollama_pull_model(model.clone(), Some(abort_signal), move |progress| {
        let _ = app.emit("ollama-pull-progress", PullProgressPayload {
            model: model_clone.clone(),
            progress,
        });
    })
    .await;

    // Cleanup cancellation token
    {
        if let Ok(mut downloads) = state.current_downloads.lock() {
            downloads.remove(&model);
        }
    }

    result
}

#[tauri::command]
async fn get_remote_model_details(name: String) -> Result<Option<ollama::RemoteModel>, String> {
    ollama::get_remote_model_details(name).await
}

#[tauri::command]
async fn cancel_ollama_model(
    state: State<'_, AppState>,
    model: String,
) -> Result<(), String> {
    info!("cancel_ollama_model called for model: {}", model);
    let downloads = state.current_downloads.lock().map_err(|e| e.to_string())?;
    
    if let Some(signal) = downloads.get(&model) {
        signal.store(true, Ordering::Relaxed);
        info!("Cancellation signal sent for model: {}", model);
    } else {
        info!("No active download found for model: {} to cancel", model);
    }
    
    Ok(())
}

/// Whether to put the restore-or-fresh question to the user, and what it involves.
///
/// Disabled in debug builds: `cargo build` rewrites the executable, so its ctime
/// changes on every rebuild and the prompt would fire on each one. That does mean
/// testing it needs the packaged app, or a hand-written marker.
/// A development switch read from the environment.
///
/// `var_os(..).is_some()` is the obvious spelling and the wrong one: it is true for
/// `SCARLETTT_FORCE_FIRST_RUN=` — an empty assignment, which is what you write when
/// you mean *off* — so exporting it empty silently turned the switch on.
fn dev_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|value| !matches!(value.trim(), "" | "0" | "false" | "no"))
        .unwrap_or(false)
}

#[tauri::command]
fn first_run_state(app: tauri::AppHandle) -> Result<first_run::FirstRunState, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let shared = app.path().home_dir().map_err(|e| e.to_string())?.join(".ollama").join("models");
    Ok(first_run::evaluate(
        &app_dir,
        &shared,
        &app.package_info().version.to_string(),
        // Release builds only: `cargo build` rewrites the executable, so its ctime
        // changes on every rebuild and the question would be asked on each one.
        // `SCARLETTT_FORCE_FIRST_RUN=1` overrides that, because otherwise this
        // screen cannot be seen in `tauri dev` at all — it went unobserved in a
        // real build for exactly that reason. Same purpose as
        // `scripts/fresh-run.sh`: make the first-run paths reachable on a machine
        // that has been used for development.
        !cfg!(debug_assertions) || dev_flag("SCARLETTT_FORCE_FIRST_RUN"),
    ))
}

/// Records that the question has been answered, so it is asked once per install.
#[tauri::command]
fn acknowledge_first_run(app: tauri::AppHandle) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    first_run::acknowledge(&app_dir, &app.package_info().version.to_string())
}

/// Keeps the previous data, renamed aside, so it can be recovered by hand.
#[tauri::command]
fn archive_previous_data(app: tauri::AppHandle) -> Result<String, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let archived = first_run::archive(&app_dir)?;
    reopen_database(&app, &app_dir)?;
    Ok(archived.to_string_lossy().to_string())
}

/// Deletes the previous data. Never touches `~/.ollama` — that store is Ollama's,
/// and may belong to an install this app knows nothing about.
#[tauri::command]
fn discard_previous_data(app: tauri::AppHandle) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    first_run::discard(&app_dir)?;
    reopen_database(&app, &app_dir)
}

/// Re-open the chat database after the file behind it has been moved or deleted.
///
/// `AppState.db` holds one `Connection`, opened once at startup (see `Database::new`)
/// and never re-opened, so "start fresh" left the app holding a handle to a file that
/// is no longer at that path. Reproduced against the same SQLite build rusqlite links,
/// in the same `journal_mode=delete` the live database reports, for **both** the rename
/// and the delete:
///
/// - reads keep succeeding and keep returning the OLD conversations, so the sidebar
///   still lists the chats the user just cleared;
/// - **every** write fails, permanently, with `attempt to write a readonly database` —
///   not the first one, all of them — so the first message sent after starting fresh
///   is lost and no new chat can be created;
/// - nothing lands in the archived file either, so the writes are not merely
///   misdirected, they are gone.
///
/// Only quitting and relaunching cleared it, which is why this went unnoticed: the
/// old flow stopped at the prompt, while onboarding now carries straight on into a
/// new chat — the one place those writes were always going to happen.
fn reopen_database(app: &tauri::AppHandle, app_dir: &std::path::Path) -> Result<(), String> {
    let fresh = Database::new(app_dir.join("scarlettt.db"))
        .map_err(|e| format!("Could not re-open the chat database: {}", e))?;
    let state = app.state::<AppState>();
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    *db = fresh;
    info!("Re-opened the chat database after a fresh start");
    Ok(())
}

/// Every set of data "start fresh" has put aside, newest first, for Settings to
/// offer back. Archives are siblings of the app data dir and nothing records where
/// they went, so they are found by name.
#[tauri::command]
fn list_previous_data(app: tauri::AppHandle) -> Result<Vec<first_run::ArchivedData>, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(first_run::list_archives(&app_dir))
}

/// Merges **every** archive's conversations into the live database, returning
/// `(sessions, messages)` added.
///
/// One action rather than one per archive. Each fresh start writes its own timestamped
/// set aside, so someone who reinstalls a few times accumulates several — and being
/// asked which of three sets to bring back is a question about this app's filing
/// rather than about their conversations. They are merged oldest first, so that where
/// two sets hold the same row the older copy wins: the newer archive was created
/// *from* the older one, and `INSERT OR IGNORE` keeps whatever landed first.
///
/// A merge, not a swap: the archives are left exactly where they are, so restoring
/// destroys nothing. It also means the database file is never moved, so — unlike
/// `archive_previous_data` and `discard_previous_data` — there is no connection to
/// re-open here. Restoring twice adds nothing the second time.
#[tauri::command]
fn restore_previous_data(app: tauri::AppHandle) -> Result<(u32, u32), String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let databases = first_run::archived_databases(&app_dir);
    if databases.is_empty() {
        return Err("There are no set-aside conversations to restore".into());
    }
    let state = app.state::<AppState>();
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let (mut sessions, mut messages) = (0u32, 0u32);
    for archived in &databases {
        let (s, m) = db.merge_from(archived).map_err(|e| e.to_string())?;
        sessions += s;
        messages += m;
    }
    info!(
        "Restored {} sessions and {} messages from {} archived set(s)",
        sessions, messages, databases.len()
    );
    Ok((sessions, messages))
}

/// Deletes every archive. Note this is the opposite of `discard_previous_data`, which
/// despite the similar name deletes the *live* data — the two must not be confused.
#[tauri::command]
fn delete_previous_data(app: tauri::AppHandle) -> Result<u32, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    first_run::delete_archives(&app_dir)
}

/// Adopts models already on the machine by hardlinking their blobs: no download, no
/// second copy on disk, and deleting one here cannot remove the other app's model.
#[tauri::command]
fn import_shared_models(app: tauri::AppHandle) -> Result<(u32, u64, bool), String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let shared = app.path().home_dir().map_err(|e| e.to_string())?.join(".ollama").join("models");
    first_run::import_models(&shared, &app_dir.join("models"))
}

#[tauri::command]
async fn get_remote_model_size(name: String) -> Result<Option<u64>, String> {
    debug!("get_remote_model_size called for {}", name);
    ollama_remote_model_size(name).await
}

#[tauri::command]
async fn search_remote_ollama_models(query: String, sort: Option<String>) -> Result<Vec<RemoteModel>, String> {
    info!("search_remote_ollama_models called with query: {} sort: {:?}", query, sort);
    ollama_search_remote_models(query, sort).await
}

#[tauri::command]
async fn delete_ollama_model(model: String) -> Result<(), String> {
    info!("delete_ollama_model called for model: {}", model);
    ollama_delete_model(model).await
}

#[tauri::command]
async fn get_ollama_status(state: State<'_, AppState>) -> Result<OllamaStatus, String> {
    if is_ollama_running() {
        return Ok(OllamaStatus::Running);
    }
    let status = state.ollama_status.lock().map_err(|e| e.to_string())?;
    Ok(status.clone())
}

#[tauri::command]
async fn start_ollama_service(
    app: tauri::AppHandle,
    download_if_missing: Option<bool>,
) -> Result<(), String> {
    start_ollama_service_internal(app, download_if_missing.unwrap_or(false), false).await
}

async fn wait_for_ollama_ready(app_handle: tauri::AppHandle) {
    info!("Waiting for the engine to be ready on port {}...", ollama::port());
    
    // Set status to Starting if not already running
    if let Ok(mut status) = app_handle.state::<AppState>().ollama_status.lock() {
        if !matches!(*status, OllamaStatus::Running) {
            *status = OllamaStatus::Starting;
            let _ = app_handle.emit("ollama-status-update", OllamaStatus::Starting);
        }
    }

    let mut check_count = 0;
    while check_count < 60 { // Up to 30 seconds
        debug!("Checking Ollama connection (attempt {})...", check_count + 1);
        if is_ollama_running() {
            info!("Ollama is ready and responding!");
            
            // Check for models
            match ollama_list_models().await {
                Ok(models) => {
                    if models.is_empty() {
                        info!("No models found. Pulling 'tinyllama' as initial model...");
                        // IMMEDIATELY set status to PullingModel to avoid flicker
                        if let Ok(mut status) = app_handle.state::<AppState>().ollama_status.lock() {
                            let new_status = OllamaStatus::PullingModel { progress: 0.0 };
                            *status = new_status.clone();
                            let _ = app_handle.emit("ollama-status-update", new_status);
                        }
                        
                        let app_handle_pull = app_handle.clone();
                        tauri::async_runtime::spawn(async move {
                            let app_handle_inner = app_handle_pull.clone();
                            // Track maximum progress to ensure monotonic increase
                            let max_progress = std::sync::Arc::new(std::sync::Mutex::new(0.0_f64));
                            let max_progress_clone = max_progress.clone();
                            
                            // Initial auto-pull, no cancellation support needed (or pass None)
                            let res = ollama_pull_model("tinyllama".to_string(), Option::<std::sync::Arc<std::sync::atomic::AtomicBool>>::None, move |progress| {
                                // Only calculate progress for download phases (when total/completed are present)
                                let p = if let (Some(total), Some(completed)) = (progress.total, progress.completed) {
                                    if total > 0 {
                                        completed as f64 / total as f64
                                    } else {
                                        0.0
                                    }
                                } else {
                                    // Status messages without progress (like "verifying", "success")
                                    // Don't update the bar, keep current max
                                    if let Ok(guard) = max_progress_clone.lock() {
                                        *guard
                                    } else {
                                        0.0
                                    }
                                };
                                
                                // Only update if progress increased
                                let should_update = {
                                    if let Ok(mut guard) = max_progress_clone.lock() {
                                        if p > *guard {
                                            *guard = p;
                                            true
                                        } else {
                                            false
                                        }
                                    } else {
                                        false
                                    }
                                };
                                
                                if should_update {
                                    if let Ok(mut status) = app_handle_inner.state::<AppState>().ollama_status.lock() {
                                        let new_status = OllamaStatus::PullingModel { progress: p };
                                        *status = new_status.clone();
                                        let _ = app_handle_inner.emit("ollama-status-update", new_status);
                                    }
                                }
                            }).await;

                            if let Err(e) = res {
                                error!("Failed to pull initial model: {}", e);
                            }
                            
                            // Final status after pull attempts (success or fail, we go to Running if service is up)
                            if let Ok(mut status) = app_handle_pull.state::<AppState>().ollama_status.lock() {
                                *status = OllamaStatus::Running;
                                let _ = app_handle_pull.emit("ollama-status-update", OllamaStatus::Running);
                            }
                        });
                        return; // Spawned pull task handles the rest
                    }
                }
                Err(e) => {
                    error!("Failed to check models after ready: {}", e);
                }
            }

            if let Ok(mut status) = app_handle.state::<AppState>().ollama_status.lock() {
                *status = OllamaStatus::Running;
                let _ = app_handle.emit("ollama-status-update", OllamaStatus::Running);
            }
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        check_count += 1;
    }
    error!("Ollama failed to start within 30 seconds. Giving up.");
    if let Ok(mut status) = app_handle.state::<AppState>().ollama_status.lock() {
        *status = OllamaStatus::Stopped;
        let _ = app_handle.emit("ollama-status-update", OllamaStatus::Stopped);
    }
}

// Internal function to perform the actual start and monitor
fn start_ollama_internal(app: &tauri::AppHandle) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let binary_path = find_ollama_binary(app_dir.clone());

    if let Some(path) = binary_path {
        let state = app.state::<AppState>();
        {
            let mut status = state.ollama_status.lock().map_err(|e| e.to_string())?;
            *status = OllamaStatus::Starting;
            let _ = app.emit("ollama-status-update", OllamaStatus::Starting);
        }
        
        // Start process, against this app's own model store rather than the one
        // shared with a user's own Ollama.
        let child = start_ollama_process(path, app_dir.join("models"))?;
        {
            let mut process = state.ollama_process.lock().map_err(|e| e.to_string())?;
            *process = Some(child);
        }
        
        // Wait for ready in background
        let app_handle = app.clone();
        tauri::async_runtime::spawn(wait_for_ollama_ready(app_handle));
        
        Ok(())
    } else {
        Err("Ollama binary not found".to_string())
    }
}

/// `force_managed` makes only a binary under the app's own data directory count
/// as usable, so a perfectly good Ollama on PATH is deliberately ignored and a
/// managed copy is downloaded instead. That's the difference between "make chat
/// work somehow" (false) and "stop depending on the user's install" (true).
/// Model identities in our own store, read from its manifest tree without a server —
/// each `model:tag`, with namespace and registry dropped so it lines up with however
/// `/api/tags` formats a name. Used to tell whether an engine already on our port is
/// serving our store or another build's.
fn store_model_keys(models_dir: &std::path::Path) -> HashSet<String> {
    fn walk(dir: &std::path::Path, keys: &mut HashSet<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, keys);
            } else if let (Some(tag), Some(model)) = (
                path.file_name().and_then(|s| s.to_str()),
                path.parent().and_then(|d| d.file_name()).and_then(|s| s.to_str()),
            ) {
                keys.insert(format!("{model}:{tag}"));
            }
        }
    }
    let mut keys = HashSet::new();
    walk(&models_dir.join("manifests"), &mut keys);
    keys
}

async fn start_ollama_service_internal(
    app: tauri::AppHandle,
    download_if_missing: bool,
    force_managed: bool,
) -> Result<(), String> {
    // `force_managed` deliberately ignores an already-running server. The whole
    // point is to replace what's running, and an orphan from a previous run
    // otherwise makes this return success having done nothing at all.
    if !force_managed && is_ollama_running() {
        // The engine already on our port is almost certainly a Scarlettt engine
        // orphaned by a previous run (the user's own Ollama uses its own port). But it
        // may be serving a DIFFERENT store — another build's engine left on this port —
        // and adopting it then serves the wrong models (measured: a dev app spent a whole
        // run serving the shipped build's store). Restart it only when it clearly serves
        // models our store doesn't have; on any doubt, adopt, so a correct engine is
        // never needlessly bounced.
        let wrong_store = match ollama_list_models().await {
            Ok(list) => {
                let models_dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("models");
                let ours = store_model_keys(&models_dir);
                let engine: HashSet<String> = list
                    .iter()
                    .filter_map(|m| m.name.rsplit('/').next().map(str::to_string))
                    .collect();
                !engine.is_empty() && ours.is_disjoint(&engine)
            }
            Err(_) => false, // can't read the model list — don't disrupt a running engine
        };
        if wrong_store {
            warn!(
                "The engine on port {} is serving a different model store; restarting it on ours.",
                ollama::port()
            );
            stop_ollama_on_port();
            // fall through to start our own on our store, below.
        } else {
            // Warn if it's too old, since the binary check below won't be reached.
            if let Some(version) = running_ollama_version().await {
                if is_version_outdated(version) {
                    warn!(
                        "Ollama {:?} is already running and is too old for the model registry. \
                         Quit it so the app can install a current version.",
                        version
                    );
                }
            }
            return Ok(());
        }
    }

    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let binary_path = find_ollama_binary(app_dir.clone());

    // A binary that's too old for the registry is as good as absent: it starts
    // fine but silently fails to pull anything recent, which is far more
    // confusing than not having one at all.
    let usable = binary_path
        .as_ref()
        .map(|path| (!force_managed || path.starts_with(&app_dir)) && !is_ollama_outdated(path))
        .unwrap_or(false);

    if let (Some(path), false) = (binary_path.as_ref(), usable) {
        // Only replace what we installed ourselves — a system Ollama on PATH
        // belongs to the user, not to this app.
        if path.starts_with(&app_dir) {
            info!("Removing outdated bundled Ollama at {:?}", path);
            let _ = std::fs::remove_file(path);
        } else {
            warn!("Ollama at {:?} is outdated, but it isn't ours to replace", path);
        }
    }

    if usable {
        start_ollama_internal(&app)
    } else if download_if_missing {
        {
            let state = app.state::<AppState>();
            let mut status = state.ollama_status.lock().map_err(|e| e.to_string())?;
            *status = OllamaStatus::Downloading { progress: 0.0 };
        }

        let app_handle = app.clone();
        let app_dir_clone = app_dir.clone();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

        // Awaited, not fire-and-forget. Spawning this and returning immediately is
        // what made a failed install report success: the error surfaced inside a
        // detached task long after the command had already answered `Ok`. The
        // progress pump below still runs concurrently, so the UI keeps updating.
        let verify_dir = app_dir_clone.clone();
        let outcome = async move {
            download_ollama(app_dir_clone, move |p| {
                let _ = tx.send(p);
            })
            .await?;

            // Verified before the first execution, not after. Only our own copy is
            // checked — `find_ollama_binary` falls through to PATH, and a system
            // Ollama is the user's to sign however they like.
            if let Some(path) = find_ollama_binary(verify_dir.clone()) {
                if path.starts_with(&verify_dir) {
                    if let Err(e) = verify_ollama_signature(&path) {
                        // Don't leave an executable we refused to trust on disk,
                        // or the next launch would find it and run it unchecked.
                        let _ = std::fs::remove_file(&path);
                        error!("{}", e);
                        return Err(e);
                    }
                }
            }

            info!("Ollama download and extraction complete. Starting service...");
            start_ollama_internal(&app_handle)
        };

        // Progress pump — still its own task so the bar moves while we wait.
        let app_handle_progress = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(p) = rx.recv().await {
                if let Ok(mut status) = app_handle_progress.state::<AppState>().ollama_status.lock() {
                    let new_status = OllamaStatus::Downloading { progress: p };
                    *status = new_status.clone();
                    let _ = app_handle_progress.emit("ollama-status-update", new_status);
                }
            }
        });

        // The caller now learns what actually happened. On failure the status is
        // set to Missing here rather than inside a detached task, so the UI and the
        // returned error agree instead of one silently contradicting the other.
        match outcome.await {
            Ok(()) => Ok(()),
            Err(e) => {
                error!("Failed to install Ollama: {}", e);
                if let Ok(mut status) = app.state::<AppState>().ollama_status.lock() {
                    *status = OllamaStatus::Missing;
                    let _ = app.emit("ollama-status-update", OllamaStatus::Missing);
                }
                Err(e)
            }
        }
    } else {
        if let Ok(mut status) = app.state::<AppState>().ollama_status.lock() {
            *status = OllamaStatus::Missing;
            let _ = app.emit("ollama-status-update", OllamaStatus::Missing);
        }
        Err("No usable Ollama is installed, and this call was told not to download one.".into())
    }
}

// Chat storage commands
#[tauri::command]
fn create_chat_session(state: State<AppState>, title: Option<String>) -> Result<ChatSession, String> {
    info!("create_chat_session called");
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.create_session(title).map_err(|e| e.to_string())
}

/// Fixes the context and model a chat's replies were generated under. A no-op if
/// the session already has one — see `Database::record_session_context`.
#[tauri::command]
fn record_session_context(
    state: State<AppState>,
    session_id: String,
    num_ctx: u32,
    model: String,
) -> Result<(), String> {
    debug!("record_session_context: {} -> {} @ {}", session_id, num_ctx, model);
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.record_session_context(&session_id, num_ctx, &model).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_chat_sessions(state: State<AppState>) -> Result<Vec<ChatSession>, String> {
    debug!("get_chat_sessions called");
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_sessions().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_chat_messages(state: State<AppState>, session_id: String) -> Result<Vec<Message>, String> {
    debug!("get_chat_messages called for session: {}", session_id);
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_messages(&session_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_message(
    state: State<'_, AppState>,
    session_id: String,
    role: String,
    content: String,
    duration_ms: Option<u64>,
    prompt_tokens: Option<u32>,
    eval_tokens: Option<u32>,
    // Tool activity for an assistant turn that called MCP tools; absent for every
    // other message. Populated by the frontend from the tool events.
    tool_calls: Option<serde_json::Value>,
) -> Result<Message, String> {
    info!("save_message called for session: {}", session_id);
    // Save to SQLite
    let message = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.save_message(&session_id, &role, &content, duration_ms, prompt_tokens, eval_tokens, tool_calls.as_ref())
            .map_err(|e| e.to_string())?
    };

    // Embed the message for semantic search, in the background so the save returns
    // immediately. Best-effort: if the embedding model isn't installed yet the message
    // stays unembedded and the backfill picks it up once it is. Skipped entirely when
    // semantic search is off — the message stays unembedded until it's turned on, and
    // the backfill that toggling on triggers catches everything written while it was.
    if vector_store::is_enabled() && !content.trim().is_empty() {
        let db = state.db.clone();
        let (mid, sid, text) = (message.id.clone(), session_id.clone(), content.clone());
        tauri::async_runtime::spawn(async move {
            if let Ok(vec) = ollama::embed(vector_store::EMBEDDING_MODEL, &text).await {
                if let Ok(db) = db.lock() {
                    let _ = db.save_embedding(&mid, &sid, vector_store::EMBEDDING_MODEL, &vec);
                }
            }
        });
    }

    Ok(message)
}

#[tauri::command]
fn rename_chat_session(state: State<AppState>, session_id: String, title: String) -> Result<(), String> {
    info!("rename_chat_session called for session: {}", session_id);
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.update_session_title(&session_id, &title).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_chat_session(state: State<AppState>, session_id: String) -> Result<(), String> {
    info!("delete_chat_session called for session: {}", session_id);
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.delete_session(&session_id).map_err(|e| e.to_string())
}

// Project commands
#[tauri::command]
fn create_project(state: State<AppState>, name: Option<String>) -> Result<Project, String> {
    info!("create_project called");
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.create_project(name).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_projects(state: State<AppState>) -> Result<Vec<Project>, String> {
    debug!("get_projects called");
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_projects().map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_project(state: State<AppState>, project_id: String, name: String) -> Result<(), String> {
    info!("rename_project called for project: {}", project_id);
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.update_project_name(&project_id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_project(state: State<AppState>, project_id: String) -> Result<(), String> {
    info!("delete_project called for project: {}", project_id);
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.delete_project(&project_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_session_project(
    state: State<AppState>,
    session_id: String,
    project_id: Option<String>,
) -> Result<(), String> {
    info!("set_session_project called for session: {}", session_id);
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.set_session_project(&session_id, project_id.as_deref()).map_err(|e| e.to_string())
}

/// Below this cosine score a message is treated as unrelated to the query and left out
/// of semantic results, so weak matches don't pad the list. Tuned for `all-minilm`:
/// on real history, on-topic hits land ~0.40–0.47 and marginal ones sit just below.
const SEMANTIC_MATCH_FLOOR: f32 = 0.40;

/// Semantic search over chat history: embed the query, rank every stored message
/// embedding by cosine similarity, and return one `SearchResult` per session (its
/// most relevant message). Returns empty — not an error — when the embedding model
/// isn't available, so the UI simply falls back to keyword search.
#[tauri::command]
async fn search_similar_messages(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SearchResult>, String> {
    // Off means no semantic layer at all — the caller (SearchPage) already treats an
    // empty result as "fall back to keyword", so this needs no separate signal.
    if !vector_store::is_enabled() {
        return Ok(vec![]);
    }
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(vec![]);
    }
    let query_vec = match ollama::embed(vector_store::EMBEDDING_MODEL, &query).await {
        Ok(v) => v,
        Err(e) => {
            debug!("Semantic search unavailable: {}", e);
            return Ok(vec![]);
        }
    };

    // Rank all embeddings, keeping the best-scoring message per session so a session
    // shows once with its most relevant snippet.
    let mut ranked: Vec<(String, f32)> = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let all = db.all_embeddings().map_err(|e| e.to_string())?;
        let mut best: HashMap<String, (String, f32)> = HashMap::new();
        for (message_id, session_id, vec) in all {
            let score = vector_store::cosine_similarity(&query_vec, &vec);
            let replace = best.get(&session_id).map(|(_, s)| score > *s).unwrap_or(true);
            if replace {
                best.insert(session_id, (message_id, score));
            }
        }
        best.into_values().collect()
    };
    ranked.retain(|(_, score)| *score >= SEMANTIC_MATCH_FLOOR);
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    ranked.truncate(limit.unwrap_or(20));

    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut results = Vec::with_capacity(ranked.len());
    for (message_id, _score) in ranked {
        if let Some(result) = db.message_search_result(&message_id).map_err(|e| e.to_string())? {
            results.push(result);
        }
    }
    Ok(results)
}

/// Ensure the embedding model is installed, then embed any messages that don't yet
/// have a vector. Background, best-effort, offline-aware — see the setup call. Stops
/// early rather than spinning if a whole batch fails to embed (engine trouble).
/// One backfill at a time. An off→on toggle, or two enables in quick succession,
/// would otherwise spawn overlapping loops racing over the same unembedded batches —
/// correct either way (`INSERT OR REPLACE`), but wasted engine work.
static BACKFILL_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

async fn backfill_embeddings(app: tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    if !vector_store::is_enabled() {
        return;
    }
    // Claim the single backfill slot; bail if one is already running.
    if BACKFILL_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    // Release the slot on *every* exit path, including the early returns below.
    struct SlotGuard;
    impl Drop for SlotGuard {
        fn drop(&mut self) {
            BACKFILL_RUNNING.store(false, Ordering::Release);
        }
    }
    let _slot = SlotGuard;

    // The engine has to be up to embed (and to pull the model). Wait briefly for it.
    for _ in 0..120 {
        if is_ollama_running() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    if !is_ollama_running() {
        return;
    }

    // Pulling the model is the one step that needs the internet, so it's the only
    // thing offline mode blocks here. Embedding itself is a local `/api/embed` call,
    // so an *already-installed* model indexes the whole history fine offline — which
    // matches embed-on-save, which isn't offline-gated either. Without the model
    // there's nothing to embed with, so if it's missing and we're offline, stop and
    // let a later online run pull it.
    if !ollama::model_installed(vector_store::EMBEDDING_MODEL).await {
        if ollama_is_offline() {
            return;
        }
        info!("Pulling embedding model '{}' for semantic search...", vector_store::EMBEDDING_MODEL);
        let _ = ollama_pull_model(
            vector_store::EMBEDDING_MODEL.to_string(),
            Option::<std::sync::Arc<std::sync::atomic::AtomicBool>>::None,
            |_| {},
        )
        .await;
    }
    if !ollama::model_installed(vector_store::EMBEDDING_MODEL).await {
        return; // pull didn't land (went offline, etc.) — next launch tries again
    }

    let mut embedded = 0u32;
    loop {
        // Re-checked each round so turning semantic search off mid-backfill stops it
        // promptly rather than grinding through the whole history first.
        if !vector_store::is_enabled() {
            return;
        }
        let batch = {
            let state = app.state::<AppState>();
            let Ok(db) = state.db.lock() else { return };
            match db.unembedded_messages(16) {
                Ok(batch) => batch,
                Err(_) => return,
            }
        };
        if batch.is_empty() {
            break;
        }
        let mut progressed = false;
        for (message_id, session_id, content) in batch {
            if let Ok(vec) = ollama::embed(vector_store::EMBEDDING_MODEL, &content).await {
                let state = app.state::<AppState>();
                let Ok(db) = state.db.lock() else { continue };
                let _ = db.save_embedding(&message_id, &session_id, vector_store::EMBEDDING_MODEL, &vec);
                embedded += 1;
                progressed = true;
            }
        }
        if !progressed {
            break; // nothing embedded this round — stop rather than re-fetch forever
        }
    }
    if embedded > 0 {
        info!("Semantic search: embedded {} message(s)", embedded);
    }
}

/// State of the semantic-search index, for the Settings section.
#[derive(serde::Serialize)]
struct SemanticStatus {
    /// The flag as the backend currently holds it.
    enabled: bool,
    /// Whether the embedding model is on disk. False means the first enable will pull
    /// it (~45MB) before indexing can start.
    model_installed: bool,
    /// Messages worth embedding, and how many already are. `embedded < embeddable`
    /// while a backfill is running.
    embeddable: i64,
    embedded: i64,
}

/// Turn semantic search on or off. On enable, kicks the backfill so the index catches
/// up (pulling the embedding model first if needed); on disable, the flag alone stops
/// embed-on-save, the running backfill and query — nothing to tear down, since unlike
/// an Ollama server there's no long-lived child, only work that checks the flag.
///
/// Frontend-driven, mirroring `set_offline_mode`: called on launch with the persisted
/// setting so the backend does nothing about embeddings until the webview says to.
#[tauri::command]
fn set_semantic_search(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    vector_store::set_enabled(enabled);
    info!("Semantic search {}", if enabled { "enabled" } else { "disabled" });
    if enabled {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            backfill_embeddings(handle).await;
        });
    }
    Ok(())
}

#[tauri::command]
fn get_semantic_search() -> bool {
    vector_store::is_enabled()
}

/// The index's state for the Settings status line. `model_installed` is only checked
/// when enabled — while off there's nothing to pull and the question is moot.
#[tauri::command]
async fn semantic_index_status(state: State<'_, AppState>) -> Result<SemanticStatus, String> {
    let enabled = vector_store::is_enabled();
    let model_installed = if enabled {
        ollama::model_installed(vector_store::EMBEDDING_MODEL).await
    } else {
        false
    };
    let (embeddable, embedded) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.embedding_counts().map_err(|e| e.to_string())?
    };
    Ok(SemanticStatus { enabled, model_installed, embeddable, embedded })
}

#[tauri::command]
fn search_chats(state: State<AppState>, query: String) -> Result<Vec<SearchResult>, String> {
    info!("search_chats called with query: {}", query);
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.search_chats(&query).map_err(|e| e.to_string())
}

#[tauri::command]
fn import_chat(state: State<AppState>, title: String, messages: Vec<Message>) -> Result<ChatSession, String> {
    info!("import_chat called with title: {}", title);
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.import_session(title, messages).map_err(|e| e.to_string())
}

#[tauri::command]
fn append_messages(state: State<AppState>, session_id: String, messages: Vec<Message>) -> Result<(), String> {
    info!("append_messages called for session: {}", session_id);
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.append_messages(&session_id, messages).map_err(|e| e.to_string())
}

#[tauri::command]
fn branch_chat_session(
    state: State<AppState>,
    session_id: String,
    timestamp: String,
) -> Result<ChatSession, String> {
    info!("branch_chat_session called for session: {} at {}", session_id, timestamp);
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.branch_session(&session_id, &timestamp).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_messages_after(state: State<AppState>, session_id: String, timestamp: String) -> Result<(), String> {
    info!("delete_messages_after called for session: {} starting from: {}", session_id, timestamp);
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.delete_messages_after(&session_id, &timestamp).map_err(|e| e.to_string())
}

/// Extensions the attachment reader accepts — the server-side copy of the composer's
/// allowlist. The frontend filters too, but that's a UX nicety, not a boundary: any
/// IPC caller could invoke this command directly, so the extension check has to live
/// here to mean anything. Text formats only, since attachments are inlined into the
/// prompt.
const ATTACHMENT_EXTENSIONS: &[&str] =
    &["txt", "md", "py", "js", "ts", "tsx", "cpp", "rs", "json", "csv"];

/// Cap on one attachment's size. Larger text would blow the context anyway; the point
/// is to bound what a single IPC call can pull into memory.
const MAX_ATTACHMENT_BYTES: u64 = 10 * 1024 * 1024;

/// Read a UTF-8 text file for the composer's attachment feature. Both the `+`
/// picker and drag-and-drop hand a user-chosen path here. Reading in Rust is what
/// lets a *dropped* file work without widening the frontend's narrow fs read scope:
/// the dialog plugin grants read access to each picked path at runtime, but a drop
/// carries no such grant, so `readTextFile` from JS would be refused. Lossy UTF-8
/// so a file with a stray non-text byte still attaches rather than failing whole.
///
/// The extension allowlist and size cap are enforced here rather than trusted from
/// the frontend — this command crosses the IPC boundary, so its own input is the only
/// thing it can rely on.
#[tauri::command]
fn read_attachment_file(path: String) -> Result<String, String> {
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    if !ext.map(|e| ATTACHMENT_EXTENSIONS.contains(&e.as_str())).unwrap_or(false) {
        return Err(format!("'{}' isn't an allowed text attachment type", path));
    }
    let meta = std::fs::metadata(&path).map_err(|e| format!("{}: {}", path, e))?;
    if meta.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "'{}' is larger than the {}MB attachment limit",
            path,
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {}", path, e))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// ---------------------------------------------------------------------------
// MCP (Model Context Protocol) commands — the host surface for the frontend.
// Config lives in the app data dir; secret values live in the Keychain and never
// cross this boundary except when being *set*. See `src/mcp.rs`.
// ---------------------------------------------------------------------------

fn mcp_config_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("mcp_servers.json"))
}

/// The full server config. Safe to hand back whole — it contains no secret values,
/// only the *names* of secret env vars.
#[tauri::command]
fn mcp_read_config<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<mcp::McpConfig, String> {
    mcp::read_config(&mcp_config_path(&app)?)
}

/// Persist the whole config. Secrets are managed separately (`mcp_set_secret`), so
/// nothing secret is ever written to the file this touches.
#[tauri::command]
fn mcp_write_config<R: tauri::Runtime>(app: tauri::AppHandle<R>, config: mcp::McpConfig) -> Result<(), String> {
    mcp::write_config(&mcp_config_path(&app)?, &config)
}

/// Which servers are live right now — the UI joins this against the config to show
/// running vs stopped.
#[tauri::command]
fn mcp_running_servers(state: State<'_, AppState>) -> Vec<String> {
    mcp::running_ids(&state.mcp_servers)
}

/// Start a configured server by id: read its spec, resolve its secrets from the
/// Keychain into the child env, then spawn.
#[tauri::command]
async fn mcp_start_server<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    // A spawned MCP server opens its own network connections the app cannot revoke,
    // so it is refused before it starts — the same precedent as refusing a model
    // pull before Ollama is asked. Enforced at the command boundary, not fetch_url,
    // because the child's egress never passes through fetch_url.
    if ollama_is_offline() {
        return Err(OFFLINE_ERROR.to_string());
    }
    let config = mcp::read_config(&mcp_config_path(&app)?)?;
    // Own the launch spec so no borrow of `config` is held across the await; secret
    // resolution (env for stdio, headers for remote) happens inside start_server.
    let server = config
        .servers
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("No MCP server named '{id}' is configured"))?;
    // Clone the Arc out of state rather than borrowing state across the await.
    let servers = state.mcp_servers.clone();
    mcp::start_server(&servers, id.clone(), &server).await?;
    info!("MCP server '{id}' started");
    Ok(())
}

/// Stop one running server.
#[tauri::command]
async fn mcp_stop_server(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let servers = state.mcp_servers.clone();
    mcp::stop_server(&servers, &id).await
}

/// The tools a running server exposes, as canonical MCP JSON.
#[tauri::command]
async fn mcp_list_tools(state: State<'_, AppState>, id: String) -> Result<Vec<serde_json::Value>, String> {
    let servers = state.mcp_servers.clone();
    mcp::list_tools(&servers, &id).await
}

/// Deliver the user's decision for a pending tool call. A `call_id` that is no
/// longer pending is not an error: the call already resolved (it timed out, the
/// reply was stopped, or this is a duplicate click), and the loop has moved on — a
/// race the user can't see and shouldn't be told about.
#[tauri::command]
fn mcp_approve_tool(state: State<'_, AppState>, call_id: String, decision: ToolDecision) -> Result<(), String> {
    let sender = state.mcp_pending_approvals.lock().map_err(|e| e.to_string())?.remove(&call_id);
    if let Some(sender) = sender {
        // The receiver may already be gone (it raced the timeout); ignoring the
        // send error is correct — the loop has decided either way.
        let _ = sender.send(decision);
    }
    Ok(())
}

/// Store a secret env value for a server in the Keychain. `value` is write-only
/// across this boundary — it is never returned by any command and never logged.
#[tauri::command]
fn mcp_set_secret(id: String, key: String, value: String) -> Result<(), String> {
    mcp::set_secret(&id, &key, &value)
}

/// Remove one stored secret.
#[tauri::command]
fn mcp_delete_secret(id: String, key: String) -> Result<(), String> {
    mcp::delete_secret(&id, &key)
}

/// Delete a server entirely: stop it if running, drop it from the config, and purge
/// its Keychain secrets so no tokens outlive the server they belonged to.
#[tauri::command]
async fn mcp_delete_server<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let servers = state.mcp_servers.clone();
    let _ = mcp::stop_server(&servers, &id).await;

    let path = mcp_config_path(&app)?;
    let mut config = mcp::read_config(&path)?;
    if let Some(server) = config.servers.remove(&id) {
        for key in &server.secrets {
            let _ = mcp::delete_secret(&id, key);
        }
    }
    mcp::write_config(&path, &config)
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Get app data directory
            let app_dir = app.path().app_data_dir()
                .expect("Failed to get app data directory");
            
            // Create directory if it doesn't exist
            std::fs::create_dir_all(&app_dir)
                .expect("Failed to create app data directory");

            // Initialize SQLite database
            let db_path = app_dir.join("scarlettt.db");
            let db = Database::new(db_path)
                .expect("Failed to initialize database");

            // Store in app state
            app.manage(AppState {
                db: Arc::new(Mutex::new(db)),
                ollama_process: Arc::new(Mutex::new(None)),
                active_streams: Arc::new(Mutex::new(HashMap::new())),
                ollama_status: Arc::new(Mutex::new(if is_ollama_running() { OllamaStatus::Running } else { OllamaStatus::Stopped })),
                current_downloads: Arc::new(Mutex::new(HashMap::new())),
                mcp_servers: Arc::new(Mutex::new(HashMap::new())),
                mcp_pending_approvals: Arc::new(Mutex::new(HashMap::new())),
                mcp_tool_allowlist: Arc::new(Mutex::new(HashSet::new())),
            });

            // Try to start Ollama on launch if not running
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = start_ollama_service_internal(app_handle, false, false).await;
            });

            // Semantic search's backfill is *not* spawned here any more — it is
            // frontend-driven. The webview calls `set_semantic_search` on launch with
            // the persisted setting, and enabling is what pulls the model (if needed)
            // and indexes the history. Starting it here would race that restore and
            // pull a 45MB model for a user who had turned the feature off. See
            // `vector_store::SEMANTIC_SEARCH`.

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            send_chat_message,
            list_ollama_models,
            list_installed_models,
            list_loaded_models,
            get_model_details,
            get_remote_model_page,
            set_offline_mode,
            get_offline_mode,
            get_ollama_runtime,
            check_ollama_update,
            update_ollama,
            get_app_version,
            install_managed_ollama,
            check_ollama_integrity,
            get_system_info,
            get_user_name,
            get_available_memory,
            pull_ollama_model,
            cancel_ollama_model,
            delete_ollama_model,
            search_remote_ollama_models,
            get_remote_model_size,
            first_run_state,
            acknowledge_first_run,
            archive_previous_data,
            discard_previous_data,
            list_previous_data,
            restore_previous_data,
            delete_previous_data,
            import_shared_models,
            get_remote_model_details,
            create_chat_session,
            get_chat_sessions,
            record_session_context,
            stop_chat_message,
            get_chat_messages,
            save_message,
            rename_chat_session,
            delete_chat_session,
            create_project,
            get_projects,
            rename_project,
            delete_project,
            set_session_project,
            search_similar_messages,
            set_semantic_search,
            get_semantic_search,
            semantic_index_status,
            search_chats,
            import_chat,
            append_messages,
            delete_messages_after,
            read_attachment_file,
            branch_chat_session,
            get_ollama_status,
            start_ollama_service,
            mcp_read_config,
            mcp_write_config,
            mcp_running_servers,
            mcp_start_server,
            mcp_stop_server,
            mcp_list_tools,
            mcp_approve_tool,
            mcp_set_secret,
            mcp_delete_secret,
            mcp_delete_server,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // Both events, not just `ExitRequested`: that one fires when the last window
        // closes, so an exit reached any other way left the server running and the
        // model resident. Nothing can cover SIGKILL, which is why startup must also
        // be able to reclaim — see `install_managed_ollama`.
        if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
            let state = app_handle.state::<AppState>();

            // Reap every supervised MCP server. Unlike the Ollama child there is no
            // borrowed-vs-owned split — these are always ours — and no port to
            // reclaim, so a clean cancel of each is the whole job.
            {
                let servers = state.mcp_servers.clone();
                tauri::async_runtime::block_on(async move {
                    mcp::shutdown_all(&servers).await;
                });
            }

            let killed = {
                let mut process = match state.ollama_process.lock() {
                    Ok(p) => p,
                    Err(_) => return,
                };
                match process.take() {
                    Some(mut child) => {
                        info!("Stopping Ollama service...");
                        let _ = child.kill();
                        let _ = child.wait();
                        true
                    }
                    None => false,
                }
            };

            // Nothing of ours to kill means we're using someone else's server — a
            // Homebrew or official install, which is not ours to terminate. Ask it
            // to release the model instead, or a long `keep_alive` would leave
            // gigabytes held in their process with this app gone.
            if !killed {
                tauri::async_runtime::block_on(async {
                    if let Ok(loaded) = ollama_list_loaded_models().await {
                        for model in loaded {
                            info!("Releasing {} from the borrowed Ollama", model.name);
                            let _ = ollama::unload_model(&model.name).await;
                        }
                    }
                });
            }
        }
    });
}

#[cfg(test)]
mod approval_tests {
    use super::*;

    #[test]
    fn tool_decision_parses_the_frontend_strings() {
        assert_eq!(
            serde_json::from_str::<ToolDecision>("\"allow-once\"").unwrap(),
            ToolDecision::AllowOnce
        );
        assert_eq!(
            serde_json::from_str::<ToolDecision>("\"allow-session\"").unwrap(),
            ToolDecision::AllowSession
        );
        assert_eq!(serde_json::from_str::<ToolDecision>("\"deny\"").unwrap(), ToolDecision::Deny);
        // An unknown decision must not silently map to a permissive one.
        assert!(serde_json::from_str::<ToolDecision>("\"whatever\"").is_err());
    }

    #[tokio::test]
    async fn denies_when_the_wait_times_out() {
        let pending: McpPendingApprovals = Arc::new(Mutex::new(HashMap::new()));
        let cancel = Arc::new(AtomicBool::new(false));
        let decision = await_approval(&pending, "call-1", &cancel, Duration::from_millis(30)).await;
        assert_eq!(decision, ToolDecision::Deny);
        // The parked sender must be cleaned up, not leaked.
        assert!(pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn denies_immediately_when_already_cancelled() {
        let pending: McpPendingApprovals = Arc::new(Mutex::new(HashMap::new()));
        let cancel = Arc::new(AtomicBool::new(true));
        // A 60s timeout that we must NOT wait for — the cancel branch resolves first.
        let decision = await_approval(&pending, "call-2", &cancel, Duration::from_secs(60)).await;
        assert_eq!(decision, ToolDecision::Deny);
        assert!(pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn delivers_a_real_decision() {
        let pending: McpPendingApprovals = Arc::new(Mutex::new(HashMap::new()));
        let cancel = Arc::new(AtomicBool::new(false));
        let call_id = "call-3".to_string();

        let waiter = {
            let (pending, cancel, call_id) = (pending.clone(), cancel.clone(), call_id.clone());
            tokio::spawn(async move {
                await_approval(&pending, &call_id, &cancel, Duration::from_secs(5)).await
            })
        };

        // Let the waiter register its sender, then approve the way mcp_approve_tool
        // does — take the sender out of the registry and send.
        tokio::time::sleep(Duration::from_millis(20)).await;
        let sender = pending.lock().unwrap().remove(&call_id).expect("sender was registered");
        sender.send(ToolDecision::AllowSession).unwrap();

        assert_eq!(waiter.await.unwrap(), ToolDecision::AllowSession);
    }
}

#[cfg(test)]
mod native_e2e {
    //! The whole tool loop against a real MCP server AND the real local model —
    //! the one thing the browser mock cannot prove. Ignored by default (needs `npx`
    //! and a tools-capable model on the dev Ollama port). Run with:
    //!   cargo test --lib native_e2e -- --ignored --nocapture
    use crate::{mcp, ollama};
    use crate::ollama::ChatMessage;
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    #[ignore = "native: real MCP server (npx) + real Ollama model on the dev port"]
    async fn real_end_to_end_tool_loop() {
        let servers: mcp::McpServers = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let cfg = mcp::ServerConfig {
            command: Some("npx".to_string()),
            args: vec![
                "-y".to_string(),
                "@modelcontextprotocol/server-everything".to_string(),
            ],
            env: std::collections::HashMap::new(),
            url: None,
            headers: None,
            secrets: vec![],
            enabled: true,
        };
        mcp::start_server(&servers, "everything".to_string(), &cfg)
            .await
            .expect("server starts");

        // Advertise the server's tools to the model, and keep the reverse map.
        let (tools, routes) =
            mcp::collect_tools(&servers, &["everything".to_string()]).await;
        assert!(!tools.is_empty(), "collected some tools");

        // Drive the same loop `run_chat_with_tools` runs, with the real primitives.
        let cancel = Arc::new(AtomicBool::new(false));
        let noop = |_t: String| {};
        let mut messages = vec![ChatMessage {
            role: "user".to_string(),
            content: "Use the get-sum tool to add 17 and 25, then state only the result.".to_string(),
            tool_calls: vec![],
            tool_name: None,
        }];

        let mut used_a_tool = false;
        let mut answer = String::new();
        for turn in 0..8u32 {
            let outcome = ollama::chat_turn("qwen3.5:4b", &messages, &tools, 8192, 30, &cancel, &noop)
                .await
                .unwrap_or_else(|e| panic!("chat_turn (turn {turn}) failed: {e}"));
            if outcome.tool_calls.is_empty() {
                answer = outcome.content;
                break;
            }
            used_a_tool = true;
            messages.push(ChatMessage {
                role: "assistant".to_string(),
                content: outcome.content,
                tool_calls: outcome.tool_calls.clone(),
                tool_name: None,
            });
            for call in &outcome.tool_calls {
                let route = routes
                    .get(&call.function.name)
                    .unwrap_or_else(|| panic!("no route for {}", call.function.name));
                eprintln!("→ tool call: {} args={}", call.function.name, call.function.arguments);
                let result = mcp::call_tool(&servers, &route.server_id, &route.tool_name, call.function.arguments.clone())
                    .await
                    .expect("tool call succeeds");
                let (text, is_err) = mcp::flatten_tool_result(&result);
                eprintln!("← tool result (is_error={is_err}): {text}");
                messages.push(ChatMessage {
                    role: "tool".to_string(),
                    content: text,
                    tool_calls: vec![],
                    tool_name: Some(call.function.name.clone()),
                });
            }
        }

        mcp::shutdown_all(&servers).await;

        eprintln!("FINAL ANSWER: {answer}");
        assert!(used_a_tool, "the model should have called a tool");
        assert!(answer.contains("42"), "final answer should contain 42, got: {answer:?}");
    }

    /// Diagnostic (no assert): with the real Figma server + the real model + the
    /// system prompt, does qwen3.5:4b actually *decide* to call a Figma tool, or
    /// refuse? One chat turn per prompt — we only care whether tool_calls appears.
    ///   cargo test --lib native_e2e::figma_tool_use -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "native diagnostic: needs Figma Dev Mode server + qwen3.5:4b"]
    async fn figma_tool_use_diagnostic() {
        let servers: mcp::McpServers = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let cfg = mcp::ServerConfig {
            command: None,
            args: vec![],
            env: std::collections::HashMap::new(),
            url: Some("http://127.0.0.1:3845/mcp".to_string()),
            headers: None,
            secrets: vec![],
            enabled: true,
        };
        mcp::start_server(&servers, "figma".to_string(), &cfg).await.expect("connect figma");
        let (tools, _routes) =
            mcp::collect_tools(&servers, &["figma".to_string()]).await;
        eprintln!("\n=== advertised {} figma tools to the model ===", tools.len());

        const SYS: &str = "You are connected to external tools, listed for you, including tools \
            that read Figma design files. You CAN access these systems through the tools — do not \
            claim you cannot. For any request about a Figma design, your FIRST action must be to \
            call a Figma tool (for example get_design_context or get_metadata) with the node id \
            from the request. Never answer that you lack access or integration; call the tool \
            instead. Only after a tool returns should you write a normal reply.";

        let cancel = Arc::new(AtomicBool::new(false));
        let noop = |_t: String| {};

        let prompts = [
            ("user's phrasing", "https://www.figma.com/design/0XPuRcEemK4S8ZdTfET9xI/New-homepage-2026?node-id=1538-5882&m=dev - can you recreate that design in dark mode in figma?"),
            ("explicit read ask", "Use the Figma tools to read the design context of node 1538-5882, then tell me what you found."),
        ];
        for (label, prompt) in prompts {
            let messages = vec![
                ChatMessage { role: "system".to_string(), content: SYS.to_string(), tool_calls: vec![], tool_name: None },
                ChatMessage { role: "user".to_string(), content: prompt.to_string(), tool_calls: vec![], tool_name: None },
            ];
            let turn = ollama::chat_turn("qwen3.5:4b", &messages, &tools, 16384, 30, &cancel, &noop)
                .await
                .expect("chat_turn");
            let called: Vec<String> = turn.tool_calls.iter().map(|c| c.function.name.clone()).collect();
            eprintln!("\n--- prompt: {label} ---");
            eprintln!("CALLED TOOLS: {called:?}");
            eprintln!("CONTENT: {}", turn.content.chars().take(500).collect::<String>());
        }
        mcp::shutdown_all(&servers).await;
    }
}
