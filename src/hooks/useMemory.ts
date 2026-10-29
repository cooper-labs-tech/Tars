'use client';

import { useState, useCallback, useEffect } from 'react';
import type { ProjectMemory, MemoryFile } from '@/types/electron';
import { useDesktopApi } from './useDesktopApi';

export const isElectron = (): boolean =>
  typeof window !== 'undefined' && window.electronAPI !== undefined;

export interface MemoryState {
  projects: ProjectMemory[];
  selectedProject: ProjectMemory | null;
  selectedFile: MemoryFile | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  searchQuery: string;
}

export function useMemory() {
  // Read through the hook so the page renders the same tree during the
  // pre-render and the hydration pass: see useDesktopApi.
  const hasMemoryApi = useDesktopApi(api => api.memory);
  const [projects, setProjects] = useState<ProjectMemory[]>([]);
  const [agentCountByPath, setAgentCountByPath] = useState<Map<string, number>>(new Map());
  const [selectedProject, setSelectedProject] = useState<ProjectMemory | null>(null);
  const [selectedFile, setSelectedFile] = useState<MemoryFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  /** `quiet`: read again behind a list already shown, without its loading state (after a save). */
  const fetchProjects = useCallback(async (quiet = false) => {
    if (!isElectron() || !window.electronAPI?.memory) {
      setLoading(false);
      return;
    }
    try {
      if (!quiet) setLoading(true);
      setError(null);
      // Agents first: their project folders are part of what Brain must show,
      // even when Claude Code never wrote memory for them yet.
      const agents = await window.electronAPI.agent.list().catch(() => []);
      const allProjects = await window.electronAPI?.fs?.listProjects().catch(() => []) ?? [];
      const customProjects: string[] = allProjects.map(p => p.path).filter(Boolean);
      const knownPaths = Array.from(new Set([
        ...agents.map(a => a.projectPath).filter(Boolean),
        ...customProjects,
      ]));
      const memResult = await window.electronAPI.memory.listProjects(knownPaths);

      // Build agent count map keyed by projectPath
      const countMap = new Map<string, number>();
      for (const agent of agents) {
        if (agent.status === 'running' || agent.status === 'waiting') {
          const key = agent.projectPath;
          countMap.set(key, (countMap.get(key) ?? 0) + 1);
        }
      }
      setAgentCountByPath(countMap);

      if (memResult.error) {
        setError(memResult.error);
      } else {
        setProjects(memResult.projects);
        // Refresh selected project data if it was selected
        if (selectedProject) {
          const updated = memResult.projects.find(p => p.id === selectedProject.id);
          if (updated) setSelectedProject(updated);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load memory projects');
    } finally {
      setLoading(false);
    }
  }, [selectedProject]);

  const selectProject = useCallback((project: ProjectMemory | null) => {
    setSelectedProject(project);
    setSelectedFile(null);
  }, []);

  const selectFile = useCallback((file: MemoryFile | null) => {
    setSelectedFile(file);
  }, []);

  const saveFile = useCallback(async (filePath: string, content: string): Promise<boolean> => {
    if (!isElectron() || !window.electronAPI?.memory) return false;
    try {
      setSaving(true);
      const result = await window.electronAPI.memory.writeFile(filePath, content);
      if (result.success) {
        // Update local state
        setSelectedFile(prev => prev ? { ...prev, content } : null);
        setProjects(prev => prev.map(p => ({
          ...p,
          files: p.files.map(f => f.path === filePath ? { ...f, content } : f),
        })));
        // Main's guard of MEMORY.md (PR 558) is computed when the projects are listed: read them again, or the
        // row and the open file keep saying what the file no longer is (the Audit's M1 on PR 560).
        await fetchProjects(true);
        return true;
      }
      setError(result.error ?? 'Failed to save file');
      return false;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save file');
      return false;
    } finally {
      setSaving(false);
    }
  }, [fetchProjects]);

  const createFile = useCallback(async (memoryDir: string, fileName: string): Promise<boolean> => {
    if (!isElectron() || !window.electronAPI?.memory) return false;
    try {
      const result = await window.electronAPI.memory.createFile(memoryDir, fileName, '');
      if (result.success && result.file) {
        await fetchProjects();
        return true;
      }
      setError(result.error ?? 'Failed to create file');
      return false;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create file');
      return false;
    }
  }, [fetchProjects]);

  const deleteFile = useCallback(async (filePath: string): Promise<boolean> => {
    if (!isElectron() || !window.electronAPI?.memory) return false;
    try {
      const result = await window.electronAPI.memory.deleteFile(filePath);
      if (result.success) {
        if (selectedFile?.path === filePath) setSelectedFile(null);
        await fetchProjects();
        return true;
      }
      setError(result.error ?? 'Failed to delete file');
      return false;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete file');
      return false;
    }
  }, [selectedFile, fetchProjects]);

  // Sort: active agents first (desc), then alphabetically
  const sortedProjects = [...projects].sort((a, b) => {
    const aAgents = agentCountByPath.get(a.projectPath) ?? 0;
    const bAgents = agentCountByPath.get(b.projectPath) ?? 0;
    if (bAgents !== aAgents) return bAgents - aAgents;
    return a.projectName.localeCompare(b.projectName);
  });

  // Derived: filtered projects by search
  const filteredProjects = searchQuery.trim()
    ? sortedProjects.filter(p =>
        p.projectName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.projectPath.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.files.some(f => f.content.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : sortedProjects;

  // Stats
  const totalFiles = projects.reduce((sum, p) => sum + p.files.length, 0);
  const totalSize = projects.reduce((sum, p) => sum + p.totalSize, 0);
  const projectsWithMemory = projects.filter(p => p.hasMemory).length;

  useEffect(() => {
    fetchProjects();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    projects,
    filteredProjects,
    agentCountByPath,
    selectedProject,
    selectedFile,
    loading,
    saving,
    error,
    searchQuery,
    setSearchQuery,
    totalFiles,
    totalSize,
    projectsWithMemory,
    isElectron: hasMemoryApi,
    selectProject,
    selectFile,
    saveFile,
    createFile,
    deleteFile,
    refresh: () => fetchProjects(),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function timeAgo(isoDate: string): string {
  if (!isoDate) return 'Never';
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(isoDate).toLocaleDateString();
}
