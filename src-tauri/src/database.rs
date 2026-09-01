use rusqlite::{Connection, Result as SqlResult, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use chrono::Utc;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatSession {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    /// Set when the chat lives inside a project; None means it's a loose chat.
    #[serde(default)]
    pub project_id: Option<String>,
    /// The session this one was branched from, if any. Doubles as the flag the
    /// sidebar reads to mark a chat with the branch glyph — a branch is defined by
    /// having a parent, so there's no separate boolean to keep in step.
    #[serde(default)]
    pub branched_from: Option<String>,
    /// The context length this chat's replies were generated under. Recorded on
    /// the session, not recomputed per mount: free memory moves between sessions,
    /// so re-deriving it would let one conversation quietly change shape — earlier
    /// turns written at 128k, later ones at 40k, with nothing saying so.
    #[serde(default)]
    pub num_ctx: Option<u32>,
    /// The model those replies came from. A context length means nothing without
    /// it — 128k on a 4b model and on a 9b model are different machines' worth of
    /// memory — and the selected model is otherwise only a global preference.
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Message {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub session_id: String,
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub timestamp: String,
    /// Generation stats for assistant messages; None for user messages and for
    /// anything written before these columns existed.
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub prompt_tokens: Option<u32>,
    #[serde(default)]
    pub eval_tokens: Option<u32>,
    /// Tool activity for an assistant turn that called MCP tools: a JSON array of
    /// interactions (call, arguments, result, decision). None for every message
    /// that used no tools. Stored as a JSON attachment on the assistant message
    /// rather than as separate `role:"tool"` rows, so the tool cards stay grouped
    /// with the response that produced them and the transcript needs no reordering.
    #[serde(default)]
    pub tool_calls: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResult {
    pub session_id: String,
    pub title: String,
    pub updated_at: String,
    pub matching_content: String,
}

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn new(db_path: PathBuf) -> SqlResult<Self> {
        let conn = Connection::open(db_path)?;
        
        // Create tables if they don't exist
        conn.execute(
            "CREATE TABLE IF NOT EXISTS chat_sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
            )",
            [],
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;

        // Semantic-search embeddings, one row per message. `vec` is the raw f32
        // vector as little-endian bytes; `model`/`dim` record what produced it, so a
        // later model change can be detected and re-embedded. Deleted with its message.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS message_embeddings (
                message_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                model TEXT NOT NULL,
                dim INTEGER NOT NULL,
                vec BLOB NOT NULL,
                FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
            )",
            [],
        )?;

        // Migration for databases created before projects existed. SQLite has no
        // "ADD COLUMN IF NOT EXISTS", and a duplicate-column error just means an
        // already-migrated database, so it's the one error worth swallowing.
        // Same swallow-the-duplicate-column trick as project_id: branching came
        // later than the first databases, so this backfills them.
        let _ = conn.execute(
            "ALTER TABLE chat_sessions ADD COLUMN branched_from TEXT",
            [],
        );

        let _ = conn.execute(
            "ALTER TABLE chat_sessions ADD COLUMN project_id TEXT",
            [],
        );
        for column in [
            "ALTER TABLE messages ADD COLUMN duration_ms INTEGER",
            "ALTER TABLE messages ADD COLUMN prompt_tokens INTEGER",
            "ALTER TABLE messages ADD COLUMN eval_tokens INTEGER",
            // The context this chat's replies were actually generated under, and
            // the model that produced them. Both nullable, and no backfill: rows
            // written before this existed genuinely have no answer, and inventing
            // one from today's memory would be a guess presented as a record.
            "ALTER TABLE chat_sessions ADD COLUMN num_ctx INTEGER",
            "ALTER TABLE chat_sessions ADD COLUMN model TEXT",
            // Tool activity for assistant turns that called MCP tools, as a JSON
            // array. Nullable, no backfill — messages written before tools existed
            // genuinely had none.
            "ALTER TABLE messages ADD COLUMN tool_calls TEXT",
        ] {
            let _ = conn.execute(column, []);
        }

        Ok(Database { conn })
    }

    pub fn create_session(&self, title: Option<String>) -> SqlResult<ChatSession> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let title = title.unwrap_or_else(|| "New Chat".to_string());

        self.conn.execute(
            "INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![&id, &title, &now, &now],
        )?;

        Ok(ChatSession {
            id,
            title,
            created_at: now.clone(),
            updated_at: now,
            project_id: None,
            branched_from: None,
            num_ctx: None,
            model: None,
        })
    }

    /// Records the terms a chat's replies were generated under, first time only.
    ///
    /// `WHERE num_ctx IS NULL` is the whole mechanism: the first reply fixes the
    /// context for the conversation, and later sends can't quietly rewrite history
    /// when free memory has moved. Changing it is a deliberate act elsewhere, not a
    /// side effect of sending another message.
    /// Records the context a chat runs at, keyed to the model it was recorded under.
    /// First write per *model* wins — so an unchanged model's window stays put while
    /// free memory drifts, but switching models re-derives it (a bigger-context model
    /// gets its bigger window; a smaller one is honestly capped to its own max).
    pub fn record_session_context(&self, session_id: &str, num_ctx: u32, model: &str) -> SqlResult<()> {
        self.conn.execute(
            "UPDATE chat_sessions SET num_ctx = ?1, model = ?2 \
             WHERE id = ?3 AND (num_ctx IS NULL OR model IS NOT ?2)",
            params![num_ctx, model, session_id],
        )?;
        Ok(())
    }

    pub fn get_sessions(&self) -> SqlResult<Vec<ChatSession>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, created_at, updated_at, project_id, branched_from, num_ctx, model \
             FROM chat_sessions ORDER BY updated_at DESC"
        )?;

        let sessions = stmt.query_map([], |row| {
            Ok(ChatSession {
                id: row.get(0)?,
                title: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                project_id: row.get(4)?,
                branched_from: row.get(5)?,
                num_ctx: row.get(6)?,
                model: row.get(7)?,
            })
        })?;

        sessions.collect()
    }

    pub fn get_messages(&self, session_id: &str) -> SqlResult<Vec<Message>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, role, content, timestamp, duration_ms, prompt_tokens, eval_tokens, tool_calls \
             FROM messages WHERE session_id = ?1 ORDER BY timestamp ASC"
        )?;

        let messages = stmt.query_map(params![session_id], |row| {
            // The column is JSON text; parse it back to a value. A row that predates
            // the column, or somehow holds invalid JSON, reads as no tool activity
            // rather than failing the whole load.
            let tool_calls: Option<String> = row.get(8)?;
            let tool_calls = tool_calls.and_then(|s| serde_json::from_str(&s).ok());
            Ok(Message {
                id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                timestamp: row.get(4)?,
                duration_ms: row.get(5)?,
                prompt_tokens: row.get(6)?,
                eval_tokens: row.get(7)?,
                tool_calls,
            })
        })?;

        messages.collect()
    }

    pub fn save_message(
        &self,
        session_id: &str,
        role: &str,
        content: &str,
        duration_ms: Option<u64>,
        prompt_tokens: Option<u32>,
        eval_tokens: Option<u32>,
        tool_calls: Option<&serde_json::Value>,
    ) -> SqlResult<Message> {
        let id = Uuid::new_v4().to_string();
        let timestamp = Utc::now().to_rfc3339();
        // Serialize the tool activity to JSON text for storage; None stays NULL.
        let tool_calls_json = tool_calls.map(|v| v.to_string());

        self.conn.execute(
            "INSERT INTO messages (id, session_id, role, content, timestamp, duration_ms, prompt_tokens, eval_tokens, tool_calls) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![&id, session_id, role, content, &timestamp, duration_ms, prompt_tokens, eval_tokens, tool_calls_json],
        )?;

        // Update session's updated_at
        self.conn.execute(
            "UPDATE chat_sessions SET updated_at = ?1 WHERE id = ?2",
            params![&timestamp, session_id],
        )?;

        // Update session title if this is the first user message
        if role == "user" {
            let count: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM messages WHERE session_id = ?1 AND role = 'user'",
                params![session_id],
                |row| row.get(0),
            )?;

            if count == 1 {
                // First user message - use it as title (truncated)
                let title = if content.len() > 1000 {
                    format!("{}...", &content[..1000])
                } else {
                    content.to_string()
                };

                self.conn.execute(
                    "UPDATE chat_sessions SET title = ?1 WHERE id = ?2",
                    params![&title, session_id],
                )?;
            }
        }

        Ok(Message {
            id,
            session_id: session_id.to_string(),
            role: role.to_string(),
            content: content.to_string(),
            timestamp,
            duration_ms,
            prompt_tokens,
            eval_tokens,
            tool_calls: tool_calls.cloned(),
        })
    }

    pub fn delete_session(&self, session_id: &str) -> SqlResult<()> {
        self.conn.execute(
            "DELETE FROM messages WHERE session_id = ?1",
            params![session_id],
        )?;

        self.conn.execute(
            "DELETE FROM chat_sessions WHERE id = ?1",
            params![session_id],
        )?;

        Ok(())
    }

    pub fn update_session_title(&self, session_id: &str, title: &str) -> SqlResult<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE chat_sessions SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, &now, session_id],
        )?;
        Ok(())
    }

    pub fn search_chats(&self, query: &str) -> SqlResult<Vec<SearchResult>> {
        let search_pattern = format!("%{}%", query.to_lowercase());
        
        // Search in chat session titles and message contents
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT 
                cs.id, 
                cs.title, 
                cs.updated_at,
                COALESCE(
                    (SELECT content FROM messages 
                     WHERE session_id = cs.id 
                     AND LOWER(content) LIKE ?1 
                     LIMIT 1),
                    ''
                ) as matching_content
            FROM chat_sessions cs
            LEFT JOIN messages m ON cs.id = m.session_id
            WHERE LOWER(cs.title) LIKE ?1 OR LOWER(m.content) LIKE ?1
            ORDER BY cs.updated_at DESC"
        )?;

        let results = stmt.query_map(params![&search_pattern], |row| {
            Ok(SearchResult {
                session_id: row.get(0)?,
                title: row.get(1)?,
                updated_at: row.get(2)?,
                matching_content: row.get(3)?,
            })
        })?;

        results.collect()
    }

    /// Store (or replace) a message's embedding. The vector is written as raw
    /// little-endian f32 bytes.
    pub fn save_embedding(&self, message_id: &str, session_id: &str, model: &str, vec: &[f32]) -> SqlResult<()> {
        let bytes: Vec<u8> = vec.iter().flat_map(|f| f.to_le_bytes()).collect();
        self.conn.execute(
            "INSERT OR REPLACE INTO message_embeddings (message_id, session_id, model, dim, vec)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![message_id, session_id, model, vec.len() as i64, bytes],
        )?;
        Ok(())
    }

    /// Every stored embedding as (message_id, session_id, vector), for the cosine
    /// scan. A row whose byte length isn't a whole number of f32s yields a shorter
    /// vector and simply won't match (cosine returns 0 on a length mismatch).
    pub fn all_embeddings(&self) -> SqlResult<Vec<(String, String, Vec<f32>)>> {
        let mut stmt = self.conn.prepare(
            "SELECT message_id, session_id, vec FROM message_embeddings",
        )?;
        let rows = stmt.query_map([], |row| {
            let message_id: String = row.get(0)?;
            let session_id: String = row.get(1)?;
            let bytes: Vec<u8> = row.get(2)?;
            let vec = bytes
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect::<Vec<f32>>();
            Ok((message_id, session_id, vec))
        })?;
        rows.collect()
    }

    /// Messages without an embedding yet, up to `limit`, as (id, session_id, content),
    /// for backfilling. Empty/whitespace content is skipped — nothing to embed.
    pub fn unembedded_messages(&self, limit: usize) -> SqlResult<Vec<(String, String, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT m.id, m.session_id, m.content
             FROM messages m
             LEFT JOIN message_embeddings e ON e.message_id = m.id
             WHERE e.message_id IS NULL AND LENGTH(TRIM(m.content)) > 0
             LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit as i64], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        rows.collect()
    }

    /// `(embeddable, embedded)`: how many messages have content worth embedding, and
    /// how many of those already have a vector. Drives the Settings index status —
    /// `embedded < embeddable` means indexing is still in progress. "Embeddable" uses
    /// the same non-empty-content rule as `unembedded_messages`, so the two agree.
    pub fn embedding_counts(&self) -> SqlResult<(i64, i64)> {
        let embeddable: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM messages WHERE LENGTH(TRIM(content)) > 0",
            [],
            |r| r.get(0),
        )?;
        let embedded: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM messages m JOIN message_embeddings e ON e.message_id = m.id
             WHERE LENGTH(TRIM(m.content)) > 0",
            [],
            |r| r.get(0),
        )?;
        Ok((embeddable, embedded))
    }

    /// The search-result view of one message: its session's title and updated_at, with
    /// the message content as the snippet. `None` if the message or its session is gone.
    pub fn message_search_result(&self, message_id: &str) -> SqlResult<Option<SearchResult>> {
        let mut stmt = self.conn.prepare(
            "SELECT m.session_id, cs.title, cs.updated_at, m.content
             FROM messages m JOIN chat_sessions cs ON cs.id = m.session_id
             WHERE m.id = ?1",
        )?;
        let mut rows = stmt.query_map(params![message_id], |row| {
            Ok(SearchResult {
                session_id: row.get(0)?,
                title: row.get(1)?,
                updated_at: row.get(2)?,
                matching_content: row.get(3)?,
            })
        })?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    /// Merges another Scarlettt database's chats into this one, returning
    /// `(sessions, messages)` actually added.
    ///
    /// `INSERT OR IGNORE` over the **intersection** of columns, never `SELECT *`:
    /// seven columns arrived here by migration (`branched_from`, `project_id`,
    /// `num_ctx`, `model`, `duration_ms`, `prompt_tokens`, `eval_tokens`), so an
    /// archive written by an older build has fewer of them and a positional copy
    /// fails outright. Ignoring on the UUID primary keys is what makes merging the
    /// same archive twice a no-op instead of a duplicate.
    ///
    /// Done through *this* connection rather than a second one opened on the file, so
    /// the merge is immediately visible to everything already reading through it.
    pub fn merge_from(&self, archive_db: &Path) -> SqlResult<(u32, u32)> {
        self.conn.execute(
            "ATTACH DATABASE ?1 AS archived",
            params![archive_db.to_string_lossy().to_string()],
        )?;
        let merged = self.merge_attached();
        // Detached whatever happened above: leaving it attached makes a second
        // restore in the same session fail on the ATTACH instead of the merge.
        let _ = self.conn.execute("DETACH DATABASE archived", []);
        merged
    }

    fn merge_attached(&self) -> SqlResult<(u32, u32)> {
        let (mut sessions, mut messages) = (0u32, 0u32);
        // Sessions before messages: `messages.session_id` references them. Projects
        // first, for the same reason.
        for table in ["projects", "chat_sessions", "messages"] {
            let shared = self.shared_columns(table)?;
            if shared.is_empty() {
                // The archive predates this table entirely.
                continue;
            }
            let columns = shared.join(", ");
            let added = self.conn.execute(
                &format!(
                    "INSERT OR IGNORE INTO main.{table} ({columns}) \
                     SELECT {columns} FROM archived.{table}"
                ),
                [],
            )? as u32;
            match table {
                "chat_sessions" => sessions = added,
                "messages" => messages = added,
                _ => {}
            }
        }
        Ok((sessions, messages))
    }

    /// Columns the table has in BOTH databases, in the live database's order.
    fn shared_columns(&self, table: &str) -> SqlResult<Vec<String>> {
        let live = self.column_names("main", table)?;
        let archived = self.column_names("archived", table)?;
        Ok(live.into_iter().filter(|name| archived.contains(name)).collect())
    }

    fn column_names(&self, schema: &str, table: &str) -> SqlResult<Vec<String>> {
        // Both names come from the fixed list above, never from anything a user typed.
        let mut stmt = self
            .conn
            .prepare(&format!("PRAGMA {schema}.table_info({table})"))?;
        let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
        names.collect()
    }

    pub fn import_session(&self, title: String, messages: Vec<Message>) -> SqlResult<ChatSession> {
        let session_id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        // Create the session
        self.conn.execute(
            "INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![&session_id, &title, &now, &now],
        )?;

        // Insert all messages
        for (i, msg) in messages.iter().enumerate() {
            let msg_id = Uuid::new_v4().to_string();
            let ts = if msg.timestamp.is_empty() {
                let base = Utc::now();
                let adjusted = base + chrono::Duration::milliseconds(i as i64);
                adjusted.to_rfc3339()
            } else {
                msg.timestamp.clone()
            };

            self.conn.execute(
                "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![&msg_id, &session_id, &msg.role, &msg.content, &ts],
            )?;
        }

        Ok(ChatSession {
            id: session_id,
            title,
            created_at: now.clone(),
            updated_at: now,
            project_id: None,
            branched_from: None,
            num_ctx: None,
            model: None,
        })
    }

    // Projects

    pub fn create_project(&self, name: Option<String>) -> SqlResult<Project> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        // The UI calls these folders; the table is still named `projects` for now.
        let name = name.unwrap_or_else(|| "New folder".to_string());

        self.conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![&id, &name, &now, &now],
        )?;

        Ok(Project {
            id,
            name,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn get_projects(&self) -> SqlResult<Vec<Project>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, created_at, updated_at FROM projects ORDER BY updated_at DESC"
        )?;

        let projects = stmt.query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })?;

        projects.collect()
    }

    pub fn update_project_name(&self, project_id: &str, name: &str) -> SqlResult<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE projects SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![name, &now, project_id],
        )?;
        Ok(())
    }

    /// Deleting a project keeps its chats — they fall back to Recent chats.
    pub fn delete_project(&self, project_id: &str) -> SqlResult<()> {
        self.conn.execute(
            "UPDATE chat_sessions SET project_id = NULL WHERE project_id = ?1",
            params![project_id],
        )?;
        self.conn.execute(
            "DELETE FROM projects WHERE id = ?1",
            params![project_id],
        )?;
        Ok(())
    }

    /// `project_id: None` moves the chat back out to Recent chats.
    pub fn set_session_project(&self, session_id: &str, project_id: Option<&str>) -> SqlResult<()> {
        self.conn.execute(
            "UPDATE chat_sessions SET project_id = ?1 WHERE id = ?2",
            params![project_id, session_id],
        )?;
        Ok(())
    }

    pub fn append_messages(&self, session_id: &str, messages: Vec<Message>) -> SqlResult<()> {
        for (i, msg) in messages.iter().enumerate() {
            let msg_id = Uuid::new_v4().to_string();
            // Add a tiny delay or just use a counter to ensure unique timestamps if needed,
            // but RFC3339 with nanoseconds should usually be fine.
            // However, to be extra safe for ASC sorting:
            let ts = if msg.timestamp.is_empty() {
                // Generate a timestamp and add i milliseconds to it to ensure ordering
                let base = Utc::now();
                let adjusted = base + chrono::Duration::milliseconds(i as i64);
                adjusted.to_rfc3339()
            } else {
                msg.timestamp.clone()
            };

            self.conn.execute(
                "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![&msg_id, session_id, &msg.role, &msg.content, &ts],
            )?;
        }

        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE chat_sessions SET updated_at = ?1 WHERE id = ?2",
            params![&now, session_id],
        )?;

        Ok(())
    }

    /// Starts a new session seeded with the single message at `timestamp`.
    ///
    /// Deliberately *not* the preceding conversation: branching here means taking
    /// one reply somewhere new, so the branch begins with that message alone and
    /// nothing else follows it in. The model therefore sees that reply as the only
    /// prior context, which is the point — the baggage is what you were escaping.
    ///
    /// A consequence worth knowing: the branch opens with no user message, so it
    /// inherits the parent's title until you send one, at which point
    /// `save_message` re-titles it from your first message as it would any new chat.
    ///
    /// The source is left completely untouched.
    pub fn branch_session(&self, source_id: &str, timestamp: &str) -> SqlResult<ChatSession> {
        // A branch belongs wherever its parent does, so it doesn't jump out of a
        // project and reappear among the loose chats.
        let (project_id, source_num_ctx, source_model): (Option<String>, Option<u32>, Option<String>) =
            self.conn.query_row(
                "SELECT project_id, num_ctx, model FROM chat_sessions WHERE id = ?1",
                params![source_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;

        // Named after the message it starts from, not the parent chat. Since that
        // message is the branch's entire content, the parent's title would describe
        // a conversation this one doesn't contain. Truncated on the same 1000-char
        // bound `save_message` uses for titles.
        let title: String = self.conn.query_row(
            "SELECT content FROM messages WHERE session_id = ?1 AND timestamp = ?2",
            params![source_id, timestamp],
            |row| row.get(0),
        )?;
        let title = if title.chars().count() > 1000 {
            format!("{}...", title.chars().take(1000).collect::<String>())
        } else {
            title
        };

        let new_id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        self.conn.execute(
            "INSERT INTO chat_sessions (id, title, created_at, updated_at, project_id, branched_from, num_ctx, model) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![&new_id, &title, &now, &now, &project_id, source_id, source_num_ctx, &source_model],
        )?;

        // The timestamp is carried over rather than reassigned, so the branched
        // message keeps the time it was actually generated instead of claiming to
        // have been written the moment you forked it.
        self.conn.execute(
            "INSERT INTO messages (id, session_id, role, content, timestamp, duration_ms, prompt_tokens, eval_tokens) \
             SELECT ?1, ?2, role, content, timestamp, duration_ms, prompt_tokens, eval_tokens \
             FROM messages WHERE session_id = ?3 AND timestamp = ?4",
            params![Uuid::new_v4().to_string(), &new_id, source_id, timestamp],
        )?;

        Ok(ChatSession {
            id: new_id,
            title,
            created_at: now.clone(),
            updated_at: now,
            project_id,
            branched_from: Some(source_id.to_string()),
            // A branch inherits the parent's transcript, so it inherits the terms
            // that transcript was written under too.
            num_ctx: source_num_ctx,
            model: source_model,
        })
    }

    pub fn delete_messages_after(&self, session_id: &str, timestamp: &str) -> SqlResult<()> {
        self.conn.execute(
            "DELETE FROM messages WHERE session_id = ?1 AND timestamp >= ?2",
            params![session_id, timestamp],
        )?;

        // Update session's updated_at to the current time since messages were deleted
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE chat_sessions SET updated_at = ?1 WHERE id = ?2",
            params![&now, session_id],
        )?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tool_calls_round_trip_through_the_messages_table() {
        // In-memory DB exercises the real schema, migrations, and (de)serialization.
        let db = Database::new(PathBuf::from(":memory:")).unwrap();
        let session = db.create_session(Some("t".to_string())).unwrap();

        // A plain message carries no tool activity.
        db.save_message(&session.id, "user", "hi", None, None, None, None).unwrap();

        // An assistant turn that called a tool carries the JSON attachment.
        let tools = json!([{
            "callId": "c1", "tool": "fs__read", "server": "fs", "toolName": "read",
            "arguments": { "path": "/x" }, "result": "ok", "isError": false, "decision": "allow-once"
        }]);
        db.save_message(&session.id, "assistant", "done", Some(10), Some(5), Some(3), Some(&tools)).unwrap();

        let msgs = db.get_messages(&session.id).unwrap();
        assert_eq!(msgs.len(), 2);

        // Find by role — two rapid saves can share a timestamp, so don't assume order.
        let user = msgs.iter().find(|m| m.role == "user").unwrap();
        let asst = msgs.iter().find(|m| m.role == "assistant").unwrap();

        assert!(user.tool_calls.is_none(), "a plain message has no tool activity");
        assert_eq!(asst.tool_calls.as_ref().unwrap(), &tools, "tool activity round-trips verbatim");
        assert_eq!(asst.tool_calls.as_ref().unwrap()[0]["toolName"], "read");
    }
}
