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
  originalPath?: string | undefined;
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

export interface GitDiffLine {
  kind: string;
  text: string;
}

export interface GitDiffHunk {
  header: string;
  lines: GitDiffLine[];
}

export interface GitDiffFileView {
  path: string;
  originalPath?: string | undefined;
  status: string;
  additions: number;
  deletions: number;
  isBinary: boolean;
  isTruncated: boolean;
  hunks: GitDiffHunk[];
}

export interface GitDiffViewResponse {
  scope: string;
  title: string;
  isTruncated: boolean;
  files: GitDiffFileView[];
}

export interface GitCommitDetailsResponse {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  author: string;
  authoredDate: string;
  committedDate: string;
  parentHashes: string[];
  totalAdditions: number;
  totalDeletions: number;
  isTruncated: boolean;
  files: GitDiffFileView[];
}

export interface GitWsMessage {
  type: string;
  sessionId: string;
  status?: GitStatusResponse;
  diff?: string;
  error?: string;
}
