import { invoke } from '@tauri-apps/api/core';
import { useCallback } from 'react';

export interface Project {
    id: string;
    name: string;
    created_at: string;
    updated_at: string;
}

export const useProjects = () => {
    const createProject = useCallback(async (name?: string): Promise<Project> => {
        try {
            return await invoke<Project>('create_project', { name });
        } catch (error) {
            console.error('Error creating project:', error);
            throw error;
        }
    }, []);

    const getProjects = useCallback(async (): Promise<Project[]> => {
        try {
            return await invoke<Project[]>('get_projects');
        } catch (error) {
            console.error('Error getting projects:', error);
            throw error;
        }
    }, []);

    const renameProject = useCallback(async (projectId: string, name: string): Promise<void> => {
        try {
            await invoke('rename_project', { projectId, name });
        } catch (error) {
            console.error('Error renaming project:', error);
            throw error;
        }
    }, []);

    /** Deleting a project keeps its chats — they fall back to Recent chats. */
    const deleteProject = useCallback(async (projectId: string): Promise<void> => {
        try {
            await invoke('delete_project', { projectId });
        } catch (error) {
            console.error('Error deleting project:', error);
            throw error;
        }
    }, []);

    /** Pass `null` to move the chat back out to Recent chats. */
    const setSessionProject = useCallback(async (sessionId: string, projectId: string | null): Promise<void> => {
        try {
            await invoke('set_session_project', { sessionId, projectId });
        } catch (error) {
            console.error('Error moving chat to project:', error);
            throw error;
        }
    }, []);

    return { createProject, getProjects, renameProject, deleteProject, setSessionProject };
};
