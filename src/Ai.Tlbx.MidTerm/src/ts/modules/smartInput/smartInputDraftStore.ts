import type { LensQuickSettingsSummary } from '../../api/types';
import type { LensComposerDraftAttachment } from './lensAttachments';
import {
  cloneLensComposerDraftAttachments,
  hydrateLensComposerDraftAttachment,
  releaseLensComposerDraftAttachmentPreviews,
  toPersistedLensComposerDraftAttachment,
  type PersistedLensComposerDraftAttachment,
} from './lensAttachments';
import {
  cloneSmartInputComposerDraft,
  type SmartInputComposerDraft,
  type SmartInputComposerPart,
  type SmartInputComposerReferenceKind,
} from './smartInputComposerDraft';

const LENS_ATTACHMENT_STORAGE_KEY_PREFIX = 'smartinput-lens-attachments:';
const PROMPT_HISTORY_STORAGE_KEY_PREFIX = 'smartinput-prompt-history:';
export const MAX_SMART_INPUT_PROMPT_HISTORY_ENTRIES = 5;

interface PersistedPromptHistoryQuickSettings {
  effort: string | null;
  model: string | null;
  permissionMode: string;
  planMode: string;
}

interface PersistedSmartInputPromptHistoryEntry {
  attachments: PersistedLensComposerDraftAttachment[];
  composerDraft: SmartInputComposerDraft;
  quickSettings: PersistedPromptHistoryQuickSettings | null;
}

export interface SmartInputPromptHistoryEntry {
  attachments: LensComposerDraftAttachment[];
  composerDraft: SmartInputComposerDraft;
  quickSettings: LensQuickSettingsSummary | null;
}

function getLensAttachmentStorageKey(sessionId: string): string {
  return `${LENS_ATTACHMENT_STORAGE_KEY_PREFIX}${sessionId}`;
}

function getPromptHistoryStorageKey(sessionId: string): string {
  return `${PROMPT_HISTORY_STORAGE_KEY_PREFIX}${sessionId}`;
}

function clonePromptHistoryQuickSettings(
  quickSettings: LensQuickSettingsSummary | null,
): LensQuickSettingsSummary | null {
  if (!quickSettings) {
    return null;
  }

  return {
    model: typeof quickSettings.model === 'string' ? quickSettings.model : null,
    effort: typeof quickSettings.effort === 'string' ? quickSettings.effort : null,
    planMode: typeof quickSettings.planMode === 'string' ? quickSettings.planMode : 'off',
    permissionMode:
      typeof quickSettings.permissionMode === 'string' ? quickSettings.permissionMode : 'manual',
  };
}

export function cloneSmartInputPromptHistoryEntry(
  entry: SmartInputPromptHistoryEntry,
): SmartInputPromptHistoryEntry {
  return {
    composerDraft: cloneSmartInputComposerDraft(entry.composerDraft),
    attachments: cloneLensComposerDraftAttachments(entry.attachments),
    quickSettings: clonePromptHistoryQuickSettings(entry.quickSettings),
  };
}

function cloneSmartInputPromptHistoryEntries(
  entries: readonly SmartInputPromptHistoryEntry[],
): SmartInputPromptHistoryEntry[] {
  return entries.map((entry) => cloneSmartInputPromptHistoryEntry(entry));
}

function toPersistedPromptHistoryQuickSettings(
  quickSettings: LensQuickSettingsSummary | null,
): PersistedPromptHistoryQuickSettings | null {
  if (!quickSettings) {
    return null;
  }

  return {
    model: typeof quickSettings.model === 'string' ? quickSettings.model : null,
    effort: typeof quickSettings.effort === 'string' ? quickSettings.effort : null,
    planMode: typeof quickSettings.planMode === 'string' ? quickSettings.planMode : 'off',
    permissionMode:
      typeof quickSettings.permissionMode === 'string' ? quickSettings.permissionMode : 'manual',
  };
}

function persistLensDraftAttachmentsForSession(
  sessionId: string,
  attachments: readonly LensComposerDraftAttachment[],
): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  const persisted = attachments
    .map((attachment) => toPersistedLensComposerDraftAttachment(attachment))
    .filter(
      (attachment): attachment is PersistedLensComposerDraftAttachment => attachment !== null,
    );

  if (persisted.length === 0) {
    localStorage.removeItem(getLensAttachmentStorageKey(sessionId));
    return;
  }

  localStorage.setItem(getLensAttachmentStorageKey(sessionId), JSON.stringify(persisted));
}

function clearPersistedLensDraftAttachmentsForSession(sessionId: string): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.removeItem(getLensAttachmentStorageKey(sessionId));
}

function persistPromptHistoryForSession(
  sessionId: string,
  entries: readonly SmartInputPromptHistoryEntry[],
): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  if (entries.length === 0) {
    localStorage.removeItem(getPromptHistoryStorageKey(sessionId));
    return;
  }

  const persisted: PersistedSmartInputPromptHistoryEntry[] = entries.map((entry) => ({
    composerDraft: cloneSmartInputComposerDraft(entry.composerDraft),
    attachments: entry.attachments
      .map((attachment) => toPersistedLensComposerDraftAttachment(attachment))
      .filter(
        (attachment): attachment is PersistedLensComposerDraftAttachment => attachment !== null,
      ),
    quickSettings: toPersistedPromptHistoryQuickSettings(entry.quickSettings),
  }));

  localStorage.setItem(getPromptHistoryStorageKey(sessionId), JSON.stringify(persisted));
}

function clearPersistedPromptHistoryForSession(sessionId: string): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.removeItem(getPromptHistoryStorageKey(sessionId));
}

// eslint-disable-next-line complexity -- persisted attachment hydration validates several optional reference metadata fields while keeping the storage schema explicit.
function tryParsePersistedLensDraftAttachment(
  value: unknown,
): PersistedLensComposerDraftAttachment | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const attachment = value as Record<string, unknown>;
  const kind = attachment.kind;
  if (kind !== 'image' && kind !== 'file') {
    return null;
  }

  const uploadedPath = attachment.uploadedPath;
  const displayName = attachment.displayName;
  const sizeBytes = attachment.sizeBytes;
  if (
    typeof attachment.id !== 'string' ||
    typeof uploadedPath !== 'string' ||
    typeof displayName !== 'string' ||
    typeof sizeBytes !== 'number'
  ) {
    return null;
  }

  return {
    id: attachment.id,
    kind,
    uploadedPath,
    displayName,
    mimeType: typeof attachment.mimeType === 'string' ? attachment.mimeType : null,
    referenceKind:
      attachment.referenceKind === 'image' ||
      attachment.referenceKind === 'file' ||
      attachment.referenceKind === 'text'
        ? attachment.referenceKind
        : null,
    referenceLineCount:
      typeof attachment.referenceLineCount === 'number' ? attachment.referenceLineCount : null,
    referenceCharCount:
      typeof attachment.referenceCharCount === 'number' ? attachment.referenceCharCount : null,
    referenceLabel:
      typeof attachment.referenceLabel === 'string' ? attachment.referenceLabel : null,
    referenceOrdinal:
      typeof attachment.referenceOrdinal === 'number' ? attachment.referenceOrdinal : null,
    sizeBytes,
  };
}

function tryParseComposerPart(value: unknown): SmartInputComposerPart | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const part = value as Record<string, unknown>;
  if (part.kind === 'text' && typeof part.text === 'string') {
    return {
      kind: 'text',
      text: part.text,
    };
  }

  if (part.kind === 'reference' && typeof part.referenceId === 'string') {
    return {
      kind: 'reference',
      referenceId: part.referenceId,
    };
  }

  return null;
}

function tryParseComposerDraft(value: unknown): SmartInputComposerDraft | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const draft = value as Record<string, unknown>;
  if (!Array.isArray(draft.parts)) {
    return null;
  }

  const parts: SmartInputComposerPart[] = [];
  for (const valuePart of draft.parts) {
    const parsedPart = tryParseComposerPart(valuePart);
    if (!parsedPart) {
      return null;
    }

    parts.push(parsedPart);
  }

  const nextOrdinalByKind: Partial<Record<SmartInputComposerReferenceKind, number>> = {};
  const ordinalSource =
    draft.nextOrdinalByKind && typeof draft.nextOrdinalByKind === 'object'
      ? (draft.nextOrdinalByKind as Record<string, unknown>)
      : {};
  for (const kind of ['image', 'file', 'text'] as const) {
    const rawOrdinal = ordinalSource[kind];
    if (
      typeof rawOrdinal === 'number' &&
      Number.isFinite(rawOrdinal) &&
      rawOrdinal >= 1 &&
      Number.isInteger(rawOrdinal)
    ) {
      nextOrdinalByKind[kind] = rawOrdinal;
    }
  }

  return {
    nextOrdinalByKind,
    parts,
  };
}

function tryParsePromptHistoryQuickSettings(value: unknown): LensQuickSettingsSummary | null {
  if (value === null) {
    return null;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const quickSettings = value as Record<string, unknown>;
  return {
    model: typeof quickSettings.model === 'string' ? quickSettings.model : null,
    effort: typeof quickSettings.effort === 'string' ? quickSettings.effort : null,
    planMode: typeof quickSettings.planMode === 'string' ? quickSettings.planMode : 'off',
    permissionMode:
      typeof quickSettings.permissionMode === 'string' ? quickSettings.permissionMode : 'manual',
  };
}

function tryParsePromptHistoryEntry(
  sessionId: string,
  value: unknown,
): SmartInputPromptHistoryEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const entry = value as Record<string, unknown>;
  if (!Array.isArray(entry.attachments)) {
    return null;
  }

  const composerDraft = tryParseComposerDraft(entry.composerDraft);
  if (!composerDraft) {
    return null;
  }

  const attachments = entry.attachments
    .map((attachment) => tryParsePersistedLensDraftAttachment(attachment))
    .filter((attachment): attachment is PersistedLensComposerDraftAttachment => attachment !== null)
    .map((attachment) => hydrateLensComposerDraftAttachment(sessionId, attachment));
  const quickSettings = tryParsePromptHistoryQuickSettings(entry.quickSettings ?? null);
  if (entry.quickSettings !== null && entry.quickSettings !== undefined && !quickSettings) {
    return null;
  }

  return {
    composerDraft,
    attachments,
    quickSettings,
  };
}

export function loadLensDraftAttachmentsForSession(
  sessionId: string,
): LensComposerDraftAttachment[] {
  if (typeof localStorage === 'undefined') {
    return [];
  }

  const raw = localStorage.getItem(getLensAttachmentStorageKey(sessionId));
  if (!raw) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((value) => tryParsePersistedLensDraftAttachment(value))
      .filter(
        (attachment): attachment is PersistedLensComposerDraftAttachment => attachment !== null,
      )
      .map((attachment) => hydrateLensComposerDraftAttachment(sessionId, attachment));
  } catch {
    return [];
  }
}

export function loadSmartInputPromptHistoryForSession(
  sessionId: string,
): SmartInputPromptHistoryEntry[] {
  if (typeof localStorage === 'undefined') {
    return [];
  }

  const raw = localStorage.getItem(getPromptHistoryStorageKey(sessionId));
  if (!raw) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((value) => tryParsePromptHistoryEntry(sessionId, value))
      .filter((entry): entry is SmartInputPromptHistoryEntry => entry !== null);
  } catch {
    return [];
  }
}

export function getLensDraftAttachmentsForSession(
  drafts: ReadonlyMap<string, LensComposerDraftAttachment[]>,
  sessionId: string | null,
): LensComposerDraftAttachment[] {
  return sessionId ? (drafts.get(sessionId) ?? []) : [];
}

export function setLensDraftAttachmentsForSession(
  drafts: Map<string, LensComposerDraftAttachment[]>,
  sessionId: string,
  attachments: readonly LensComposerDraftAttachment[],
): void {
  if (attachments.length === 0) {
    drafts.delete(sessionId);
    clearPersistedLensDraftAttachmentsForSession(sessionId);
    return;
  }

  drafts.set(sessionId, [...attachments]);
  persistLensDraftAttachmentsForSession(sessionId, attachments);
}

export function clearLensDraftAttachmentsForSession(
  drafts: Map<string, LensComposerDraftAttachment[]>,
  sessionId: string,
  revokePreviews: boolean = true,
): void {
  const attachments = drafts.get(sessionId);
  drafts.delete(sessionId);
  clearPersistedLensDraftAttachmentsForSession(sessionId);
  if (!attachments) {
    return;
  }
  if (revokePreviews) {
    releaseLensComposerDraftAttachmentPreviews(attachments);
  }
}

export function detachLensDraftAttachmentsForSession(
  drafts: Map<string, LensComposerDraftAttachment[]>,
  sessionId: string,
): LensComposerDraftAttachment[] {
  const attachments = getLensDraftAttachmentsForSession(drafts, sessionId);
  drafts.delete(sessionId);
  clearPersistedLensDraftAttachmentsForSession(sessionId);
  return cloneLensComposerDraftAttachments(attachments);
}

export function getSmartInputPromptHistoryForSession(
  histories: ReadonlyMap<string, SmartInputPromptHistoryEntry[]>,
  sessionId: string | null,
): SmartInputPromptHistoryEntry[] {
  if (!sessionId) {
    return [];
  }

  return cloneSmartInputPromptHistoryEntries(histories.get(sessionId) ?? []);
}

export function setSmartInputPromptHistoryForSession(
  histories: Map<string, SmartInputPromptHistoryEntry[]>,
  sessionId: string,
  entries: readonly SmartInputPromptHistoryEntry[],
): void {
  if (entries.length === 0) {
    histories.delete(sessionId);
    clearPersistedPromptHistoryForSession(sessionId);
    return;
  }

  const normalizedEntries = cloneSmartInputPromptHistoryEntries(
    entries.slice(0, MAX_SMART_INPUT_PROMPT_HISTORY_ENTRIES),
  );
  histories.set(sessionId, normalizedEntries);
  persistPromptHistoryForSession(sessionId, normalizedEntries);
}

export function pushSmartInputPromptHistoryEntryForSession(
  histories: Map<string, SmartInputPromptHistoryEntry[]>,
  sessionId: string,
  entry: SmartInputPromptHistoryEntry,
): void {
  const existingEntries =
    histories.get(sessionId) ?? loadSmartInputPromptHistoryForSession(sessionId);
  setSmartInputPromptHistoryForSession(histories, sessionId, [
    cloneSmartInputPromptHistoryEntry(entry),
    ...existingEntries,
  ]);
}

export function clearSmartInputPromptHistoryForSession(
  histories: Map<string, SmartInputPromptHistoryEntry[]>,
  sessionId: string,
): void {
  const entries = histories.get(sessionId);
  histories.delete(sessionId);
  clearPersistedPromptHistoryForSession(sessionId);
  if (!entries) {
    return;
  }

  for (const entry of entries) {
    releaseLensComposerDraftAttachmentPreviews(entry.attachments);
  }
}

export function persistSessionDraft(
  drafts: Map<string, string>,
  sessionId: string | null,
  draft: string,
): void {
  if (!sessionId) {
    return;
  }

  if (draft) {
    drafts.set(sessionId, draft);
    return;
  }

  drafts.delete(sessionId);
}

export function applySessionDraftToTextarea(
  drafts: ReadonlyMap<string, string>,
  textarea: HTMLTextAreaElement | null,
  sessionId: string | null,
  resizeTextarea: (textarea: HTMLTextAreaElement) => void,
): void {
  if (!textarea) {
    return;
  }

  const nextValue = sessionId ? (drafts.get(sessionId) ?? '') : '';
  if (textarea.value !== nextValue) {
    textarea.value = nextValue;
  }
  textarea.scrollTop = 0;
  resizeTextarea(textarea);
}
