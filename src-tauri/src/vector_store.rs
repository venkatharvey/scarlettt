//! Semantic search support: which embedding model to use, and the cosine similarity
//! that ranks stored message embeddings against a query embedding.
//!
//! Vectors are produced by the local engine (`ollama::embed`) and persisted in the
//! database (`message_embeddings`) — nothing leaves the machine, same as chat. This
//! module holds only the model choice and the math; storage lives in `database.rs`
//! and the orchestration (embed on save, backfill, query) in `lib.rs`.

use std::sync::atomic::{AtomicBool, Ordering};

/// The embedding model semantic search uses. `all-minilm` is deliberate over a larger
/// model like `nomic-embed-text`: it's ~45MB, so the one-time background pull is
/// unobtrusive, and its quality is fine for finding relevant chats. Swap the constant
/// for a better model if wanted — but a change invalidates every stored vector (a
/// different model, and a different dimension), so it must re-embed from scratch.
pub const EMBEDDING_MODEL: &str = "all-minilm";

/// Whether semantic search is on. Gates the three things that touch the embedding
/// model — embed-on-save, the startup/toggle backfill, and query — so turning it off
/// stops the pull, the indexing and the search in one place.
///
/// **Default off, and the frontend turns it on.** Like offline mode, the source of
/// truth is the persisted setting in the webview: `set_semantic_search` is called on
/// launch with the saved value (which defaults *on* for a returning user, so nothing
/// visibly changes). Defaulting the flag off here means the backend pulls and embeds
/// nothing until the frontend says so — no startup race where a disabled user's
/// engine gets a 45MB pull in the window before the setting is restored.
static SEMANTIC_SEARCH: AtomicBool = AtomicBool::new(false);

pub fn set_enabled(enabled: bool) {
    SEMANTIC_SEARCH.store(enabled, Ordering::Relaxed);
}

pub fn is_enabled() -> bool {
    SEMANTIC_SEARCH.load(Ordering::Relaxed)
}

/// Cosine similarity of two equal-length vectors, in [-1, 1]. Returns 0 when they
/// differ in length, are empty, or either has zero magnitude — so a malformed vector
/// never ranks rather than panicking or scoring spuriously high.
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        norm_a += a[i] * a[i];
        norm_b += b[i] * b[i];
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a.sqrt() * norm_b.sqrt())
}
