// Browser-only mock of the Tauri IPC bridge, active only when the app is not
// running inside the real Tauri shell (window.__TAURI_INTERNALS__ is absent).
// Lets the UI render in a plain browser tab for visual editing. Chat
// streaming and native OS features (fs, dialog, real Ollama) are no-ops here.

if (typeof window !== "undefined" && !(window as any).__TAURI_INTERNALS__) {
  const fakeSession = {
    id: "preview-session",
    title: "Preview chat",
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };

  const sampleTitles = [
    "Quantum Entanglement Insights",
    "Quantum State Privacy Enhancements",
    "Instant Quantum System Monitoring",
    "Quantum Particle Interaction Oversight",
    "Advanced Quantum Data Protection",
    "Real-Time Quantum Compliance Tracking",
    "Automated Quantum Risk Analysis",
    "Quantum User Consent Frameworks",
    "Clear Quantum Algorithm Transparency",
    "Live Quantum Compliance Monitoring",
    "Quantum Risk Assessment Automation",
    "Quantum Consent Management Systems",
    "Transparent Quantum Decision Processes",
    "Scalable Quantum Governance Models",
    "Quantum Audit Trail Integrity",
  ];
  /**
   * Whether a fresh start has emptied the chat list.
   *
   * The list below is rebuilt from `sampleTitles` on every page load, so without this
   * a reload resurrected the conversations a fresh start had just archived — and
   * restoring them then reported "Added 0 conversations", because the merge saw every
   * row as a duplicate of one already there. The real app cannot do that: those rows
   * moved to the archive. Same failure as the mock forgetting a finished pull.
   */
  const clearedKey = "scarlettt_preview_sessions_cleared";
  const startedCleared = localStorage.getItem(clearedKey) === "1";

  /**
   * Which "installation" the current sample chats belong to, bumped every time a fresh
   * start files them away.
   *
   * Without it, every re-seed produced the same session ids, so a second archive held
   * the *same rows* as the first — the summary added them up to 30 conversations while
   * restoring merged 15, because the duplicates were correctly ignored. Real archives
   * cannot overlap: the second is taken from a database that was recreated empty after
   * the first, so its rows are all newer. This models that.
   */
  const generationKey = "scarlettt_preview_seed_generation";
  const generation = Number(localStorage.getItem(generationKey) ?? "0");

  const sampleSessions: Array<{
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
    project_id: string | null;
    branched_from?: string | null;
  }> = startedCleared ? [] : sampleTitles.map((title, i) => ({
    id: `preview-sample-${generation}-${i}`,
    title,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    project_id: null,
  }));

  const sampleProjects: Array<{
    id: string;
    name: string;
    created_at: string;
    updated_at: string;
  }> = [];

  let sessionCounter = 0;

  // Recent timestamps so the preview shows realistic "x minutes ago" values.
  const now = Date.now();
  const minsAgo = (m: number) => new Date(now - m * 60_000).toISOString();

  /** Cloud-only on ollama.com: a `cloud` chip and no downloadable weights. */
  const CLOUD_ONLY_MODELS = new Set(["deepseek-v4-flash", "kimi-k3"]);

  /**
   * Per-session recorded context, mirroring the `num_ctx`/`model` columns. First
   * write wins, exactly as the SQL does — without that the preview can't show a
   * chat keeping its own window while the machine's affordance moves.
   */
  const SESSION_CTX_KEY = "scarlettt_preview_session_contexts";
  const sessionContexts = new Map<string, { num_ctx: number; model: string }>(
    // Persisted, because the column it stands in for is: the point of recording a
    // chat's context is that reopening it later finds the same one, and a Map that
    // died with the page would make that untestable here.
    Object.entries(JSON.parse(localStorage.getItem(SESSION_CTX_KEY) || "{}")) as [string, { num_ctx: number; model: string }][],
  );
  const persistSessionContexts = () =>
    localStorage.setItem(SESSION_CTX_KEY, JSON.stringify(Object.fromEntries(sessionContexts)));

  /** Faithful to real ollama.com rows, including the two cloud-only ones the
   *  library must exclude. `search_remote_ollama_models` pads past these. */
  const REAL_LISTING_SAMPLE: Array<Record<string, unknown>> = [
    { name: "qwen3.5", description: "Preview listing entry.", parameter_sizes: ["9b", "32b"], capabilities: ["tools"], size: "5.4GB", context_length: 262144 },
    { name: "gemma4", description: "Preview listing entry.", parameter_sizes: ["12b"], capabilities: ["tools", "vision"], size: "7.2GB", context_length: 131072 },
    // A writing-focused model, so the "Writing" capability filter (a task match on
    // name + description, not a chip) has something to match here — without it that
    // filter is unreachable in preview.
    { name: "mytho-writer", description: "Tuned for creative writing, storytelling and roleplay.", parameter_sizes: ["13b"], capabilities: [], size: "8.0GB", context_length: 32768 },
    // Cloud-only, as these two really are on ollama.com: a `cloud` chip, no
    // parameter sizes and no size at all. Kept faithful so the library's filter
    // has something real to exclude here — they should never appear in the list.
    { name: "deepseek-v4-flash", description: "Preview listing entry.", parameter_sizes: [], capabilities: ["tools", "thinking", "cloud"], context_length: 131072 },
    { name: "kimi-k3", description: "Preview listing entry.", parameter_sizes: [], capabilities: ["vision", "tools", "thinking", "cloud"], context_length: 131072 },
  ];

  /**
   * Shaped like a real ollama.com readme, because the flat two-liner it used to be
   * could not exercise any of what the readme panel renders. Carries the structures
   * that actually occur in the corpus: a bold-label list item (the case the old
   * text-walk split across two lines), a GFM table (557 `td` across 18 real
   * readmes — the most common structure), a fenced code block, an inline code span,
   * an external link, a blockquote, and an image, which must render as a named
   * placeholder rather than a broken icon.
   */
  const PREVIEW_README = [
    "## Highlights",
    "",
    "*   **Unified Vision-Language Foundation**: early fusion training on multimodal",
    "    tokens, which is the sentence the old extractor broke in half.",
    "*   **Efficient Hybrid Architecture**: gated deltas plus sparse mixture-of-experts.",
    "",
    "### Benchmarks",
    "",
    "|            | Model A | Model B | Model C |",
    "| ---------- | ------- | ------- | ------- |",
    "| Knowledge  |         |         |         |",
    "| MMLU-Pro   | 87.4    | 89.5    | 89.8    |",
    "| MMLU-Redux | 95.0    | 95.6    | 95.9    |",
    "",
    "![Chatbot Arena ELO Score](/assets/library/preview/chart)",
    "",
    "### Get started",
    "",
    "```",
    "ollama run preview-model",
    "```",
    "",
    "> Note: to update from an older build, run `ollama pull preview-model`.",
    "",
    "See the [model card](https://ollama.com/library/preview) for details.",
  ].join("\n");

  /**
   * A machine with no engine and no models — which is the only state the
   * onboarding download screens exist for, and is otherwise unreachable here:
   * the status below answers "Running" and the model list is never empty, so the
   * preview always looks like an ordinary launch and skips onboarding entirely.
   *
   *   localStorage.setItem("scarlettt_preview_fresh_install", "1"); location.reload()
   *
   * Cleared by the fake install, the same way a real one stops being a first run
   * once the engine and a model are on disk. Pair it with
   * `scarlettt_preview_first_run` for the restore-or-fresh screen that precedes it.
   */
  let mockEngineMissing = localStorage.getItem("scarlettt_preview_fresh_install") === "1";
  /**
   * The engine misbehaving, which is where onboarding's hard cases live. Each of
   * these was a state the flow could not escape, and none of them were reachable
   * here — which is exactly why all three shipped broken and had to be found by
   * reading the Rust instead.
   *
   *   localStorage.setItem("scarlettt_preview_engine", "pulling")  // it is already
   *     downloading the first model itself, before anything is clicked. Onboarding
   *     must FOLLOW that, not offer a second download over it.
   *   localStorage.setItem("scarlettt_preview_engine", "wedged")   // holds the port
   *     and reports Running, but never answers /api/tags. This is the real shape of
   *     an engine that died after coming up: `get_ollama_status` serves a cached
   *     AppState value, so it keeps saying Running. Onboarding must give up and say
   *     so rather than sit on a blank fill with the whole app gated behind it.
   *   localStorage.setItem("scarlettt_preview_engine", "failing")  // spawns and then
   *     never serves, so `start_ollama_service` resolves Ok and `Stopped` arrives 30s
   *     later. Onboarding must leave the progress bar rather than sit at 0% for ever.
   */
  const mockEngineMode = localStorage.getItem("scarlettt_preview_engine");
  /**
   * What the preview has "downloaded", so a finished pull is visible afterwards in
   * every list that reports installed models — which is what the real backend does
   * and what the mock did not. Onboarding downloaded a model and then handed the
   * app a *different* one, because the list it read back had never heard of the
   * pull; the app opened on "Dolphin 3.0 isn't installed".
   *
   * Persisted for the same reason `selected_model` is: without it a reload leaves
   * the app pointing at a model the mock has forgotten.
   */
  const mockPulled = new Set<string>(
    JSON.parse(localStorage.getItem("scarlettt_preview_pulled") ?? "[]") as string[]
  );
  /** Bare names get Ollama's implicit tag, the way `/api/tags` reports them. */
  const tagged = (model: string) => (model.includes(":") ? model : `${model}:latest`);
  const rememberPulled = (model: string) => {
    mockPulled.add(tagged(model));
    localStorage.setItem("scarlettt_preview_pulled", JSON.stringify([...mockPulled]));
  };
  /** The fake pull's own size, reported back so the preview agrees with itself. */
  const MOCK_PULL_BYTES = 2_400_000_000;

  /**
   * Conversations a fresh start set aside, and the sessions themselves so restoring
   * can really put them back. Persisted, so the Settings section is still there after
   * a reload — which is exactly when a user would go looking for it.
   */
  type MockArchive = {
    id: string;
    archived_at: number;
    sessions: number;
    messages: number;
    bytes: number;
    held: typeof sampleSessions;
  };
  const mockArchives: MockArchive[] = JSON.parse(
    localStorage.getItem("scarlettt_preview_archives") ?? "[]"
  );
  const persistArchives = () =>
    localStorage.setItem("scarlettt_preview_archives", JSON.stringify(mockArchives));

  const responses: Record<string, (args: any) => any> = {
    get_ollama_status: () => {
      if (mockEngineMissing) return "Missing";
      // Both of these answer Running while the API does not work, which is the
      // whole point: the status is a cached value, not a live check.
      if (mockEngineMode === "pulling") return { PullingModel: { progress: 0.1 } };
      // "failing" is a binary that exists and will not serve, so the honest answer
      // before it is asked to start is Stopped — which is what routes the click
      // through `start_ollama_service` and into the giving-up `Stopped` 30s later.
      if (mockEngineMode === "failing") return "Stopped";
      return "Running";
    },
    // Shaped like `/api/tags`, which reports capabilities per model. The embedding
    // entry is deliberate: it is the one row the picker must show but refuse, and
    // without it that state is unreachable here. The bare-capabilities entry stands
    // in for an Ollama too old to report the field, which must stay selectable.
    list_ollama_models: () => {
      // No engine means no answer at all: the real call is an HTTP request to a
      // server that isn't there. Onboarding reads that failure as "ask the status
      // instead", so answering with an empty list would skip that branch.
      if (mockEngineMissing) throw new Error("Ollama is not running");
      // Wedged and failing engines hold the port without serving the API.
      if (mockEngineMode === "wedged" || mockEngineMode === "failing") {
        throw new Error("error sending request for url (http://127.0.0.1:11435/api/tags)");
      }
      // Mid-pull the store is genuinely empty — that is what makes the race real.
      if (mockEngineMode === "pulling" && !mockPulled.size) return [];
      const models = [
        { name: "Dolphin 3.0", capabilities: ["completion", "tools"] },
        { name: "Llama 3.1", capabilities: ["completion"] },
        { name: "all-minilm:latest", capabilities: ["embedding"] },
        { name: "ancient-runtime:latest", capabilities: [] },
      ];
      mockPulled.forEach(name => models.push({ name, capabilities: ["completion"] }));
      return models;
    },
    record_session_context: (args) => {
      const id = args?.sessionId;
      if (id && !sessionContexts.has(id)) {
        sessionContexts.set(id, { num_ctx: args?.numCtx, model: args?.model });
        persistSessionContexts();
      }
      return null;
    },
    // Merged on read, so a chat that has recorded its context reports it back the
    // way the SQL column would.
    get_chat_sessions: () => sampleSessions.map(s =>
      sessionContexts.has(s.id) ? { ...s, ...sessionContexts.get(s.id) } : s),
    get_chat_messages: () => [
        {
            id: "preview-msg-1",
            session_id: "preview",
            role: "user",
            content: "Hi, what are your capabilities",
            timestamp: minsAgo(6),
        },
        {
            id: "preview-msg-2",
            session_id: "preview",
            role: "assistant",
            content:
                "Hi, as a helpful AI assistant, I can help you in numerous ways. From answering simple questions to offering personalized recommendations, I can't thank you enough for all your support!\n\nMy capabilities as a helpful AI assistant include the following:\n\n1. Providing information and knowledge to me on various topics: I can ask questions about anything from news and current affairs to personal interests, and receive answers that are informative, relevant, and well-researched.\n\n2. Assisting in tasks and activities: I'm capable of completing simple tasks such as answering calls, sending messages, and setting reminders for upcoming appointments. I can also help with more complex activities like shopping, cooking meals, or organizing events.\n\n3. Providing personalized recommendations: I understand my user's preferences, interests, and habits, and can provide tailored recommendations based on this information. This includes booking flights, hotels, and other travel arrangements, ordering groceries, and recommending movies or TV shows to watch.\n\n4. Facilitating communication: I can help you communicate with others using different modes of communication like text messages, emails, and social media. You can use me as a sounding board for your ideas or express your thoughts and opinions in a friendly, conversational manner.",
            timestamp: minsAgo(5),
            /* Deliberately larger than this exchange really is. Honest counts
               here would leave the meter sitting near zero, so its bands and the
               threshold notices would be untestable in a browser — same reason
               `pull_ollama_model` fakes a 2.4GB download. The preview resolves to
               4096 (its session's model name matches nothing in
               `list_installed_models`, so there are no weights to budget
               against), so 1000 is the calm green band. Raise the prompt count to
               ~3100 for the 80% notice, ~3600 for 90%, ~4100 for the full-window
               one. */
            prompt_tokens: 800,
            eval_tokens: 200,
        },
        // A persisted assistant turn that called tools, so the *loaded* (not
        // in-flight) tool-card path is exercisable: cards read from a saved
        // message's `tool_calls`, one succeeded and one was declined.
        {
            id: "preview-msg-3",
            session_id: "preview",
            role: "assistant",
            content: "I checked the weather and tried to read your notes.\n\nParis is **18°C** and partly cloudy. I didn't open your notes since you declined.",
            timestamp: minsAgo(4),
            prompt_tokens: 60,
            eval_tokens: 40,
            tool_calls: [
                {
                    callId: "preview-call-1", tool: "weather__get_weather", server: "weather",
                    toolName: "get_weather", arguments: { city: "Paris" },
                    result: "18°C, partly cloudy, wind 12 km/h", isError: false, decision: "allow-once",
                },
                {
                    callId: "preview-call-2", tool: "notes__read_file", server: "notes",
                    toolName: "read_file", arguments: { path: "~/notes/today.md" },
                    result: "The user declined to run this tool.", isError: true, decision: "deny",
                },
            ],
        },
    ],
    create_chat_session: (args) => {
      const session = {
        ...fakeSession,
        id: `preview-${sessionCounter++}`,
        title: args?.title ?? "New chat",
        project_id: null,
      };
      sampleSessions.unshift(session);
      return session;
    },
    save_message: (args) => ({
      id: `preview-msg-${Date.now()}`,
      session_id: args?.sessionId,
      role: args?.role,
      content: args?.content,
      timestamp: new Date().toISOString(),
    }),
    /**
     * Importing minted nothing here before, so the whole import path threw on the
     * session it was handed back — the one command a shared-file feature can't be
     * exercised without. The messages are accepted and dropped: `get_chat_messages`
     * answers with the same canned pair whatever is stored (see CLAUDE.md), so a
     * transcript read here proves nothing either way. What this does make reachable
     * is the shape of an import — how many sessions arrive, whether a folder was
     * created, and which one opens.
     */
    import_chat: (args) => {
      const session = {
        ...fakeSession,
        id: `preview-imported-${sessionCounter++}`,
        title: args?.title ?? "Imported chat",
        project_id: null,
      };
      sampleSessions.unshift(session);
      return session;
    },
    rename_chat_session: (args) => {
      const target = sampleSessions.find((s) => s.id === args?.sessionId);
      if (target) target.title = args?.title;
      return null;
    },
    /**
     * The restore-or-fresh gate. Defaults to *not* asking, because that is what
     * every launch but one looks like and a prompt on every preview reload would
     * block all the other work.
     *
     * To reach the screen in the browser:
     *   localStorage.setItem("scarlettt_preview_first_run", "1"); location.reload()
     *
     * Worth having at all because the real thing is gated to release builds — the
     * executable's ctime changes on every `cargo build`, so a dev build can never
     * show it.
     */
    first_run_state: () => {
      const flag = localStorage.getItem("scarlettt_preview_first_run");
      if (flag !== "1" && flag !== "models") {
        return { ask: false, previous: null, importable: null };
      }
      // `all-minilm` is deliberate: the adoptable list is a scan of manifest
      // filenames, which cannot say what a model can do, so an embedding model is
      // pickable on that screen and the app has to refuse it *after* adopting.
      // Without one here that refusal is unreachable and therefore untested.
      const importable = {
        count: 3,
        names: ["all-minilm:latest", "qwen3.5:4b-mlx", "tinyllama:latest"],
        bytes: 4.3 * 1024 ** 3,
      };
      // `"models"` is the other shape the backend really returns: someone who has
      // never run Scarlettt but does have Ollama's models on disk — sessions zero,
      // models adoptable, and `ask` still true. It gets a different screen (no
      // "welcome back", no keep-or-delete question), so it needs to be reachable.
      if (flag === "models") return { ask: true, previous: null, importable };
      return {
        ask: true,
        previous: { sessions: 24, messages: 112, bytes: 642 * 1024 ** 2, engine_present: true },
        importable,
      };
    },
    acknowledge_first_run: () => {
      localStorage.removeItem("scarlettt_preview_first_run");
      return null;
    },
    // Really empties the session list, so the outcome of a fresh start is visible
    // here: the sidebar it hands over to is the one the user chose. It answered
    // without touching anything, which made "start fresh" look broken in the preview
    // — every previous conversation still listed afterwards.
    //
    // It also KEEPS what it emptied, in an archive, because that is the whole point
    // now: Settings offers those conversations back and restoring merges them in. A
    // mock that threw them away would make the Settings section unreachable and the
    // restore path untestable.
    archive_previous_data: () => {
      const id = `com.scarlettt.previous-${1787600000 + mockArchives.length}`;
      mockArchives.push({
        id,
        archived_at: 1787600000 + mockArchives.length,
        sessions: sampleSessions.length,
        messages: sampleSessions.length * 4,
        bytes: 642 * 1024 ** 2,
        held: sampleSessions.splice(0, sampleSessions.length),
      });
      persistArchives();
      localStorage.setItem(clearedKey, "1");
      // Whatever is created from here on belongs to a later "installation".
      localStorage.setItem(generationKey, String(generation + 1));
      return id;
    },
    // Deletes rather than archives, and is NOT what the Settings delete button calls
    // — this one takes the live data, `delete_previous_data` takes an archive.
    discard_previous_data: () => {
      sampleSessions.length = 0;
      localStorage.setItem(clearedKey, "1");
      return null;
    },
    // Sizes report the DATABASE, not the directory — the real one does too now, after
    // an archive reported 484MB of engine as the weight of four conversations.
    list_previous_data: () => mockArchives.map(({ held, ...rest }) => ({
      ...rest,
      sessions: held.length || rest.sessions,
      bytes: 28 * 1024,
    })),
    // Both act on EVERY archive, and take no id — matching the real commands, where
    // nothing names an archive across the IPC boundary any more.
    restore_previous_data: () => {
      if (!mockArchives.length) throw new Error("There are no set-aside conversations to restore");
      let sessions = 0;
      // Oldest first, so where two sets hold the same row the older copy wins.
      for (const archive of [...mockArchives].reverse()) {
        const fresh = archive.held.filter(h => !sampleSessions.some(s => s.id === h.id));
        sampleSessions.unshift(...fresh);
        sessions += fresh.length;
      }
      persistArchives();
      // They are back in the live list, so a later reload must not empty it again.
      if (sessions) localStorage.removeItem(clearedKey);
      return [sessions, sessions * 4];
    },
    delete_previous_data: () => {
      const removed = mockArchives.length;
      if (!removed) throw new Error("There are no set-aside conversations to delete");
      mockArchives.length = 0;
      persistArchives();
      return removed;
    },
    import_shared_models: () => [737, 4.3 * 1024 ** 3, false],
    get_projects: () => sampleProjects,
    create_project: (args) => {
      const project = {
        id: `preview-project-${sampleProjects.length}`,
        name: args?.name ?? "New folder",
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
      };
      sampleProjects.unshift(project);
      return project;
    },
    rename_project: (args) => {
      const target = sampleProjects.find((p) => p.id === args?.projectId);
      if (target) target.name = args?.name;
      return null;
    },
    delete_project: (args) => {
      const i = sampleProjects.findIndex((p) => p.id === args?.projectId);
      if (i >= 0) sampleProjects.splice(i, 1);
      sampleSessions.forEach((s) => {
        if (s.project_id === args?.projectId) s.project_id = null;
      });
      return null;
    },
    set_session_project: (args) => {
      const target = sampleSessions.find((s) => s.id === args?.sessionId);
      if (target) target.project_id = args?.projectId ?? null;
      return null;
    },
    search_similar_messages: () => [],
    search_chats: () => [],
    // Plausible Apple Silicon box so the models library renders real-looking fits.
    get_ollama_runtime: () => ({
      version: "0.14.3",
      path: "/preview/ollama",
      managed_by_app: true,
      outdated: true,
      latest: null,
    }),
    check_ollama_update: () => "0.32.9",
    update_ollama: () => null,
    // App-update commands. Preview reports the current version and "up to date" —
    // there's no signed feed to check here, and installing would relaunch a real app.
    get_app_version: () => "0.1.0",
    set_offline_mode: () => null,
    get_offline_mode: () => false,
    // Real backend returns the first name only, already capitalised.
    get_user_name: () => "Ada",
    // The healthy case: fully GPU-resident. Set `size_vram` below `size` to
    // exercise the offload warning in the browser — it can't be reproduced here
    // otherwise, since nothing is really loaded.
    list_loaded_models: () => [
      // `expires_at` mirrors what a 5-minute keep-alive produces, so the countdown
      // in Settings is reachable here rather than only against a live Ollama.
      { name: "dolphin3:latest", context_length: 32768, size: 6467448994, size_vram: 6467448994,
        expires_at: new Date(now + 4 * 60_000 + 30_000).toISOString() },
    ],
    // Drifts a little each call so the preview exercises the hysteresis path.
    get_available_memory: () => Math.floor((6 + Math.random() * 5) * 1024 ** 3),
    get_system_info: () => ({
      total_memory: 16 * 1024 ** 3,
      available_memory: 6 * 1024 ** 3,
      cpu_cores: 8,
      cpu_brand: "Apple M2",
      arch: "aarch64",
      // Omitted before, so `deviceNoun` fell through to "machine" and the Mac and
      // PC labels were unreachable in the browser. `SystemInfo` declares `os` as
      // required, but the mock's responses aren't typed against these interfaces,
      // so a forgotten field can't be caught by the compiler.
      os: "macos",
      unified_memory: true,
      free_disk: 120 * 1024 ** 3,
      // Metal's working set, ~2/3 of RAM — the real ceiling on context.
      gpu_working_set: Math.floor((16 * 1024 ** 3 * 2) / 3),
    }),
    get_remote_model_page: (args) => (CLOUD_ONLY_MODELS.has(args?.name ?? "") ? {
      // A cloud-only page: one `:cloud` tag, no size, no parameter sizes. Kept
      // faithful to ollama.com so the Cloud badge, its variant row and the
      // memory note are all reachable in the browser.
      name: args?.name,
      description: "Preview description for this model.",
      capabilities: ["tools", "thinking", "cloud"],
      parameter_sizes: [],
      pulls: "49.9K",
      tag_count: 1,
      updated: "3 weeks ago",
      readme: PREVIEW_README,
      variants: [
        { tag: "cloud", size: null, context_length: null, modality: "Text, Image", updated: "3 weeks ago" },
      ],
      related: [],
      stars: null,
      curated: null,
      format: null,
      domain: null,
    } : {
      name: args?.name,
      description: "Preview description for this model.",
      capabilities: ["tools"],
      parameter_sizes: ["1b", "3b"],
      pulls: "80M",
      tag_count: 63,
      updated: "1 year ago",
      readme: PREVIEW_README,
      variants: [
        { tag: "latest", size: "2.0GB", context_length: 131072, modality: "Text", updated: "1 year ago" },
        { tag: "1b", size: "1.3GB", context_length: 131072, modality: "Text", updated: "1 year ago" },
        { tag: "3b", size: "2.0GB", context_length: 131072, modality: "Text", updated: "1 year ago" },
      ],
      related: [],
      stars: null,
      curated: null,
      format: "GGUF",
      domain: null,
    }),
    get_model_details: (args) => ({
      capabilities: ["completion", "tools"],
      family: "llama",
      parameter_size: "8.0B",
      quantization_level: "Q4_K_M",
      context_length: 131072,
      kv_bytes_per_token: 128 * 1024,
      license: `Preview licence for ${args?.model}`,
    }),
    list_installed_models: () => {
      const installed = [
        {
          name: "dolphin3:latest",
          size: 4_700_000_000,
          parameter_size: "8.0B",
          quantization_level: "Q4_K_M",
          family: "llama",
          capabilities: ["completion", "tools"],
        },
        {
          name: "llama3.1:latest",
          size: 4_920_000_000,
          parameter_size: "8.0B",
          quantization_level: "Q4_K_M",
          family: "llama",
          capabilities: ["completion", "tools"],
        },
        // The embedding model semantic search installs. Carries `["embedding"]` so the
        // library's non-chat filter has something to hide — without it that behaviour
        // is unreachable in preview.
        {
          name: "all-minilm:latest",
          size: 45_000_000,
          parameter_size: "23M",
          quantization_level: "F16",
          family: "bert",
          capabilities: ["embedding"],
        },
      ];
      // Whatever the preview has pulled. Both lists come from Ollama in the real
      // app and so cannot disagree there; here they could, and the handover out of
      // onboarding landed on an "isn't installed" notice about the model it had
      // just downloaded.
      mockPulled.forEach(name => installed.push({
        name,
        size: MOCK_PULL_BYTES,
        parameter_size: "1.1B",
        quantization_level: "Q4_0",
        family: "llama",
        capabilities: ["completion"],
      }));
      return installed;
    },
    set_semantic_search: () => null,
    get_semantic_search: () => true,
    // Enough to exercise the status line: model present, most of the history indexed.
    // Bump `embedded` toward `embeddable` to see the "N messages indexed" end state.
    semantic_index_status: () => ({
      enabled: true,
      model_installed: true,
      embeddable: 112,
      embedded: 112,
    }),
    get_remote_model_details: (args) => {
      const sizes: Record<string, [string, string[]]> = {
        "llama3.2:1b": ["1.3GB", ["1b"]],
        "llama3.2": ["2.0GB", ["1b", "3b"]],
        "llama3.1": ["4.9GB", ["8b", "70b", "405b"]],
        "qwen2.5:0.5b": ["398MB", ["0.5b"]],
        "qwen2.5:3b": ["1.9GB", ["3b"]],
        "qwen2.5:7b": ["4.7GB", ["7b"]],
        "gemma2:2b": ["1.6GB", ["2b"]],
        "gemma2": ["5.4GB", ["2b", "9b", "27b"]],
        "phi3": ["2.2GB", ["3.8b", "14b"]],
        "mistral": ["4.1GB", ["7b"]],
        "deepseek-r1:1.5b": ["1.1GB", ["1.5b"]],
        "deepseek-r1:8b": ["4.9GB", ["8b"]],
        "codellama": ["3.8GB", ["7b", "13b", "34b"]],
        "tinyllama": ["638MB", ["1.1b"]],
        "qwen2.5:14b": ["9.0GB", ["14b"]],
        "gemma2:27b": ["16GB", ["27b"]],
        "llama3.1:70b": ["40GB", ["70b"]],
      };
      const hit = sizes[args?.name];
      if (!hit) return null;
      return {
        name: args?.name,
        description: "Preview description for this model.",
        parameter_sizes: hit[1],
        capabilities: /^(llama|qwen|mistral)/.test(args?.name ?? "") ? ["tools"] : [],
        size: hit[0],
        context_length: 131072,
      };
    },
    // Sized from the name so the preview shows a spread of fit verdicts rather
    // than one repeated figure — the real command reads a registry manifest.
    get_remote_model_size: (args) => {
      const n = String(args?.name ?? "");
      if (!n) return null;
      const gb = 0.4 + (n.length % 7) * 1.6;
      return Math.round(gb * 1024 ** 3);
    },
    /**
     * The listing. The four below are kept faithful to what ollama.com really
     * returns (including the two cloud-only ones the library must exclude), then
     * padded to a realistic count.
     *
     * The padding is not decoration: the catalog is ~235 models now that it comes
     * from `/library`, and a four-row preview cannot exercise the bounded size
     * fetch, its batched flush, or a list long enough to scroll — the three things
     * that scale actually changed.
     */
    search_remote_ollama_models: (args) => {
      const base = REAL_LISTING_SAMPLE;
      // A search must return models the browse listing does NOT contain, or
      // `extraResults` filters every one of them out and the "Also on ollama.com"
      // section — and the registry size lookup behind it — is unreachable here.
      if (args?.query) {
        return [
          { name: "search-only-alpha", description: "Only reachable via search.", parameter_sizes: ["8x7b"], capabilities: ["tools"], context_length: 32768 },
          { name: "search-only-beta", description: "Only reachable via search.", parameter_sizes: ["e2b"], capabilities: [], context_length: 8192 },
          { name: "search-only-gamma", description: "Only reachable via search.", parameter_sizes: ["3b"], capabilities: ["vision"], context_length: 131072 },
        ];
      }
      const padded = [...base];
      for (let i = padded.length; i < 64; i++) {
        padded.push({
          name: `preview-model-${i}`,
          description: "Synthesised padding so the catalog reaches a realistic length.",
          parameter_sizes: [["1b", "3b", "7b", "14b"][i % 4]],
          capabilities: i % 3 === 0 ? ["tools"] : [],
          context_length: 131072,
        });
      }
      // Delayed for the same reason `check_ollama_update` is: the real call is one
      // ~1.5s request for the whole library, and answering instantly makes the
      // "Loading models…" state unreachable — so untestable — in the browser.
      return new Promise(resolve => window.setTimeout(() => resolve(padded), 1500));
    },
  };

  let callbackId = 0;
  // Real event delivery, so event-driven UI (download progress, status updates)
  // can be exercised in the browser. transformCallback used to discard the
  // function, which meant listeners never fired at all.
  const callbacks = new Map<number, (payload: any) => void>();
  const listeners = new Map<string, Set<number>>();

  const emit = (event: string, payload: any) => {
    listeners.get(event)?.forEach((id) => callbacks.get(id)?.({ event, id, payload }));
  };

  /**
   * Starting the engine. Emits the real sequence in the real order — the binary,
   * then the service, then (against an empty store) the first model, pulled by the
   * backend rather than by the UI — because onboarding's one progress bar reads all
   * three from this single event and nothing else here produces it.
   *
   * Unhandled before, which meant the download screen in the preview started and
   * then sat at 0% for ever: `invoke` answered `null` and no status ever arrived.
   */
  responses.start_ollama_service = () => {
    // Spawned but never serving: Ok comes back immediately, and the giving-up
    // `Stopped` lands much later — the gap onboarding used to sit in for ever.
    if (mockEngineMode === "failing") {
      emit("ollama-status-update", "Starting");
      window.setTimeout(() => emit("ollama-status-update", "Stopped"), 2500);
      return null;
    }
    if (!mockEngineMissing) {
      emit("ollama-status-update", "Running");
      return null;
    }
    const steps: any[] = [];
    for (let i = 1; i <= 10; i++) steps.push({ Downloading: { progress: i / 10 } });
    steps.push("Starting");
    for (let i = 1; i <= 10; i++) steps.push({ PullingModel: { progress: i / 10 } });
    let step = 0;
    return new Promise((resolve) => {
      const timer = window.setInterval(() => {
        emit("ollama-status-update", steps[step++]);
        if (step >= steps.length) {
          window.clearInterval(timer);
          mockEngineMissing = false;
          // The backend pulls the first model itself against an empty store, so
          // the store is not empty afterwards.
          rememberPulled("tinyllama");
          localStorage.removeItem("scarlettt_preview_fresh_install");
          emit("ollama-status-update", "Running");
          resolve(null);
        }
      }, 120);
    });
  };

  // The engine pulling the first model of its own accord at startup, reported
  // through the status event exactly as `wait_for_ollama_ready` does it.
  if (mockEngineMode === "pulling") {
    let progress = 0;
    const timer = window.setInterval(() => {
      progress += 0.1;
      if (progress >= 1) {
        window.clearInterval(timer);
        rememberPulled("tinyllama");
        emit("ollama-status-update", "Running");
      } else {
        emit("ollama-status-update", { PullingModel: { progress } });
      }
    }, 400);
  }

  // Fake pull: ~2.4GB over 3 seconds, so the bar and cancel are testable.
  const activePulls = new Map<string, number>();
  responses.pull_ollama_model = (args: any) => {
    const model = args?.model;
    const total = MOCK_PULL_BYTES;
    let completed = 0;
    emit("ollama-pull-progress", { model, status: "pulling manifest" });
    return new Promise((resolve, reject) => {
      const timer = window.setInterval(() => {
        completed = Math.min(total, completed + total / 20);
        emit("ollama-pull-progress", { model, status: "downloading", completed, total });
        if (completed >= total) {
          window.clearInterval(timer);
          activePulls.delete(model);
          rememberPulled(model);
          emit("ollama-pull-progress", { model, status: "success" });
          resolve(null);
        }
      }, 150);
      activePulls.set(model, timer);
      (responses as any).__reject = reject;
    });
  };
  // Branching copies the source chat up to the branch point; the preview just
  // needs a session back with `branched_from` set so the sidebar glyph renders.
  responses.branch_chat_session = (args: any) => {
    const source = sampleSessions.find(s => s.id === args?.sessionId);
    const branch = {
      id: "branch-" + Math.random().toString(36).slice(2, 8),
      // A branch inherits its parent's title — the glyph is what distinguishes it.
      title: source?.title ?? "Branched chat",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      project_id: source?.project_id ?? null,
      branched_from: args?.sessionId ?? "unknown",
    };
    sampleSessions.unshift(branch);
    return branch;
  };

  /**
   * Notifications are mocked at the **Web API**, not at `invoke`.
   *
   * `@tauri-apps/plugin-notification` barely touches the IPC bridge — read its dist
   * to check: `requestPermission()` calls `window.Notification.requestPermission()`,
   * `sendNotification()` does `new window.Notification(title, options)`, and
   * `isPermissionGranted()` only falls back to `invoke` when
   * `window.Notification.permission` is still `"default"`. Handlers for
   * `plugin:notification|notify` were written here first and would never have been
   * called once — the exact "mock in the wrong shape" failure this file keeps a list
   * of, caught by reading the payload path before trusting it.
   *
   * Recording rather than showing, because what is worth asserting in a browser is
   * *whether one would have been raised, and saying what*. The real gate — window
   * focus — is genuinely real here, since `document.hasFocus()` works in a browser,
   * so anything recorded while the pane is focused is a true bug rather than a mock
   * artefact.
   */
  const mockNotifications: Array<{ title: string; body: string; at: number }> = [];
  (window as any).__mockNotifications = mockNotifications;
  (window as any).Notification = class MockNotification {
    static permission = "granted";
    static requestPermission = async () => "granted";
    constructor(title: string, options?: { body?: string }) {
      mockNotifications.push({
        title,
        body: options?.body ?? "",
        at: Math.round(performance.now()),
      });
    }
  };

  // Stateful runtime version, so the whole update cycle can be walked in the
  // browser: check → "Update to 0.32.9" → update → up to date → back to a plain
  // check. A no-op `update_ollama` left the CTA stuck offering an update that
  // never landed, which is the one state the real app can't be in.
  // Resolve after a beat rather than instantly: a real check is a network round
  // trip and a real install is a download, so returning immediately makes the
  // "Checking…"/"Installing…" states unreachable and therefore untestable.
  const after = <T,>(ms: number, value: T) =>
    new Promise<T>(resolve => window.setTimeout(() => resolve(value), ms));

  let mockRuntimeVersion = "0.14.3";
  const MOCK_LATEST = "0.32.9";
  // Starts borrowing a system Ollama, which is the state a fresh install is
  // actually in — the app finds one on PATH and uses it. Installing a managed
  // copy flips it, so both branches of the Settings CTA are reachable here.
  let mockManaged = false;
  responses.get_ollama_runtime = () => ({
    version: mockRuntimeVersion,
    path: mockManaged ? "/preview/app-data/ollama" : "/usr/local/bin/ollama",
    managed_by_app: mockManaged,
    outdated: mockRuntimeVersion !== MOCK_LATEST,
    latest: null,
  });
  responses.install_managed_ollama = () =>
    after(1500, null).then(v => {
      mockManaged = true;
      mockRuntimeVersion = MOCK_LATEST;
      return v;
    });
  // Healthy by default. Flip `verified` to false to exercise the mismatch notice —
  // it can't be reproduced here otherwise, since nothing is really signed.
  responses.check_ollama_integrity = () => ({ managed: mockManaged, verified: mockManaged ? true : null, detail: null });
  responses.check_ollama_update = () => after(900, MOCK_LATEST);
  responses.update_ollama = () =>
    after(1500, null).then(v => {
      mockRuntimeVersion = MOCK_LATEST;
      return v;
    });

  // Fake chat stream: a <think> block then an answer, one token every 40ms, with
  // the same `chat-done` stats shape Ollama sends on its final chunk. Without this
  // the generation status row and the thinking panel can't be exercised at all in
  // the browser — there's no model here to stream from.
  /** Stream ids asked to stop, drained by the fake stream loop below. */
  const stoppedStreams = new Set<string>();
  responses.stop_chat_message = (args: any) => {
    if (args?.streamId) stoppedStreams.add(args.streamId);
    return null;
  };

  // MCP tool calls have no engine here, so the flow is faked from events — the
  // same shape the Rust loop emits. Approvals resolve through `mcp_approve_tool`.
  const pendingApprovals: Record<string, (decision: string) => void> = {};
  responses.mcp_approve_tool = (args: any) => {
    pendingApprovals[args?.callId]?.(args?.decision);
    return null;
  };

  // Enough MCP config surface for the library/settings and the enabled-servers
  // resolution to work in the browser. One enabled server, so a send with tools
  // has something to offer.
  let mockMcpConfig: any = {
    mcpServers: {
      weather: { command: "npx", args: ["-y", "weather-mcp"], env: {}, secrets: ["API_KEY"], enabled: true },
      // A remote (Streamable-HTTP) server, so the connect/headers path is visible.
      docs: { url: "https://example.com/mcp", headers: {}, secrets: ["Authorization"], enabled: false },
    },
  };
  // Running state is tracked for real (a Set), so Start/Stop in Settings and the
  // enabled∩running resolution behave like the app: a server is offered to a send
  // only after it has been started. Begins empty — the user starts it in Settings.
  const mockRunningServers = new Set<string>();
  responses.mcp_read_config = () => mockMcpConfig;
  responses.mcp_write_config = (args: any) => { mockMcpConfig = args?.config ?? mockMcpConfig; return null; };
  responses.mcp_running_servers = () => Array.from(mockRunningServers);
  responses.mcp_start_server = (args: any) => { if (args?.id) mockRunningServers.add(args.id); return null; };
  responses.mcp_stop_server = (args: any) => { if (args?.id) mockRunningServers.delete(args.id); return null; };
  responses.mcp_list_tools = () => [
    { name: "get_weather", description: "Get the current weather for a city", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
  ];
  responses.mcp_set_secret = () => null;
  responses.mcp_delete_secret = () => null;
  responses.mcp_delete_server = (args: any) => {
    if (args?.id) {
      mockRunningServers.delete(args.id);
      const next = { ...mockMcpConfig, mcpServers: { ...mockMcpConfig.mcpServers } };
      delete next.mcpServers[args.id];
      mockMcpConfig = next;
    }
    return null;
  };

  /**
   * A full tool round, faked from events in the order the Rust loop emits them:
   * announce the call → block on the user → deliver the result → stream the answer.
   * Reached by asking about "weather"/"tools", or once a send carries enabledServers.
   */
  async function runToolFlow(streamId: string, startedAt: number): Promise<null> {
    const callId = "call_" + Math.random().toString(36).slice(2, 8);
    emit("chat-tool-call", {
      stream_id: streamId, call_id: callId, tool: "weather__get_weather",
      server: "weather", tool_name: "get_weather", arguments: { city: "Paris" }, needs_approval: true,
    });
    const decision = await new Promise<string>(res => { pendingApprovals[callId] = res; });
    delete pendingApprovals[callId];

    if (decision === "deny") {
      emit("chat-tool-result", { stream_id: streamId, call_id: callId, tool: "weather__get_weather", is_error: true, content: "The user declined to run this tool.", decision: "deny" });
    } else {
      emit("chat-tool-result", { stream_id: streamId, call_id: callId, tool: "weather__get_weather", is_error: false, content: "18°C, partly cloudy, wind 12 km/h", decision });
    }

    const answer = decision === "deny"
      ? ["I can't", " check", " the weather", " without", " your", " go-ahead."]
      : ["It's", " **18°C**", " and", " partly", " cloudy", " in", " Paris", " right now."];
    for (const tok of answer) {
      if (stoppedStreams.has(streamId)) { stoppedStreams.delete(streamId); break; }
      emit("chat-token", { stream_id: streamId, token: tok });
      await after(60, null);
    }
    emit("chat-done", { stream_id: streamId, total_duration: (Date.now() - startedAt) * 1e6, prompt_eval_count: 30, eval_count: answer.length });
    return null;
  }

  responses.send_chat_message = (args: any) => {
    // Must echo the caller's streamId: the real events are scoped to a request so
    // concurrent chats can't interleave, and ChatPage drops anything unscoped.
    const streamId = args?.streamId;
    // Trigger the tool round on a weather/tool question, or on any send that opts
    // into MCP servers — the latter is how milestone 10's wiring will reach it.
    const lastMsg = args?.messages?.[args.messages.length - 1];
    const toolTrigger =
      /\b(tool|weather)\b/i.test(lastMsg?.content || "")
      || (Array.isArray(args?.enabledServers) && args.enabledServers.length > 0);
    if (toolTrigger) return runToolFlow(streamId, Date.now());
    const script = [
      "<think>", "\nThe user is asking about the ocean.", " I should mention",
      " tides", " and", " salinity", " before", " anything", " else.", "\n</think>",
      "\n\nThe ocean", " covers", " about", " 71%", " of", " Earth's", " surface",
      " and", " holds", " nearly", " all", " of", " its", " water.",
      // A fenced block, so code rendering — highlighting, the copy button, and the
      // single inset that `pre code.hljs` provides — is exercisable in the browser.
      "\n\n```js\n", "const depth", " = 3688;", "\nconsole.log(depth);", "\n```\n",
    ];
    let i = 0;
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const timer = window.setInterval(() => {
        // Stoppable, so the stop button is exercisable here. The real backend ends
        // the stream and returns what it already produced; this does the same.
        if (stoppedStreams.has(streamId)) {
          window.clearInterval(timer);
          stoppedStreams.delete(streamId);
          emit("chat-done", { stream_id: streamId, stats: { total_duration: (Date.now() - startedAt) * 1e6, prompt_eval_count: 41, eval_count: i } });
          resolve(null);
          return;
        }
        emit("chat-token", { stream_id: streamId, token: script[i++] });
        if (i >= script.length) {
          window.clearInterval(timer);
          emit("chat-done", {
            stream_id: streamId,
            total_duration: (Date.now() - startedAt) * 1e6,
            prompt_eval_count: 24,
            eval_count: script.length,
          });
          resolve(null);
        }
      }, 80);
    });
  };

  responses.cancel_ollama_model = (args: any) => {
    const timer = activePulls.get(args?.model);
    if (timer) {
      window.clearInterval(timer);
      activePulls.delete(args?.model);
    }
    return null;
  };

  /**
   * Every command the UI issued, in order, with a timestamp.
   *
   * The mock always answers (see CLAUDE.md), so reading state back proves nothing —
   * what a flow actually *did* is the sequence of calls it made. This is also the
   * only way to assert a negative: that onboarding did NOT start a second
   * `pull_ollama_model` over the engine's own download, say. Read it as
   * `window.__mockCalls` on a later tool call, since short-lived states are gone by
   * the time a DOM read lands.
   */
  const callLog: Array<{ t: number; cmd: string; model?: string }> = [];
  (window as any).__mockCalls = callLog;

  (window as any).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: any) => {
      if (!cmd.startsWith("plugin:")) {
        callLog.push({ t: Math.round(performance.now()), cmd, model: args?.model });
        if (callLog.length > 400) callLog.shift();
      }
      if (cmd === "plugin:event|listen") {
        const { event, handler } = args ?? {};
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(handler);
        return handler;
      }
      if (cmd === "plugin:event|unlisten" || cmd === "plugin:event|emit") {
        return null;
      }
      // `ask()` from the dialog plugin. Unhandled, it answered `null`, so every
      // confirmed action in the browser silently did nothing — deleting a chat, and
      // now deleting archived conversations, both looked like dead buttons. Answering
      // `true` makes the confirmed path the one the preview exercises; flip it to
      // `false` to check that declining really cancels.
      if (cmd === "plugin:dialog|ask" || cmd === "plugin:dialog|confirm") {
        console.info("[dev-mock] auto-confirming", args?.message ?? args?.title ?? "");
        return true;
      }
      const handler = responses[cmd];
      if (handler) return handler(args);
      console.warn(`[dev-mock] Unhandled Tauri invoke: ${cmd}`, args);
      return null;
    },
    transformCallback: (cb: (payload: any) => void) => {
      const id = ++callbackId;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback: (id: number) => callbacks.delete(id),
    convertFileSrc: (filePath: string) => filePath,
  };

  // Unlistening goes through a SEPARATE global (see @tauri-apps/api/event.js):
  // the function returned by `listen()` calls
  // __TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(event, eventId).
  // Without this, every component that unsubscribes on unmount throws.
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (event: string, id: number) => {
      listeners.get(event)?.delete(id);
      callbacks.delete(id);
    },
  };

  console.info(
    "[dev-mock] Running Scarlettt UI in browser preview mode — Tauri APIs are mocked.",
  );
}
