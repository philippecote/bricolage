export type AppStatus = 'draft' | 'building' | 'ready' | 'failed' | 'archived';
export interface WorkshopApp {
  id: string; name: string; description: string; icon: string; accent: string; status: AppStatus;
  prompt: string; pinned: boolean; archived: boolean; createdAt: string; updatedAt: string;
  window: { width: number; height: number }; actions: string[]; threadId: string | null; revision: number; model: ModelPreset; error: string | null;
}
export type ModelPreset = 'luna-high' | 'luna-max' | 'sol-medium';
export interface BuildQuestion { id: string; prompt: string; options: string[] }
export interface BuildEvent { id: string; buildId: string; appId: string; phase: string; message: string; at: string; questions?: BuildQuestion[]; plan?: string[]; approval?: { id: string; summary: string } }
export interface BuildSummary { id: string; appId: string; status: string; model: ModelPreset; createdAt: string; updatedAt: string; events: BuildEvent[]; questions?: BuildQuestion[]; plan?: string[] }
export interface SystemStatus { name: string; version: string; codex: { available: boolean; authenticated: boolean; error: string | null }; activeBuilds: BuildSummary[] }
