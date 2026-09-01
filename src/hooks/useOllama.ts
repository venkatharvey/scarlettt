import { invoke } from '@tauri-apps/api/core';

export interface ChatMessage {
    role: string;
    content: string;
}

export interface PullResponse {
    status: string;
    digest?: string;
    total?: number;
    completed?: number;
}

export interface RemoteModel {
    name: string;
    description: string;
    parameter_sizes: string[];
    /** Capability chips from the listing — available before download. */
    capabilities?: string[];
    size?: string;
    context_length?: number | null;
}

export interface ModelVariant {
    tag: string;
    size?: string | null;
    context_length?: number | null;
    modality?: string | null;
    updated?: string | null;
    quantization?: string | null;
}

/**
 * Provider-agnostic model page. Fields Ollama can't supply stay null so a future
 * backend can populate them without any UI change — absent means "don't render".
 */
export interface RemoteModelPage {
    name: string;
    description: string;
    capabilities: string[];
    parameter_sizes: string[];
    pulls?: string | null;
    tag_count?: number | null;
    updated?: string | null;
    readme?: string | null;
    variants: ModelVariant[];
    related: string[];
    stars?: number | null;
    curated?: boolean | null;
    format?: string | null;
    domain?: string | null;
}

export type OllamaStatus = 
    | 'Running'
    | 'Stopped'
    | { Downloading: { progress: number } }
    | 'Starting'
    | 'Checking'
    | { PullingModel: { progress: number } }
    | 'Missing';

/** An installed model and what `/api/tags` says it can do. */
export interface ModelSummary {
    name: string;
    /** `["completion", "tools"]`, or `["embedding"]` for one that cannot chat. */
    capabilities: string[];
}

/**
 * Whether this model can hold a conversation at all.
 *
 * Embedding models cannot: Ollama answers `/api/chat` with
 * `"all-minilm" does not support chat`, and the app logged that to the console and
 * showed the user nothing. They are one click away in the library now, so the
 * question had to be asked somewhere.
 *
 * An empty capability list is **unknown, not incapable** — an Ollama old enough to
 * omit the field would otherwise have every model judged unable to chat, emptying
 * the picker on exactly the runtimes least able to explain themselves. Permissive
 * there: the worst case is the old behaviour, which is a clear error from Ollama.
 */
export function canChat(model: ModelSummary): boolean {
    if (!model.capabilities?.length) return true;
    return model.capabilities.includes("completion");
}

/**
 * Whether tools may be *offered* to this model on a send (the send gate).
 *
 * Permissive-on-empty, exactly like {@link canChat}: an empty capability list means
 * "unknown" (an Ollama too old to report the field), and blocking there would deny
 * tools on the runtimes least able to explain themselves. The backend suppresses
 * tools while offline and a non-tool model simply never emits tool calls, so the
 * cost of being permissive here is bounded.
 */
export function canUseTools(model: ModelSummary): boolean {
    if (!model.capabilities?.length) return true;
    return model.capabilities.includes("tools");
}

/**
 * Whether to *show the "Tools" chip* for this model in the picker.
 *
 * Strict-on-empty — the deliberate opposite of {@link canUseTools}. A chip is a
 * promise to the reader, so it appears only when the model plainly declares the
 * capability; an unknown runtime is not advertised a tool ability it may not have.
 */
export function hasTools(model: ModelSummary): boolean {
    return !!model.capabilities?.includes("tools");
}

export const useOllama = () => {
    const getOllamaStatus = async (): Promise<OllamaStatus> => {
        try {
            return await invoke<OllamaStatus>('get_ollama_status');
        } catch (error) {
            console.error('Error getting Ollama status:', error);
            throw error;
        }
    };

    const startOllamaService = async (downloadIfMissing: boolean = false): Promise<void> => {
        try {
            await invoke('start_ollama_service', { downloadIfMissing });
        } catch (error) {
            console.error('Error starting Ollama service:', error);
            throw error;
        }
    };

    /** `streamId` scopes the chat-token/chat-done events to this request. */
    const streamMessage = async (
        model: string,
        messages: ChatMessage[],
        // Required, mirroring the Rust command: there is no "let Ollama choose".
        numCtx: number,
        // Likewise — Ollama resets the idle timer per request, so it rides along.
        keepAlive: number,
        streamId?: string,
        // The MCP servers whose tools this send may use. Optional and trailing —
        // absent means an ordinary tool-less chat, unlike the required num_ctx.
        enabledServers?: string[],
    ): Promise<void> => {
        try {
            console.log('Streaming message to Ollama with model:', model);
            await invoke('send_chat_message', {
                model,
                messages,
                numCtx,
                keepAlive,
                streamId: streamId ?? crypto.randomUUID(),
                enabledServers: enabledServers ?? [],
            });
        } catch (error) {
            console.error('Error sending message to Ollama:', error);
            throw error;
        }
    };

    /** Ends the reply with this `streamId`. Safe to call after it has finished. */
    const stopMessage = async (streamId: string): Promise<void> => {
        try {
            await invoke('stop_chat_message', { streamId });
        } catch (error) {
            console.error('Error stopping the reply:', error);
        }
    };

    const listModels = async (): Promise<ModelSummary[]> => {
        try {
            const models = await invoke<ModelSummary[]>('list_ollama_models');
            return models;
        } catch (error) {
            console.error('Error listing Ollama models:', error);
            throw error;
        }
    };

    const pullModel = async (model: string): Promise<void> => {
        try {
            await invoke('pull_ollama_model', { model });
        } catch (error) {
            console.error('Error pulling Ollama model:', error);
            throw error;
        }
    };

    /**
     * Exact download size in bytes, from Ollama's registry manifest rather than
     * the model's HTML page. `null` when the registry doesn't describe it — a
     * missing size is an "Unknown" fit badge, not an error.
     */
    const getRemoteModelSize = async (name: string): Promise<number | null> => {
        try {
            return await invoke<number | null>('get_remote_model_size', { name });
        } catch (error) {
            console.error('Error getting remote model size:', error);
            return null;
        }
    };

    const searchRemoteModels = async (query: string, sort?: string): Promise<RemoteModel[]> => {
        try {
            return await invoke<RemoteModel[]>('search_remote_ollama_models', { query, sort: sort ?? null });
        } catch (error) {
            console.error('Error searching remote models:', error);
            throw error;
        }
    };

    const deleteModel = async (model: string): Promise<void> => {
        try {
            console.log('Invoking delete_ollama_model for', model);
            await invoke('delete_ollama_model', { model });
            console.log('Successfully invoked delete_ollama_model for', model);
        } catch (error) {
            console.error('Error deleting model:', error);
            throw error;
        }
    };

    const cancelModelDownload = async (model: string): Promise<void> => {
        try {
            console.log('Invoking cancel_ollama_model for', model);
            await invoke('cancel_ollama_model', { model });
            console.log('Successfully invoked cancel_ollama_model for', model);
        } catch (error) {
            console.error('Error canceling model download:', error);
            throw error;
        }
    };

    const getRemoteModelPage = async (name: string): Promise<RemoteModelPage | null> => {
        try {
            return await invoke<RemoteModelPage | null>('get_remote_model_page', { name });
        } catch (error) {
            console.error('Error fetching model page:', error);
            return null;
        }
    };

    const getRemoteModelDetails = async (model: string): Promise<RemoteModel | null> => {
        try {
             return await invoke<RemoteModel | null>('get_remote_model_details', { name: model });
        } catch (error) {
            console.error('Error fetching model details:', error);
            return null;
        }
    };

    return {
        getOllamaStatus,
        startOllamaService,
        streamMessage,
        stopMessage,
        listModels,
        pullModel,
        searchRemoteModels,
        getRemoteModelSize,
        deleteModel,
        cancelModelDownload,
        getRemoteModelDetails,
        getRemoteModelPage,
    };
};
