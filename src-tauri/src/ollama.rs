use serde::{Deserialize, Serialize};
use reqwest;
use log::{info, error, warn};
use std::path::PathBuf;
use std::process::{Command, Child, Stdio};
use std::net::TcpStream;
use std::time::Duration;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::io::Write;
use std::fs::File;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// The port this app's engine serves on — **different in a debug build**.
///
/// Both builds otherwise start an engine on the same port and `stop_ollama_on_port`
/// kills whatever it finds there, so running the dev app took the shipped app's
/// engine out from under it (and vice versa), which is how one build's model store
/// ends up being read by the other. Split at compile time rather than by config, so
/// it holds even when someone runs `tauri dev` without the dev config.
#[cfg(debug_assertions)]
const OLLAMA_PORT: &str = "11436";
#[cfg(not(debug_assertions))]
const OLLAMA_PORT: &str = "11435";

/// The engine port, for callers outside this module (logging, diagnostics).
pub fn port() -> &'static str {
    OLLAMA_PORT
}

/// Minimum Ollama the app will run with. The registry rejects clients that are
/// too old to read a model's manifest — HTTP 412 — so a stale binary silently
/// fails to download anything recent. Bump this when that starts happening.
const MINIMUM_OLLAMA_VERSION: (u32, u32, u32) = (0, 32, 0);

/// Pulls an x.y.z out of arbitrary text — `--version` and `/api/version` word
/// it differently, and `--version` also emits a connection warning.
fn parse_version_triple(text: &str) -> Option<(u32, u32, u32)> {
    let token = text
        .split_whitespace()
        .find(|t| t.split('.').count() == 3 && t.starts_with(|c: char| c.is_ascii_digit()))?;
    let mut parts = token.trim_end_matches(|c: char| !c.is_ascii_digit()).split('.');
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next().unwrap_or("0").parse().unwrap_or(0),
    ))
}

/// Reads the client version from `ollama --version`. Works whether or not a
/// server is reachable: without one it prints "Warning: client version is X".
pub fn ollama_binary_version(binary: &std::path::Path) -> Option<(u32, u32, u32)> {
    let output = Command::new(binary).arg("--version").output().ok()?;
    parse_version_triple(&format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    ))
}

/// Version of whatever is already answering on the Ollama port. Checking only
/// the binary misses the common case: an orphaned server from a previous run,
/// or one the user started themselves, keeps serving the old version regardless
/// of what's on disk.
pub async fn running_ollama_version() -> Option<(u32, u32, u32)> {
    let url = format!("http://localhost:{}/api/version", OLLAMA_PORT);
    let text = reqwest::Client::new().get(url).send().await.ok()?.text().await.ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    parse_version_triple(value.get("version")?.as_str()?)
}

/// True when the given version predates what the registry will serve.
pub fn is_version_outdated(version: (u32, u32, u32)) -> bool {
    version < MINIMUM_OLLAMA_VERSION
}

/// What the app knows about the Ollama it's running.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OllamaRuntime {
    pub version: Option<String>,
    /// Absolute path of the binary in use.
    pub path: Option<String>,
    /// False when the binary lives outside our app data dir — a Homebrew or
    /// official install belongs to the user, so we show it but never replace it.
    pub managed_by_app: bool,
    pub outdated: bool,
    /// Latest release on GitHub, when a check has been run.
    pub latest: Option<String>,
}

/// Latest published Ollama. ollama.com has no usable version endpoint — it
/// returns a placeholder "0.0.0" — so this reads GitHub's releases API.
pub async fn latest_ollama_version() -> Result<String, String> {
    let body = fetch_url("https://api.github.com/repos/ollama/ollama/releases/latest").await?;
    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse release info: {}", e))?;
    value
        .get("tag_name")
        .and_then(|t| t.as_str())
        .map(|t| t.trim_start_matches('v').to_string())
        .ok_or_else(|| "No tag_name in release response".to_string())
}

/// True when the binary is too old for the current registry, or its version
/// can't be read at all (in which case replacing it is the safer choice).
pub fn is_ollama_outdated(binary: &std::path::Path) -> bool {
    match ollama_binary_version(binary) {
        Some(version) => {
            let outdated = version < MINIMUM_OLLAMA_VERSION;
            if outdated {
                warn!(
                    "Bundled Ollama {:?} is older than the required {:?}; replacing it",
                    version, MINIMUM_OLLAMA_VERSION
                );
            }
            outdated
        }
        None => {
            warn!("Could not read the Ollama version; replacing the binary");
            true
        }
    }
}

/// Offline mode. When on, every outbound internet request is refused at
/// `fetch_url` (and at the two byte-stream paths that can't use it). Requests to
/// the local Ollama on 127.0.0.1 are unaffected, so chat keeps working.
///
/// This is app-level enforcement, not a firewall: it is this process choosing
/// not to call out. The bundled Ollama subprocess has its own network access
/// that cannot be revoked from here — which is why model pulls are refused
/// before Ollama is ever asked.
static OFFLINE: AtomicBool = AtomicBool::new(false);

pub const OFFLINE_ERROR: &str =
    "Offline mode is on, so this request was not made. Turn it off in Settings to browse or download models.";

pub fn set_offline(enabled: bool) {
    OFFLINE.store(enabled, Ordering::Relaxed);
    info!("Offline mode {}", if enabled { "enabled" } else { "disabled" });
}

pub fn is_offline() -> bool {
    OFFLINE.load(Ordering::Relaxed)
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub enum OllamaStatus {
    Running,
    Stopped,
    Downloading { progress: f64 },
    Starting,
    PullingModel { progress: f64 },
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    /// Tool calls the model emitted on an assistant turn — Ollama returns these in
    /// `message.tool_calls`, and `chat_turn` reads them so the loop can run the
    /// tools. Empty on every ordinary message, and skipped on serialize so a normal
    /// request is byte-identical to before this field existed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    /// Set only on a `role:"tool"` message: which tool this content is the result
    /// of. Ollama uses it to pair the result with the call that produced it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
}

/// A tool call the model emitted, as Ollama returns it in `message.tool_calls`.
/// Typed (unlike the tool *definitions* we send) because the loop reads the name
/// and arguments off it to route the call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub function: ToolCallFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallFunction {
    pub name: String,
    /// Ollama returns the arguments as a JSON *object*, not a JSON string the way
    /// OpenAI does — kept as a raw value so it passes straight into the MCP call.
    #[serde(default)]
    pub arguments: serde_json::Value,
}

/// Per-request overrides. Omitted entirely when empty so Ollama keeps its own
/// defaults rather than being handed nulls.
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct ChatOptions {
    /// Context window in tokens. **Not optional, deliberately.** Ollama defaults
    /// to 4096 regardless of what the model supports, so an absent `num_ctx` is
    /// not "no preference" — it is a hardcoded number that knows nothing about
    /// this machine, silently applied and then inherited by every later request
    /// that reuses the loaded instance. The app decides this; the type is what
    /// stops a caller from handing the decision back.
    pub num_ctx: u32,
}

/// Borrows its `messages` and `tools` rather than owning them, so the tool loop
/// can re-POST a *growing* history across turns without cloning the whole
/// conversation each time.
#[derive(Debug, Serialize)]
struct ChatRequestRef<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
    /// Always sent. See `ChatOptions::num_ctx`.
    options: ChatOptions,
    /// Tools advertised to the model, OpenAI-style (`{type, function:{name,
    /// description, parameters}}`), built from MCP tools by `mcp::ollama_tool_def`.
    /// Kept as raw JSON because a tool's `parameters` is an arbitrary JSON Schema;
    /// empty and skipped for an ordinary chat, so a tool-less request is unchanged.
    #[serde(skip_serializing_if = "tools_empty")]
    tools: &'a [serde_json::Value],
    /// Seconds to hold the model in memory after this request; `-1` for as long
    /// as the server lives. **Required, for the same reason as `num_ctx`:** absent,
    /// Ollama applies its own five-minute default, which is a decision about this
    /// machine's memory made by something that knows nothing about it. Every
    /// request carries it because Ollama resets the timer per request — which is
    /// also why the loop re-attaches it on *every* turn, not just the first.
    keep_alive: i64,
}

/// serde `skip_serializing_if` receives `&field`, i.e. `&&[Value]` here.
fn tools_empty(tools: &&[serde_json::Value]) -> bool {
    tools.is_empty()
}

/// Generation stats — Ollama only puts these on the final (`done`) chunk.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ChatStats {
    /// Nanoseconds, wall clock for the whole request.
    pub total_duration: Option<u64>,
    /// Tokens in the prompt Ollama actually evaluated.
    pub prompt_eval_count: Option<u32>,
    /// Tokens generated in the response.
    pub eval_count: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatResponse {
    pub message: ChatMessage,
    pub done: bool,
    #[serde(flatten)]
    pub stats: ChatStats,
}

/// The outcome of one model turn.
pub struct ChatTurn {
    /// The assistant text this turn produced — already streamed token-by-token via
    /// `on_token`, and assembled here so the caller can record it in history.
    pub content: String,
    /// Tool calls the model emitted this turn. Empty means the turn is a final
    /// answer and the caller's loop should stop; non-empty means run them and turn
    /// again. Cleared on cancel, so a stopped turn never triggers a tool run.
    pub tool_calls: Vec<ToolCall>,
    /// Generation stats, present only when the turn ran to `done` (a cancelled turn
    /// returns None).
    pub stats: Option<ChatStats>,
}

/// One model turn against `/api/chat`.
///
/// This is a *single* request, deliberately: the multi-turn tool loop lives in the
/// command layer (`lib.rs`), which is where both this and the MCP client are
/// visible. Keeping this function a pure Ollama primitive is what stops `ollama`
/// from depending on `mcp`. It streams content tokens through `on_token`, and
/// returns any `tool_calls` the model asked for so the caller can run them and call
/// again with the results appended.
///
/// `messages` and `tools` are borrowed so the loop can grow the history in place
/// and re-POST without cloning the whole conversation per turn.
pub async fn chat_turn<F>(
    model: &str,
    messages: &[ChatMessage],
    tools: &[serde_json::Value],
    num_ctx: u32,
    keep_alive: i64,
    // Set from `stop_chat_message` to end the reply early. Checked per chunk, so
    // a stop lands within one token rather than at the end of the response.
    cancel: &Arc<AtomicBool>,
    on_token: &F,
) -> Result<ChatTurn, String>
where
    F: Fn(String) + Send + Sync,
{
    let client = reqwest::Client::new();
    let url = format!("http://localhost:{}/api/chat", OLLAMA_PORT);

    let request = ChatRequestRef {
        model,
        messages,
        stream: true,
        options: ChatOptions { num_ctx },
        tools,
        keep_alive,
    };

    let mut response = client
        .post(url)
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("Failed to send request to Ollama: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Ollama API error: {}", response.status()));
    }

    let mut stats = None;
    let mut content = String::new();
    // Accumulated across chunks. Ollama sends a turn's tool_calls whole (arguments
    // are a JSON object, not OpenAI-style string deltas), but appending each
    // chunk's calls is correct whether they arrive in one chunk or several.
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    /*
     * Ollama returns reasoning as its own `thinking` field, separate from `content`.
     * It is deliberately not captured: nothing displays it, so pulling it in would
     * only put reasoning into the stored message — storage to hold, a strip to write
     * before every send, and raw `<think>` tags to leak the first time one is
     * forgotten. Not deserialising it at all is the version with no upkeep.
     */
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        // Stopping returns Ok rather than Err: the tokens already streamed are a
        // real partial answer, and the caller's completion path is what saves them.
        // Treating a deliberate stop as a failure would discard the reply the user
        // chose to keep. Dropping `response` here also closes the connection, which
        // is what tells Ollama to stop generating rather than finishing into a void.
        // `tool_calls` is cleared so a half-formed call from an interrupted turn is
        // never executed.
        if cancel.load(Ordering::Relaxed) {
            info!("Chat stream cancelled by the user");
            return Ok(ChatTurn { content, tool_calls: Vec::new(), stats });
        }
        let chunk_str = String::from_utf8_lossy(&chunk);
        for line in chunk_str.lines() {
            if let Ok(chat_response) = serde_json::from_str::<ChatResponse>(line) {
                let mut message = chat_response.message;
                if !message.content.is_empty() {
                    content.push_str(&message.content);
                    on_token(std::mem::take(&mut message.content));
                }
                if !message.tool_calls.is_empty() {
                    tool_calls.append(&mut message.tool_calls);
                }
                if chat_response.done {
                    stats = Some(chat_response.stats);
                }
            }
        }
    }

    Ok(ChatTurn { content, tool_calls, stats })
}

/// An installed model and what it can actually do.
///
/// `/api/tags` reports `capabilities` per model, and this used to deserialize only
/// the name and throw them away. That is how an embedding model reached the chat
/// picker: `all-minilm` answers `/api/chat` with
/// `"all-minilm" does not support chat`, and nothing upstream knew to stop it.
///
/// An **empty** list means the field was absent, which an older Ollama does — it is
/// "unknown", not "cannot chat". Callers must treat it as permissive, or the picker
/// empties itself on exactly the runtimes least able to explain why.
#[derive(Debug, Serialize, Deserialize)]
pub struct ModelSummary {
    pub name: String,
    pub capabilities: Vec<String>,
}

pub async fn list_models() -> Result<Vec<ModelSummary>, String> {
    let client = reqwest::Client::new();
    let url = format!("http://localhost:{}/api/tags", OLLAMA_PORT);

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to get models from Ollama: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Ollama API error: {}", response.status()));
    }

    #[derive(Deserialize)]
    struct ModelInfo {
        name: String,
        #[serde(default)]
        capabilities: Vec<String>,
    }

    #[derive(Deserialize)]
    struct ModelsResponse {
        models: Vec<ModelInfo>,
    }

    let body: ModelsResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse models response: {}", e))?;

    Ok(body
        .models
        .into_iter()
        .map(|m| ModelSummary { name: m.name, capabilities: m.capabilities })
        .collect())
}

/// An installed model with the metadata `/api/tags` already returns but
/// `list_models` throws away.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InstalledModel {
    pub name: String,
    /// On-disk size in bytes.
    pub size: u64,
    pub parameter_size: Option<String>,
    pub quantization_level: Option<String>,
    pub family: Option<String>,
    /// Ollama's own content hash for this tag. The identity the frontend caches
    /// derived facts against: a name can be re-pulled to different weights, and a
    /// stale architecture would put the context calculation several-fold out.
    pub digest: Option<String>,
    /// What `/api/tags` says this model can do — `["completion", "tools"]` for a chat
    /// model, `["embedding"]` for one that can't. Lets the library hide non-chat
    /// models (the embedding model semantic search installs) the same way the picker
    /// already does. Empty means the field was absent (older Ollama) — treat as
    /// unknown, not incapable, exactly like `ModelSummary`.
    pub capabilities: Vec<String>,
}

/// A model Ollama has resident right now, from `/api/ps`.
///
/// This is the only ground truth in the app. Everything else about context and
/// memory is an estimate: `resolveContext` predicts a context, the fit badge
/// predicts a footprint, and both can be wrong — Ollama clamps `num_ctx` to the
/// model's trained maximum without saying so, and llama.cpp silently runs layers
/// on the CPU when they don't fit in VRAM. Reading it back is the only way to
/// know what happened.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LoadedModel {
    pub name: String,
    /// The context Ollama actually applied, not the one that was requested.
    pub context_length: Option<u64>,
    /// Total bytes the loaded model occupies.
    pub size: u64,
    /// Of that total, the bytes resident on the GPU. Anything short of `size` is
    /// running on the CPU instead — measured at ~5x slower on an M1 Pro, so it
    /// matters far more than the extra context that caused it.
    pub size_vram: u64,
    /// When Ollama will release it, per the `keep_alive` this app sent. RFC 3339,
    /// and far in the future (year 2318) when the app asked for `-1`.
    pub expires_at: Option<String>,
}

/// Releases a model from memory now, by asking rather than killing.
///
/// Used at shutdown when the server belongs to the user — a Homebrew or official
/// install we must not terminate. Without this, quitting with a long `keep_alive`
/// would leave gigabytes held in *their* server with nothing left to release it.
pub async fn unload_model(name: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    client
        .post(format!("http://localhost:{}/api/generate", OLLAMA_PORT))
        .json(&serde_json::json!({ "model": name, "keep_alive": 0 }))
        .send()
        .await
        .map_err(|e| format!("Failed to unload {}: {}", name, e))?;
    Ok(())
}

pub async fn list_loaded_models() -> Result<Vec<LoadedModel>, String> {
    let client = reqwest::Client::new();
    let url = format!("http://localhost:{}/api/ps", OLLAMA_PORT);

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to reach Ollama: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Ollama API error: {}", response.status()));
    }

    #[derive(Deserialize)]
    struct PsModel {
        name: String,
        #[serde(default)]
        expires_at: Option<String>,
        #[serde(default)]
        context_length: Option<u64>,
        #[serde(default)]
        size: u64,
        /// Absent on builds without GPU support; treated as "all on CPU" would be
        /// a false alarm, so callers get 0 and must check `size` before dividing.
        #[serde(default)]
        size_vram: u64,
    }

    #[derive(Deserialize)]
    struct PsResponse {
        models: Vec<PsModel>,
    }

    let ps: PsResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse running models: {}", e))?;

    Ok(ps
        .models
        .into_iter()
        .map(|m| LoadedModel {
            name: m.name,
            context_length: m.context_length,
            size: m.size,
            size_vram: m.size_vram,
            expires_at: m.expires_at,
        })
        .collect())
}

pub async fn list_installed_models() -> Result<Vec<InstalledModel>, String> {
    let client = reqwest::Client::new();
    let url = format!("http://localhost:{}/api/tags", OLLAMA_PORT);

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to get models from Ollama: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Ollama API error: {}", response.status()));
    }

    #[derive(Deserialize, Default)]
    struct Details {
        parameter_size: Option<String>,
        quantization_level: Option<String>,
        family: Option<String>,
    }

    #[derive(Deserialize)]
    struct ModelInfo {
        name: String,
        #[serde(default)]
        size: u64,
        #[serde(default)]
        digest: Option<String>,
        #[serde(default)]
        details: Details,
        #[serde(default)]
        capabilities: Vec<String>,
    }

    #[derive(Deserialize)]
    struct ModelsResponse {
        models: Vec<ModelInfo>,
    }

    let models_response: ModelsResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse models response: {}", e))?;

    Ok(models_response
        .models
        .into_iter()
        .map(|m| InstalledModel {
            name: m.name,
            size: m.size,
            parameter_size: m.details.parameter_size,
            quantization_level: m.details.quantization_level,
            family: m.details.family,
            digest: m.digest,
            capabilities: m.capabilities,
        })
        .collect())
}

/// Whether a model is installed, matched by base name (the tag is ignored) — so
/// `all-minilm` matches `all-minilm:latest`. Used to gate semantic search on its
/// embedding model being present. False (not "unknown") on any error, since the
/// caller then just does nothing.
pub async fn model_installed(model: &str) -> bool {
    list_installed_models()
        .await
        .map(|list| {
            list.iter()
                .any(|m| m.name == model || m.name.split(':').next() == Some(model))
        })
        .unwrap_or(false)
}

/// Embed one piece of text with the local engine's `/api/embed`. Local, like chat —
/// nothing leaves the machine. Returns the single embedding vector.
pub async fn embed(model: &str, text: &str) -> Result<Vec<f32>, String> {
    #[derive(Serialize)]
    struct EmbedRequest<'a> {
        model: &'a str,
        input: &'a str,
    }
    #[derive(Deserialize, Default)]
    struct EmbedResponse {
        #[serde(default)]
        embeddings: Vec<Vec<f32>>,
    }

    let client = reqwest::Client::new();
    let url = format!("http://localhost:{}/api/embed", OLLAMA_PORT);
    let response = client
        .post(&url)
        .json(&EmbedRequest { model, input: text })
        .send()
        .await
        .map_err(|e| format!("Embedding request failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Embedding failed: HTTP {}", response.status()));
    }
    let body: EmbedResponse = response
        .json()
        .await
        .map_err(|e| format!("Embedding response was not valid JSON: {e}"))?;
    body.embeddings
        .into_iter()
        .next()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "Embedding response contained no vector".to_string())
}

/// Everything `/api/show` can tell us about a model already on disk.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ModelDetails {
    pub capabilities: Vec<String>,
    pub family: Option<String>,
    pub parameter_size: Option<String>,
    pub quantization_level: Option<String>,
    /// Maximum context the model was trained for, in tokens.
    pub context_length: Option<u64>,
    /// Memory the KV cache costs per token of context, in bytes. The cache grows
    /// linearly with context, and at long contexts it can dwarf the weights.
    pub kv_bytes_per_token: Option<u64>,
    /// First line of the licence text — enough to identify it.
    pub license: Option<String>,
}

pub async fn get_model_details(model: String) -> Result<Option<ModelDetails>, String> {
    let client = reqwest::Client::new();
    let url = format!("http://localhost:{}/api/show", OLLAMA_PORT);

    let response = client
        .post(url)
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await
        .map_err(|e| format!("Failed to reach Ollama: {}", e))?;

    if !response.status().is_success() {
        return Ok(None);
    }

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse model details: {}", e))?;

    // model_info keys are namespaced by architecture ("llama.context_length"),
    // so match on the suffix rather than guessing the prefix.
    let info = body.get("model_info").and_then(|v| v.as_object());
    // Multimodal models carry a second set under "<arch>.vision.*" whose keys end
    // the same way — matching those would use the vision tower's layer count and
    // embedding size for the language model's cache.
    let field = |suffix: &str| -> Option<u64> {
        info?
            .iter()
            .find(|(k, _)| k.ends_with(suffix) && !k.contains(".vision."))
            .and_then(|(_, v)| v.as_u64())
    };

    let block_count = field(".block_count");
    let head_count = field(".attention.head_count");
    let head_count_kv = field(".attention.head_count_kv");
    let embedding_length = field(".embedding_length");

    // K and V, per layer, per kv-head, at fp16.
    let kv_bytes_per_token = match (block_count, head_count, head_count_kv, embedding_length) {
        (Some(blocks), Some(heads), Some(kv_heads), Some(embed)) if heads > 0 => {
            let head_dim = embed / heads;
            Some(2 * blocks * kv_heads * head_dim * 2)
        }
        _ => None,
    };

    let details = body.get("details");
    let string_field = |key: &str| -> Option<String> {
        details?
            .get(key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    };

    Ok(Some(ModelDetails {
        capabilities: body
            .get("capabilities")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|c| c.as_str().map(String::from)).collect())
            .unwrap_or_default(),
        family: string_field("family"),
        parameter_size: string_field("parameter_size"),
        quantization_level: string_field("quantization_level"),
        context_length: field(".context_length"),
        kv_bytes_per_token,
        license: body
            .get("license")
            .and_then(|v| v.as_str())
            .and_then(|l| l.lines().find(|line| !line.trim().is_empty()))
            .map(|line| line.trim().chars().take(80).collect()),
    }))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PullRequest {
    pub model: String,
    pub stream: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PullResponse {
    pub status: String,
    pub digest: Option<String>,
    pub total: Option<u64>,
    pub completed: Option<u64>,
}

pub async fn pull_model<F>(
    model: String, 
    abort_signal: Option<Arc<AtomicBool>>, 
    on_progress: F
) -> Result<(), String>
where
    F: Fn(PullResponse) + Send + 'static,
{
    let client = reqwest::Client::new();
    let url = format!("http://localhost:{}/api/pull", OLLAMA_PORT);

    let request = PullRequest {
        model,
        stream: true,
    };

    let mut response = client
        .post(url)
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("Failed to send pull request to Ollama: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Ollama API error: {}", response.status()));
    }

    loop {
        if let Some(signal) = &abort_signal {
            if signal.load(Ordering::Relaxed) {
                warn!("Pull operation cancelled locally.");
                // We just stop processing the stream. Ollama might continue in background 
                // but we won't block for it or report it.
                // Ideally we'd send a delete request or cancel the connection?
                // Dropping the response *should* close the connection.
                return Err("Cancelled".to_string());
            }
        }

        match response.chunk().await {
            Ok(Some(chunk)) => {
                let chunk_str = String::from_utf8_lossy(&chunk);
                for line in chunk_str.lines() {
                    if line.trim().is_empty() {
                        continue;
                    }
                    // Ollama reports failures as {"error": "..."} mid-stream. These
                    // don't deserialize into PullResponse, so silently skipping
                    // unparsed lines made a refused pull look like a successful one.
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
                        if let Some(message) = value.get("error").and_then(|e| e.as_str()) {
                            error!("Pull failed: {}", message);
                            return Err(message.to_string());
                        }
                    }
                    if let Ok(response) = serde_json::from_str::<PullResponse>(line) {
                        on_progress(response);
                    }
                }
            },
            Ok(None) => break,
            Err(e) => return Err(e.to_string()),
        }
    }

    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DeleteRequest {
    pub name: String,
}

pub async fn delete_model(model: String) -> Result<(), String> {
    info!("Deleting model: {}", model);
    let client = reqwest::Client::new();
    let url = format!("http://localhost:{}/api/delete", OLLAMA_PORT);

    let request = DeleteRequest { name: model };

    let response = client
        .delete(url)
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("Failed to send delete request to Ollama: {}", e))?;

    let status = response.status();
    info!("Delete response status: {}", status);

    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        error!("Delete error body: {}", text);
        return Err(format!("Ollama API error: {} - {}", status, text));
    }

    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RemoteModel {
    pub name: String,
    pub description: String,
    pub parameter_sizes: Vec<String>,
    /// Capability chips from the listing ("tools", "vision", "embedding") — the
    /// only way to know these before a model is downloaded.
    #[serde(default)]
    pub capabilities: Vec<String>,
    pub size: Option<String>,
    /// Parsed from the model page's "2.0GB · 128K context window · …" line.
    #[serde(default)]
    pub context_length: Option<u64>,
}

/// `sort` maps to ollama.com's own ordering: "popular" (its default) or
/// "newest". Anything else is ignored and the site's default applies.
///
/// The unfiltered catalog comes from `/library`, not `/search`. That page serves
/// the **whole** library in one plain GET — 235 models against the 20 a search
/// page returns, measured, and byte-for-byte the same set as walking `/search`
/// across all 12 of its pages. Its order is all-time pulls descending, which is
/// exactly what "popular" means here, and the existing row scraper matches all
/// 235 rows unchanged.
///
/// It takes no parameters at all: `?o=newest`, `?c=vision` and `?page=2` each
/// return byte-identical responses. So sorting and filtering still have to go
/// through `/search`, which is why "newest" keeps the old URL — and, until that
/// path paginates, keeps the old 20-model ceiling with it.
pub async fn search_remote_models(query: String, sort: Option<String>) -> Result<Vec<RemoteModel>, String> {
    let url = match (query.trim().is_empty(), sort.as_deref()) {
        (true, None) | (true, Some("popular")) => "https://ollama.com/library".to_string(),
        (_, Some(order)) => format!("https://ollama.com/search?q={}&c=chat&o={}", query, order),
        (_, None) => format!("https://ollama.com/search?q={}&c=chat", query),
    };
    let html_content = fetch_url(&url).await?;

    // No per-model page fetches here. This used to scrape the first 8 models' own
    // pages for a size string, awaited before returning — ~700KB and ~1.7s of
    // blocked first paint, for 8 of 235 rows. Sizes now come from the registry
    // manifest instead (`remote_model_size`), which the caller fetches for every
    // row it shows, so the scrape was buying a slower paint and nothing else.
    Ok(scrape_models_from_search_html(&html_content))
}

/// Details for a known model reference, which may carry a tag ("qwen2.5:7b").
///
/// The search endpoint only indexes base names — querying a tagged one returns
/// unrelated community uploads — so the tag is stripped before searching and
/// applied afterwards against the model's own variant list.
pub async fn get_remote_model_details(name: String) -> Result<Option<RemoteModel>, String> {
    let (base, tag) = match name.split_once(':') {
        Some((b, t)) => (b.to_string(), Some(t.to_string())),
        None => (name.clone(), None),
    };

    let url = format!("https://ollama.com/search?q={}&c=chat", base);
    let html_content = fetch_url(&url).await?;
    let models = scrape_models_from_search_html(&html_content);

    // Exact match only. This used to fall back to the first result, which meant
    // an unrelated model's size could be reported as if it were this one.
    let Some(mut model) = models.into_iter().find(|m| m.name.eq_ignore_ascii_case(&base)) else {
        return Ok(None);
    };
    model.name = base.clone();

    if let Ok(html) = fetch_model_page_html(&base).await {
        let variants = extract_variants_from_html(&html, &base);
        let chosen = tag
            .as_deref()
            .and_then(|t| variants.iter().find(|v| v.tag == t))
            .or_else(|| variants.iter().find(|v| v.tag == "latest"))
            .or_else(|| variants.first());

        match chosen {
            // The requested tag's own figures, not whichever size appears first.
            Some(variant) => {
                model.size = variant.size.clone();
                model.context_length = variant.context_length;
            }
            None => {
                if let Ok(size) = extract_size_from_html(&html) {
                    model.size = Some(size);
                }
                model.context_length = extract_context_from_html(&html);
            }
        }
    }

    Ok(Some(model))
}

/// One downloadable tag of a model — `llama3.2` publishes `1b`, `3b`, `latest`,
/// each a different size and fit.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ModelVariant {
    pub tag: String,
    pub size: Option<String>,
    pub context_length: Option<u64>,
    pub modality: Option<String>,
    pub updated: Option<String>,
    /// Ollama's listing doesn't state quantization per tag; other providers do.
    pub quantization: Option<String>,
}

/// The full picture for one model. Fields other providers expose but Ollama
/// doesn't are kept as None rather than omitted, so adding a second backend
/// later is a matter of populating them — the UI already skips what's absent.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct RemoteModelPage {
    pub name: String,
    pub description: String,
    pub capabilities: Vec<String>,
    pub parameter_sizes: Vec<String>,
    pub pulls: Option<String>,
    pub tag_count: Option<u32>,
    pub updated: Option<String>,
    /// GFM markdown, never HTML — this comes off a web page and is rendered in-app,
    /// so no raw markup crosses the boundary. See `extract_readme_from_html`.
    pub readme: Option<String>,
    pub variants: Vec<ModelVariant>,
    pub related: Vec<String>,
    // Not available from Ollama today.
    pub stars: Option<u32>,
    pub curated: Option<bool>,
    pub format: Option<String>,
    pub domain: Option<String>,
}

pub async fn get_remote_model_page(name: String) -> Result<Option<RemoteModelPage>, String> {
    let Some(listing) = get_remote_model_details(name.clone()).await? else {
        return Ok(None);
    };

    let mut page = RemoteModelPage {
        name: listing.name.clone(),
        description: listing.description,
        capabilities: listing.capabilities,
        parameter_sizes: listing.parameter_sizes,
        format: Some("GGUF".to_string()), // Ollama only ships GGUF.
        ..Default::default()
    };

    if let Ok(html) = fetch_model_page_html(&listing.name).await {
        page.variants = extract_variants_from_html(&html, &listing.name);
        page.readme = extract_readme_from_html(&html);
    }

    // Pulls / tag count / "Updated …" live on the search listing, not the page.
    let search_url = format!("https://ollama.com/search?q={}&c=chat", listing.name);
    if let Ok(html) = fetch_url(&search_url).await {
        let (pulls, tag_count, updated) = extract_listing_stats(&html, &listing.name);
        page.pulls = pulls;
        page.tag_count = tag_count;
        page.updated = updated;
    }

    Ok(Some(page))
}

/// Each tag renders twice (a narrow layout and a grid). The narrow one packs
/// everything into one `·`-separated line, so it's the easier of the two to read.
fn extract_variants_from_html(html_content: &str, model_name: &str) -> Vec<ModelVariant> {
    let document = scraper::Html::parse_document(html_content);
    let Ok(link_selector) = scraper::Selector::parse("a[href^='/library/']") else {
        return Vec::new();
    };
    let prefix = format!("/library/{}:", model_name);

    let mut variants: Vec<ModelVariant> = Vec::new();
    for element in document.select(&link_selector) {
        let Some(href) = element.value().attr("href") else { continue };
        let Some(tag) = href.strip_prefix(&prefix) else { continue };
        if variants.iter().any(|v| v.tag == tag) {
            continue;
        }

        let text = element.text().collect::<String>();
        let Some(meta) = text.lines().map(str::trim).find(|l| l.contains(" · ")) else { continue };

        let mut variant = ModelVariant { tag: tag.to_string(), ..Default::default() };
        for part in meta.split(" · ").map(str::trim) {
            if part.ends_with("GB") || part.ends_with("MB") {
                variant.size = Some(part.to_string());
            } else if part.contains("context window") {
                variant.context_length = parse_context_token(part.split_whitespace().next());
            } else if part.contains("ago") {
                variant.updated = Some(part.to_string());
            } else if !part.is_empty() {
                variant.modality = Some(part.to_string());
            }
        }
        variants.push(variant);
    }
    variants
}

fn parse_context_token(token: Option<&str>) -> Option<u64> {
    let lower = token?.to_ascii_lowercase();
    let (digits, multiplier) = match lower.strip_suffix('k') {
        Some(rest) => (rest, 1024u64),
        None => (lower.as_str(), 1),
    };
    digits.parse::<f64>().ok().filter(|v| *v > 0.0).map(|v| (v * multiplier as f64) as u64)
}

/// Tags this must never carry across the boundary, content included.
///
/// `skip_tags` drops the element *and* its text. Without it `htmd` strips the tag
/// but keeps what was inside, so a `<script>` body arrives as a visible paragraph
/// of source code — harmless but garbage. `img` is here because the app's CSP is
/// `img-src 'self' data: blob:`: every remote image is blocked, and ollama.com's
/// own are root-relative (`/assets/library/…`), so they 404 against the app's
/// origin regardless. A dropped image beats a broken one on every readme.
const README_SKIP_TAGS: &[&str] = &[
    "script", "style", "noscript", "iframe", "object", "embed", "svg", "form", "img",
];

/// GFM markdown, never HTML. The readme is remote markup, so handing the raw tags
/// to the frontend would let a third party inject into the app — that decision is
/// unchanged. What changed is that flattening it to text was destroying it.
///
/// The old version walked `element.text()` and joined every non-empty text node
/// with a newline, which put inline elements on their own lines: qwen3.5's
/// `<strong>Unified Vision-Language Foundation</strong>: Early fusion…` came out as
/// two lines, the second starting with ":". Five such breaks in that readme alone.
/// Benchmark tables — 604 `<td>` in qwen3.5, the most common structure in the
/// corpus — became one value per line with nothing tying a number to its column.
///
/// Converting to markdown keeps the structure and still emits no markup, so the
/// frontend can render it with the same react-markdown pipeline the chat uses.
/// It must do so **without `rehype-raw`**: react-markdown's default turns any raw
/// HTML into visible text, and that default is the guarantee here.
///
/// No length cap. The old 4,000-char one was truncating in practice — qwen3.5's
/// readme is 17,654 characters of markdown, so it was showing under a quarter of
/// it — and a character cut lands mid-fence or mid-table, which turns a
/// completeness problem into a corrupted document. The input is already bounded by
/// the page ollama.com served.
fn extract_readme_from_html(html_content: &str) -> Option<String> {
    let document = scraper::Html::parse_document(html_content);
    let selector = scraper::Selector::parse("#readme #display").ok()?;
    let fragment = document.select(&selector).next()?.inner_html();

    let markdown = htmd::HtmlToMarkdown::builder()
        .skip_tags(README_SKIP_TAGS.to_vec())
        .build()
        .convert(&fragment)
        .ok()?;

    let markdown = markdown.trim();
    (!markdown.is_empty()).then(|| markdown.to_string())
}

fn extract_listing_stats(html_content: &str, model_name: &str) -> (Option<String>, Option<u32>, Option<String>) {
    let document = scraper::Html::parse_document(html_content);
    let Ok(item_selector) = scraper::Selector::parse("ul[role=list] li") else {
        return (None, None, None);
    };
    let Ok(link_selector) = scraper::Selector::parse("a[href^='/library/']") else {
        return (None, None, None);
    };

    for element in document.select(&item_selector) {
        let matches_model = element.select(&link_selector).any(|a| {
            a.value().attr("href").map(|h| h == format!("/library/{}", model_name)).unwrap_or(false)
        });
        if !matches_model {
            continue;
        }

        let text = element.text().collect::<String>();
        let words: Vec<&str> = text.split_whitespace().collect();

        let before = |label: &str| -> Option<String> {
            let index = words.iter().position(|w| *w == label)?;
            Some(words.get(index.checked_sub(1)?)?.to_string())
        };
        let pulls = before("Pulls");
        let tag_count = before("Tags").and_then(|t| t.replace(',', "").parse::<u32>().ok());
        let updated = words
            .iter()
            .position(|w| *w == "Updated")
            .map(|i| words[i + 1..].join(" "));

        return (pulls, tag_count, updated);
    }
    (None, None, None)
}

/// Pulls the context window out of the tag line, e.g.
/// "2.0GB · 128K context window · Text · 1 year ago" -> 131072.
fn extract_context_from_html(html_content: &str) -> Option<u64> {
    let document = scraper::Html::parse_document(html_content);
    let p_selector = scraper::Selector::parse("p").ok()?;

    for element in document.select(&p_selector) {
        let text = element.text().collect::<String>();
        let Some(idx) = text.find("context window") else { continue };
        // Take the token immediately before "context window".
        let Some(token) = text[..idx].split_whitespace().next_back() else { continue };

        let lower = token.to_ascii_lowercase();
        let (digits, multiplier) = match lower.strip_suffix('k') {
            Some(rest) => (rest, 1024),
            None => (lower.as_str(), 1),
        };
        if let Ok(value) = digits.parse::<f64>() {
            if value > 0.0 {
                return Some((value * multiplier as f64) as u64);
            }
        }
    }
    None
}

/// A parameter-size chip ("1b", "3b", "70b", "0.5b") as opposed to a capability
/// chip ("tools", "vision"). Both are plain spans in the same row, so they're
/// told apart by shape rather than by markup.
/// Whether a listing chip is a parameter size rather than a capability.
///
/// Digits-and-dots was too strict, and the chips it rejected fell through into
/// `capabilities` — so eight real models advertised `8x7b` as a *capability* and
/// showed no sizes at all: mixtral and dolphin-mixtral (`8x7b`, `8x22b`), llama4
/// (`16x17b`, `128x17b`), wizardlm2, nous-hermes2-mixtral, notux, and gemma3n /
/// gemma4 (`e2b`, `e4b`).
///
/// Two extra forms, both real tags in the registry:
///   - mixture-of-experts, `<experts>x<size-each>b`
///   - Gemma's effective-parameter notation, `e<size>b`
///
/// No capability chip ends in `b` or `m` (tools, vision, thinking, embedding,
/// cloud, audio), so widening this cannot swallow one.
fn is_parameter_chip(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    let Some(stripped) = lower.strip_suffix('b').or_else(|| lower.strip_suffix('m')) else {
        return false;
    };
    let stripped = stripped.strip_prefix('e').unwrap_or(stripped);
    let body = match stripped.split_once('x') {
        Some((experts, each)) => {
            if experts.is_empty() || !experts.chars().all(|c| c.is_ascii_digit()) {
                return false;
            }
            each
        }
        None => stripped,
    };
    !body.is_empty() && body.chars().all(|c| c.is_ascii_digit() || c == '.')
}

/// ollama.com is plain server-rendered HTML with no API and no stable hooks —
/// it previously carried `x-test-*` attributes, which have since been removed.
/// These selectors target structure that carries meaning (the results list, the
/// heading, the library link) rather than styling, which should age better.
fn scrape_models_from_search_html(html_content: &str) -> Vec<RemoteModel> {
    let document = scraper::Html::parse_document(html_content);
    let item_selector = scraper::Selector::parse("ul[role=list] li").unwrap();
    let link_selector = scraper::Selector::parse("a[href^='/library/']").unwrap();
    let title_selector = scraper::Selector::parse("h2").unwrap();
    let desc_selector = scraper::Selector::parse("p.max-w-lg").unwrap();
    let chip_selector = scraper::Selector::parse("span.inline-flex").unwrap();

    let mut models = Vec::new();

    for element in document.select(&item_selector) {
        // The heading is the display name; fall back to the /library/ slug.
        let name = element
            .select(&title_selector)
            .next()
            .map(|el| el.text().collect::<String>().trim().to_string())
            .filter(|n| !n.is_empty())
            .or_else(|| {
                element.select(&link_selector).next().and_then(|a| {
                    a.value()
                        .attr("href")
                        .and_then(|h| h.strip_prefix("/library/"))
                        .map(|s| s.to_string())
                })
            })
            .unwrap_or_default();

        let description = element
            .select(&desc_selector)
            .next()
            .map(|el| el.text().collect::<String>().trim().to_string())
            .unwrap_or_default();

        let mut parameter_sizes = Vec::new();
        let mut capabilities = Vec::new();
        for chip in element.select(&chip_selector) {
            let text = chip.text().collect::<String>().trim().to_string();
            if text.is_empty() {
                continue;
            }
            if is_parameter_chip(&text) {
                parameter_sizes.push(text);
            } else {
                capabilities.push(text.to_ascii_lowercase());
            }
        }

        if !name.is_empty() {
            models.push(RemoteModel {
                name,
                description,
                parameter_sizes,
                capabilities,
                size: None,
                context_length: None,
            });
        }
    }
    models
}



/// THE chokepoint for outbound internet requests. Every call that leaves this
/// machine must go through here so offline mode has exactly one place to
/// enforce, and one place to audit. Traffic to the local Ollama on 127.0.0.1 is
/// deliberately NOT routed here — chat has to keep working offline.
async fn fetch_url(url: &str) -> Result<String, String> {
    if is_offline() {
        return Err(OFFLINE_ERROR.to_string());
    }
    reqwest::Client::new()
        .get(url)
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())
}

/// Exact download size for a model's `latest` tag, from Ollama's own registry.
///
/// The alternative is `extract_size_from_html`, which parses a ~200KB model page
/// for a "4.7GB" string. This reads the Docker-v2 manifest instead — 857 bytes of
/// JSON, unauthenticated — and sums the layer sizes, which is the real byte count
/// rather than a rounded display string. That matters at catalog scale: the
/// listing is 235 models, and the page scrape costs two requests each.
///
/// `None` rather than an error when the model has no `latest` tag (the registry
/// answers 404), because a missing size is a fit badge that says "Unknown", not a
/// failure worth surfacing.
pub async fn remote_model_size(name: String) -> Result<Option<u64>, String> {
    // Through `fetch_url` so offline mode still has exactly one place to enforce.
    let body = match fetch_url(&format!(
        "https://registry.ollama.ai/v2/library/{}/manifests/latest",
        name
    ))
    .await
    {
        Ok(body) => body,
        // Offline is the one failure worth propagating; anything else is a model
        // the registry doesn't describe, which is not this function's problem.
        Err(e) if e == OFFLINE_ERROR => return Err(e),
        Err(_) => return Ok(None),
    };

    let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&body) else {
        return Ok(None);
    };
    let Some(layers) = manifest.get("layers").and_then(|l| l.as_array()) else {
        return Ok(None);
    };
    let total: u64 = layers
        .iter()
        .filter_map(|layer| layer.get("size").and_then(|s| s.as_u64()))
        .sum();

    Ok((total > 0).then_some(total))
}

async fn fetch_model_page_html(model_name: &str) -> Result<String, String> {
    fetch_url(&format!("https://ollama.com/library/{}", model_name)).await
}

fn extract_size_from_html(html_content: &str) -> Result<String, String> {
    let document = scraper::Html::parse_document(html_content);
    // Look for text like "4.7GB" in <p> tags
    let p_selector = scraper::Selector::parse("p").unwrap();
    
    for element in document.select(&p_selector) {
        let text = element.text().collect::<String>();
        // Check for GB or MB pattern
        if text.contains("GB") || text.contains("MB") {
            // Case 1: "4.7GB · 8K context window..."
            if text.contains(" · ") {
                 let parts: Vec<&str> = text.split(" · ").collect();
                 if let Some(first) = parts.first() {
                     let clean = first.trim();
                     if clean.ends_with("GB") || clean.ends_with("MB") {
                         return Ok(clean.to_string());
                     }
                 }
            }
            
            // Case 2: Just "4.7GB" (in the table/grid view)
            let clean = text.trim();
            if (clean.ends_with("GB") || clean.ends_with("MB")) && clean.len() < 10 {
                 // Verify it starts with number
                 if clean.chars().next().map_or(false, |c| c.is_numeric()) {
                     return Ok(clean.to_string());
                 }
            }
        }
    }
    
    Err("Size not found".to_string())
}

pub fn is_ollama_running() -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", OLLAMA_PORT).parse().unwrap(),
        Duration::from_millis(500),
    )
    .is_ok()
}

/// What the copy *we* install is called on disk.
///
/// Not "ollama", because a user with the official Ollama app installed then has two
/// processes by that name and no way to tell which belongs to this app — in Activity
/// Monitor, in `pgrep`, or when deciding what is safe to quit. Renaming ours makes
/// the ownership obvious at a glance.
///
/// It is only the filename. The binary is still Ollama, still signed by Infra
/// Technologies, and still named as Ollama everywhere that matters for credit — the
/// Settings runtime section, the attribution, this module. Verified that Ollama does
/// not dispatch on argv[0]: the same binary under this name serves and answers
/// `/api/version` identically.
pub const MANAGED_BINARY_NAME: &str = if cfg!(windows) { "scarlettt-engine.exe" } else { "scarlettt-engine" };

/// What *someone else's* install is called. Never renamed — it isn't ours, and
/// `find_ollama_binary` has to recognise it to borrow it.
const SYSTEM_BINARY_NAME: &str = if cfg!(windows) { "ollama.exe" } else { "ollama" };

pub fn find_ollama_binary(app_data_dir: PathBuf) -> Option<PathBuf> {
    // 1. Our own copy.
    let app_binary = app_data_dir.join(MANAGED_BINARY_NAME);
    if app_binary.exists() {
        return Some(app_binary);
    }

    // 1a. A copy installed before the rename. Migrated in place rather than
    //     re-downloaded — it is the same 68MB binary under a different name, and
    //     making an existing install re-fetch it would be gratuitous. If the rename
    //     fails for any reason, fall through to using it where it is.
    let legacy = app_data_dir.join(SYSTEM_BINARY_NAME);
    if legacy.exists() {
        match std::fs::rename(&legacy, &app_binary) {
            Ok(()) => {
                info!("Renamed the managed runtime to {}", MANAGED_BINARY_NAME);
                return Some(app_binary);
            }
            Err(e) => {
                warn!("Could not rename the managed runtime ({}); using it as-is", e);
                return Some(legacy);
            }
        }
    }

    // 1b. On Linux, also check in bin subdirectory (where tgz extracts to)
    #[cfg(target_os = "linux")]
    {
        for name in [MANAGED_BINARY_NAME, SYSTEM_BINARY_NAME] {
            let bin_binary = app_data_dir.join("bin").join(name);
            if bin_binary.exists() {
                return Some(bin_binary);
            }
        }
    }

    // 2. Someone else's, on PATH. Their name, not ours.
    if let Ok(path) = which::which(SYSTEM_BINARY_NAME) {
        return Some(path);
    }

    // 3. Common Mac locations (only if on mac)
    #[cfg(target_os = "macos")]
    {
        let common_paths = [
            "/usr/local/bin/ollama",
            "/opt/homebrew/bin/ollama",
            "/Applications/Ollama.app/Contents/Resources/ollama",
        ];

        for path in common_paths {
            let p = PathBuf::from(path);
            if p.exists() {
                return Some(p);
            }
        }
    }

    None
}

/// Stops whatever is serving `OLLAMA_PORT`, including a server this app started
/// in an earlier run and then lost track of.
///
/// Killing the tracked child is not enough. Quitting the app leaves `ollama serve`
/// re-parented to launchd, so the next run finds `AppState.ollama_process` empty
/// while a server is very much still listening — `is_ollama_running()` then reports
/// true and anything gated on "is it already up?" quietly does nothing.
///
/// Safe to be this blunt because the port is the app's own: Ollama's default is
/// 11434, so a listener on 11435 was started by this app whichever run spawned it.
/// A user's own `ollama serve` is never on this port.
/// Ollama's Apple Developer Team ID, read from the signature on their official
/// darwin build (`Developer ID Application: Infra Technologies, Inc`).
///
/// **Bump this if Ollama re-keys.** A mismatch is fatal on purpose — running an
/// unexpected binary is precisely what this prevents — so a legitimate change to
/// their signing identity will look like an attack until it's updated here. Same
/// contract as `MINIMUM_OLLAMA_VERSION`: a constant that will one day need a
/// human to move it.
#[cfg(target_os = "macos")]
const OLLAMA_TEAM_ID: &str = "3MU9H2V9Y9";

/// Checks that a binary this app downloaded is genuinely Ollama's, before it is
/// ever executed.
///
/// The download is HTTPS, which protects it in transit and nothing after that:
/// until now the extracted file was executed on the strength of having arrived.
/// This verifies the code signature is intact and issued to the team we expect,
/// so a corrupted download or a substituted binary is refused instead of run.
///
/// **Only ever call this on our own copy.** A system Ollama belongs to the user —
/// it may be a Homebrew build, ad-hoc signed, or compiled from source, and none
/// of those are wrong. Refusing to run it would be this app overruling a choice
/// that isn't its to make.
#[cfg(target_os = "macos")]
pub fn verify_ollama_signature(path: &std::path::Path) -> Result<(), String> {
    // Absolute path: this must not resolve through a PATH an attacker can shape.
    let verified = Command::new("/usr/bin/codesign")
        .args(["--verify", "--strict"])
        .arg(path)
        .output()
        .map_err(|e| format!("Could not run codesign to verify Ollama: {}", e))?;

    if !verified.status.success() {
        return Err(format!(
            "The downloaded Ollama failed signature verification and was not run: {}",
            String::from_utf8_lossy(&verified.stderr).trim()
        ));
    }

    // codesign writes the signature details to stderr, not stdout.
    let described = Command::new("/usr/bin/codesign")
        .args(["-dv", "--verbose=2"])
        .arg(path)
        .output()
        .map_err(|e| format!("Could not read Ollama's signature: {}", e))?;

    let details = String::from_utf8_lossy(&described.stderr);
    let team = details
        .lines()
        .find_map(|line| line.trim().strip_prefix("TeamIdentifier="))
        .map(str::trim);

    match team {
        Some(OLLAMA_TEAM_ID) => {
            info!("Verified downloaded Ollama is signed by {}", OLLAMA_TEAM_ID);
            Ok(())
        }
        Some(other) => Err(format!(
            "The downloaded Ollama is signed by team {} rather than Ollama's ({}), so it was not run.",
            other, OLLAMA_TEAM_ID
        )),
        None => Err("The downloaded Ollama carries no team identifier, so it was not run.".into()),
    }
}

/// Windows and Linux have no equivalent of `codesign` in the base system, so the
/// download is accepted there as it always has been. Stated rather than silently
/// skipped, so the difference in guarantee between platforms is visible.
#[cfg(not(target_os = "macos"))]
pub fn verify_ollama_signature(_path: &std::path::Path) -> Result<(), String> {
    Ok(())
}

/// What we can say about the managed binary's signature — reported, never acted on.
///
/// Deliberately not a refusal. Ollama's Developer ID certificate expires in March
/// 2028 and any renewal or corporate change could move the team identifier; a
/// startup check that blocked on mismatch would delete a working runtime and brick
/// every install over routine housekeeping. The threat it would guard against —
/// someone rewriting the binary in place — already implies write access to the app
/// itself, which no check inside the app survives. So: tell the user, let them act.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OllamaIntegrity {
    /// False for a system Ollama on PATH — that one is the user's, not ours to vouch for.
    pub managed: bool,
    /// `None` means the check couldn't run here, which is not the same as failing.
    pub verified: Option<bool>,
    /// Why it didn't pass. Present only alongside `Some(false)`.
    pub detail: Option<String>,
}

struct SignatureCache {
    size: u64,
    modified: u64,
    result: OllamaIntegrity,
}

/// `codesign` costs tens of milliseconds, which is not worth paying on every
/// launch for a file that almost never changes. Size and mtime are enough to know
/// when it did — the point is noticing a swap, and a swap changes both.
static SIGNATURE_CACHE: std::sync::Mutex<Option<SignatureCache>> = std::sync::Mutex::new(None);

pub fn check_ollama_integrity(app_data_dir: PathBuf) -> OllamaIntegrity {
    let unmanaged = OllamaIntegrity { managed: false, verified: None, detail: None };

    let Some(path) = find_ollama_binary(app_data_dir.clone()) else { return unmanaged };
    if !path.starts_with(&app_data_dir) {
        return unmanaged;
    }

    // Platforms without codesign report "unknown" rather than "verified" — saying
    // a check passed when it never ran would be worse than admitting it can't.
    if cfg!(not(target_os = "macos")) {
        return OllamaIntegrity { managed: true, verified: None, detail: None };
    }

    let meta = std::fs::metadata(&path).ok();
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let modified = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    if let Ok(cache) = SIGNATURE_CACHE.lock() {
        if let Some(hit) = cache.as_ref() {
            if hit.size == size && hit.modified == modified {
                return hit.result.clone();
            }
        }
    }

    let result = match verify_ollama_signature(&path) {
        Ok(()) => OllamaIntegrity { managed: true, verified: Some(true), detail: None },
        Err(detail) => {
            warn!("Managed Ollama failed signature check: {}", detail);
            OllamaIntegrity { managed: true, verified: Some(false), detail: Some(detail) }
        }
    };

    if let Ok(mut cache) = SIGNATURE_CACHE.lock() {
        *cache = Some(SignatureCache { size, modified, result: result.clone() });
    }
    result
}

pub fn stop_ollama_on_port() {
    #[cfg(unix)]
    {
        let listeners = Command::new("lsof")
            .args(["-ti", &format!(":{}", OLLAMA_PORT)])
            .output()
            .ok()
            .filter(|out| out.status.success());

        let Some(out) = listeners else { return };
        for pid in String::from_utf8_lossy(&out.stdout).lines() {
            let pid = pid.trim();
            if pid.is_empty() {
                continue;
            }
            info!("Stopping Ollama listening on {} (pid {})", OLLAMA_PORT, pid);
            let _ = Command::new("kill").arg(pid).status();
        }
    }

    #[cfg(windows)]
    {
        // netstat's last column is the owning PID for the matching connection.
        if let Ok(out) = Command::new("netstat").args(["-ano"]).output() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                if line.contains(&format!(":{}", OLLAMA_PORT)) && line.contains("LISTENING") {
                    if let Some(pid) = line.split_whitespace().last() {
                        info!("Stopping Ollama listening on {} (pid {})", OLLAMA_PORT, pid);
                        let _ = Command::new("taskkill").args(["/PID", pid, "/F"]).status();
                    }
                }
            }
        }
    }
}

/// `models_dir` is this app's own model store.
///
/// Without it, Ollama uses `~/.ollama/models` — shared with any Ollama the user
/// installed themselves. That sharing looks free and is not: deleting a model here
/// removes it from their Ollama too, uninstalling Scarlettt leaves its downloads
/// behind as unattributable gigabytes, a reset has to touch a directory that isn't
/// ours, and two Ollama versions end up writing one store (0.32.9 and 0.32.15, on
/// the machine this was written on). Our own store makes ownership match the app.
///
/// The cost — the same model downloaded twice for two apps — is what
/// `first_run::import_models` exists to avoid, by hardlinking blobs instead.
pub fn start_ollama_process(binary_path: PathBuf, models_dir: PathBuf) -> Result<Child, String> {
    info!("Starting engine: {:?} (models in {:?})", binary_path, models_dir);
    let mut command = Command::new(binary_path);
    command.arg("serve")
        .env("OLLAMA_HOST", format!("127.0.0.1:{}", OLLAMA_PORT))
        .env("OLLAMA_MODELS", &models_dir)
        // Flash attention and an 8-bit KV cache. Measured on qwen3.5:4b (GGUF): the
        // per-token KV cost drops from ~34 KB to ~19 KB (a 44% cut, by differencing
        // `ollama ps` at 8k vs 32k), which roughly doubles the context that fits in
        // a given memory budget — free context, no lost history. `q8_0` is
        // near-lossless; `q4_0` is deliberately avoided for its quality cost. Both
        // need flash attention, and both are honoured by the bundled GGUF runner
        // (verified — an MLX runner might ignore them, but this app runs GGUF).
        // The frontend's per-token estimate (`MEASURED_BYTES_PER_TOKEN`) is halved
        // to match; the two must move together.
        .env("OLLAMA_FLASH_ATTENTION", "1")
        .env("OLLAMA_KV_CACHE_TYPE", "q8_0")
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW

    command.spawn()
        .map_err(|e| format!("Failed to start Ollama: {}", e))
}

pub async fn download_ollama(app_data_dir: PathBuf, on_progress: impl Fn(f64) + Send + 'static) -> Result<(), String> {
    info!("Downloading Ollama binary to {:?}", app_data_dir);
    
    let (url, is_zip, is_archive) = if cfg!(target_os = "macos") {
        ("https://ollama.com/download/ollama-darwin.tgz", false, true)
    } else if cfg!(target_os = "windows") {
        ("https://github.com/ollama/ollama/releases/latest/download/ollama-windows-amd64.zip", true, true)
    } else if cfg!(target_os = "linux") {
        if cfg!(target_arch = "aarch64") {
            ("https://github.com/ollama/ollama/releases/latest/download/ollama-linux-arm64.tar.zst", false, true)
        } else {
            ("https://github.com/ollama/ollama/releases/latest/download/ollama-linux-amd64.tar.zst", false, true)
        }
    } else {
        return Err("Unsupported operating system".to_string());
    };

    if is_offline() {
        return Err(OFFLINE_ERROR.to_string());
    }

    let client = reqwest::Client::new();
    let mut response = client.get(url).send().await.map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!("Failed to download Ollama: {}", response.status()));
    }

    let total_size = response.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    
    // Create temporary file for download to avoid keeping everything in RAM
    let temp_archive_name = if is_zip { "ollama_tmp.zip" } else if is_archive { "ollama_tmp.archive" } else { "ollama_tmp" };
    let temp_archive_path = app_data_dir.join(temp_archive_name);
    let mut temp_file = File::create(&temp_archive_path).map_err(|e| format!("Failed to create temp file: {}", e))?;

    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        temp_file.write_all(&chunk).map_err(|e| format!("Failed to write to temp file: {}", e))?;
        downloaded += chunk.len() as u64;
        if total_size > 0 {
            on_progress(downloaded as f64 / total_size as f64);
        }
    }
    temp_file.flush().map_err(|e| e.to_string())?;
    // Drop file handle to ensure it's closed before we reopen for reading
    drop(temp_file);

    if is_archive {
        info!("Extracting Ollama binary using native libraries (streaming from disk)...");
        
        let archive_file = File::open(&temp_archive_path).map_err(|e| format!("Failed to open temp archive: {}", e))?;

        if is_zip {
            // Windows .zip extraction
            let mut archive = zip::ZipArchive::new(archive_file).map_err(|e| format!("Failed to open zip: {}", e))?;
            
            for i in 0..archive.len() {
                let mut file = archive.by_index(i).map_err(|e| format!("Failed to read zip entry: {}", e))?;
                let outpath = match file.enclosed_name() {
                    Some(path) => app_data_dir.join(path),
                    None => continue,
                };

                if (*file.name()).ends_with('/') {
                    std::fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
                } else {
                    if let Some(p) = outpath.parent() {
                        if !p.exists() {
                            std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
                        }
                    }
                    let mut outfile = std::fs::File::create(&outpath).map_err(|e| e.to_string())?;
                    std::io::copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;
                }
            }
        } else if cfg!(target_os = "linux") {
            // Linux .tar.zst extraction
            let decompressed = zstd::stream::read::Decoder::new(archive_file)
                .map_err(|e| format!("Zstd decompression failed: {}", e))?;
            
            let mut archive = tar::Archive::new(decompressed);
            archive.unpack(&app_data_dir).map_err(|e| format!("Tar extraction failed: {}", e))?;
        } else {
            // macOS .tgz extraction
            let decompressed = flate2::read::GzDecoder::new(archive_file);
            let mut archive = tar::Archive::new(decompressed);
            archive.unpack(&app_data_dir).map_err(|e| format!("Tgz extraction failed: {}", e))?;
        }
        
        // Clean up temp file
        let _ = std::fs::remove_file(&temp_archive_path);
    } else {
        // Direct binary download (move temp file to final destination)
        let binary_path = app_data_dir.join(MANAGED_BINARY_NAME);
        
        // On some OSes rename might fail across devices, so we copy + remove
        if let Err(_) = std::fs::rename(&temp_archive_path, &binary_path) {
            std::fs::copy(&temp_archive_path, &binary_path).map_err(|e| format!("Failed to copy binary: {}", e))?;
            let _ = std::fs::remove_file(&temp_archive_path);
        }
    }

    // The archive contains a file called "ollama" — that is Ollama's name for it, not
    // ours. Look for either, then adopt it under MANAGED_BINARY_NAME so the process a
    // user sees belongs unambiguously to this app.
    let possible_paths = vec![
        app_data_dir.join("bin").join(MANAGED_BINARY_NAME), // Linux typical
        app_data_dir.join("bin").join(SYSTEM_BINARY_NAME),
        app_data_dir.join(MANAGED_BINARY_NAME),
        app_data_dir.join(SYSTEM_BINARY_NAME),             // straight out of the archive
    ];

    let mut final_binary_path = None;

    for path in possible_paths {
        if path.exists() {
            final_binary_path = Some(path);
            break;
        }
    }

    let binary_path = match final_binary_path {
        Some(p) => p,
        None => {
            return Err("Ollama binary not found after extraction.".to_string());
        }
    };

    // Rename only when the archive gave us Ollama's name in the app dir. A Linux
    // `bin/` layout is left alone: `find_ollama_binary` knows both names there, and
    // moving it would break the tgz's own directory structure.
    let binary_path = if binary_path.file_name().and_then(|n| n.to_str()) == Some(SYSTEM_BINARY_NAME)
        && binary_path.parent() == Some(app_data_dir.as_path())
    {
        let renamed = app_data_dir.join(MANAGED_BINARY_NAME);
        match std::fs::rename(&binary_path, &renamed) {
            Ok(()) => renamed,
            Err(e) => {
                warn!("Could not adopt the runtime as {} ({}); leaving it named as downloaded", MANAGED_BINARY_NAME, e);
                binary_path
            }
        }
    } else {
        binary_path
    };

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = std::fs::metadata(&binary_path) {
            let mut perms = metadata.permissions();
            perms.set_mode(0o755);
            let _ = std::fs::set_permissions(&binary_path, perms);
        }
    }

    info!("Ollama binary downloaded and extracted successfully for {}", std::env::consts::OS);
    Ok(())
}



