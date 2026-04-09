import type { LensAttachmentReference } from '../../api/types';
import type { LensComposerDraftAttachment } from './lensAttachments';
import { buildLensComposerAttachmentFileUrl, toLensAttachmentReference } from './lensAttachments';
import type { SmartInputComposerDraft, SmartInputComposerPart } from './smartInputComposerDraft';

export interface PrepareSmartInputOutboundPromptArgs {
  sessionId: string;
  draft: SmartInputComposerDraft;
  attachments: readonly LensComposerDraftAttachment[];
  target: 'lens' | 'terminal';
  uploadFailureMessage: string;
  attachmentReadFailureMessage: string;
  uploadFile: (sessionId: string, file: File) => Promise<string | null>;
}

export interface PreparedSmartInputOutboundPrompt {
  attachments: LensAttachmentReference[];
  text: string;
}

export async function prepareSmartInputOutboundPrompt(
  args: PrepareSmartInputOutboundPromptArgs,
): Promise<PreparedSmartInputOutboundPrompt> {
  const uploadedPaths = await Promise.all(
    args.attachments.map((attachment) => ensureUploadedAttachmentPath(args, attachment)),
  );
  const attachmentPathById = new Map<string, string>();
  args.attachments.forEach((attachment, index) => {
    attachmentPathById.set(attachment.id, uploadedPaths[index] ?? '');
  });

  const attachments =
    args.target === 'lens'
      ? args.attachments
          .filter((attachment) => attachment.referenceKind !== 'text')
          .map((attachment, index) =>
            toLensAttachmentReference(attachment, uploadedPaths[index] ?? ''),
          )
      : [];

  const referencedTextBlocks: string[] = [];
  const referencedTerminalAttachments: string[] = [];
  const seenExtraReferenceIds = new Set<string>();
  const referencedAttachmentIds = new Set<string>();

  const textParts = await Promise.all(
    args.draft.parts.map((part) =>
      resolveOutboundPartText(
        args,
        part,
        attachmentPathById,
        referencedAttachmentIds,
        seenExtraReferenceIds,
        referencedTextBlocks,
        referencedTerminalAttachments,
      ),
    ),
  );

  if (args.target === 'terminal') {
    for (const attachment of args.attachments) {
      const path = attachmentPathById.get(attachment.id) ?? '';
      if (!path || referencedAttachmentIds.has(attachment.id)) {
        continue;
      }

      if (attachment.referenceKind === 'text') {
        if (seenExtraReferenceIds.has(attachment.id)) {
          continue;
        }

        referencedTextBlocks.push(
          buildTextReferenceBlock(
            getAttachmentReferenceToken(attachment),
            await loadAttachmentTextContent(args, attachment, path),
          ),
        );
        seenExtraReferenceIds.add(attachment.id);
        continue;
      }

      referencedTerminalAttachments.push(`${getAttachmentReferenceToken(attachment)}: ${path}`);
    }
  }

  const sections = [
    joinPromptParts(textParts),
    referencedTerminalAttachments.length > 0 ? referencedTerminalAttachments.join('\n') : '',
    referencedTextBlocks.join('\n\n'),
  ].filter((section) => section.length > 0);

  return {
    attachments,
    text: sections.join('\n\n'),
  };
}

async function ensureUploadedAttachmentPath(
  args: PrepareSmartInputOutboundPromptArgs,
  attachment: LensComposerDraftAttachment,
): Promise<string> {
  if (attachment.uploadedPath) {
    return attachment.uploadedPath;
  }

  if (!attachment.file) {
    throw new Error(args.uploadFailureMessage);
  }

  const path = await args.uploadFile(args.sessionId, attachment.file);
  if (!path) {
    throw new Error(args.uploadFailureMessage);
  }

  return path;
}

async function resolveOutboundPartText(
  args: PrepareSmartInputOutboundPromptArgs,
  part: SmartInputComposerPart,
  attachmentPathById: ReadonlyMap<string, string>,
  referencedAttachmentIds: Set<string>,
  seenExtraReferenceIds: Set<string>,
  referencedTextBlocks: string[],
  referencedTerminalAttachments: string[],
): Promise<string> {
  if (part.kind === 'text') {
    return part.text;
  }

  const attachment = args.attachments.find((candidate) => candidate.id === part.referenceId);
  if (!attachment) {
    return '';
  }

  referencedAttachmentIds.add(attachment.id);
  const token = getAttachmentReferenceToken(attachment);
  const path = attachmentPathById.get(attachment.id) ?? '';

  if (!seenExtraReferenceIds.has(attachment.id)) {
    if (attachment.referenceKind === 'text') {
      referencedTextBlocks.push(
        buildTextReferenceBlock(token, await loadAttachmentTextContent(args, attachment, path)),
      );
      seenExtraReferenceIds.add(attachment.id);
    } else if (args.target === 'terminal' && path) {
      referencedTerminalAttachments.push(`${token}: ${path}`);
      seenExtraReferenceIds.add(attachment.id);
    }
  }

  return token;
}

function joinPromptParts(parts: readonly string[]): string {
  return parts.join('');
}

function buildTextReferenceBlock(token: string, text: string): string {
  return `${token}\n${text}`;
}

function getAttachmentReferenceToken(attachment: LensComposerDraftAttachment): string {
  const label = attachment.referenceLabel?.trim() || attachment.displayName.trim() || 'Attachment';
  return `[${label}]`;
}

async function loadAttachmentTextContent(
  args: PrepareSmartInputOutboundPromptArgs,
  attachment: LensComposerDraftAttachment,
  path: string,
): Promise<string> {
  if (attachment.file) {
    return normalizeTextReferenceContent(await attachment.file.text());
  }

  if (!path) {
    throw new Error(args.attachmentReadFailureMessage);
  }

  const response = await fetch(buildLensComposerAttachmentFileUrl(args.sessionId, path));
  if (!response.ok) {
    throw new Error(args.attachmentReadFailureMessage);
  }

  return normalizeTextReferenceContent(await response.text());
}

function normalizeTextReferenceContent(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
