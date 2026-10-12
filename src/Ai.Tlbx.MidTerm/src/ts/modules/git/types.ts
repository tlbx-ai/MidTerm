/**
 * Git Module Types
 *
 * Mirrors the C# Git DTOs for the frontend.
 */

export interface GitStatusResponse {
  label?: string | undefined;
  role?: string | undefined;
  source?: string | undefined;
  isPrimary?: boolean | undefined;
  branch: string;
  headHash?: string;
  indexVersion?: string;
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

export interface GitOperationRequest {
  sessionId: string;
  repoRoot: string;
  operationId: string;
  action: 'stage' | 'unstage' | 'commit';
  paths: string[];
  all: boolean;
  message?: string;
  expectedIndexVersion?: string;
  expectedHead?: string;
}

export interface GitOperationResponse {
  operationId: string;
  repoRoot: string;
  action: string;
  state: string;
  errorCode?: string | null;
  detail?: string | null;
  commitHash?: string | null;
  status?: GitStatusResponse | null;
}

export interface GitRepoBinding {
  repoRoot: string;
  label: string;
  role: string;
  source: string;
  isPrimary: boolean;
  status?: GitStatusResponse | null | undefined;
}

export interface GitRepoListResponse {
  repos: GitRepoBinding[];
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
  oldLine?: number | null;
  newLine?: number | null;
  segments?: Array<{ text: string; changed: boolean }>;
}

export interface GitDiffHunk {
  header: string;
  oldStart?: number;
  newStart?: number;
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
  isNewFile?: boolean;
  hasLineStats?: boolean;
  sizeBytes?: number | null;
  mimeType?: string | null;
  encoding?: string | null;
  contentVersion?: string | null;
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
  repos?: GitRepoBinding[];
  diff?: string;
  error?: string;
}
