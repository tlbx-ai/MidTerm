/**
 * Git Module Types
 *
 * Mirrors the C# Git DTOs for the frontend.
 */

export interface GitStatusResponse {
  branch: string;
  ahead: number;
  behind: number;
  staged: GitFileEntry[];
  modified: GitFileEntry[];
  untracked: GitFileEntry[];
  conflicted: GitFileEntry[];
  recentCommits: GitLogEntry[];
  stashCount: number;
  repoRoot: string;
  totalAdditions: number;
  totalDeletions: number;
}

export interface GitFileEntry {
  path: string;
  status: string;
  originalPath?: string;
  additions: number;
  deletions: number;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
}

export interface GitWsMessage {
  type: string;
  sessionId: string;
  status?: GitStatusResponse;
  diff?: string;
  error?: string;
}
