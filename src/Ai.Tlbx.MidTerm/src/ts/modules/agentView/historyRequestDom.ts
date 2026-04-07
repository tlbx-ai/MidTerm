import { showDevErrorDialog } from '../../utils/devErrorDialog';
import {
  approveLensRequest,
  declineLensRequest,
  resolveLensUserInput,
  type LensPulseRequestSummary,
} from '../../api/client';
import type { SessionLensViewState } from './types';

export type AgentHistoryRequestDomDeps = {
  getState: (sessionId: string) => SessionLensViewState | undefined;
  refreshLensSnapshot: (sessionId: string) => Promise<void>;
  renderCurrentAgentView: (sessionId: string) => void;
  logWarn: (message: () => string) => void;
};

type LensText = (key: string, fallback: string) => string;
type LensFormat = (
  key: string,
  fallback: string,
  replacements: Record<string, string | number>,
) => string;

export function createRequestActionBlock(args: {
  busy: boolean;
  deps: AgentHistoryRequestDomDeps;
  lensFormat: LensFormat;
  lensText: LensText;
  request: LensPulseRequestSummary;
  sessionId: string;
  state: SessionLensViewState;
}): HTMLElement {
  const { busy, deps, lensFormat, lensText, request, sessionId, state } = args;
  const actions = document.createElement('div');
  const isUserInputRequest = request.kind === 'tool_user_input' && request.questions.length > 0;
  actions.className = `agent-request-actions agent-request-actions-composer ${isUserInputRequest ? 'agent-request-actions-user-input' : 'agent-request-actions-approval'}`;
  const panel = document.createElement('section');
  panel.className = `agent-request-panel ${isUserInputRequest ? 'agent-request-panel-user-input' : 'agent-request-panel-approval'}`;
  panel.appendChild(createRequestPanelHeader(request, lensText, lensFormat));

  if (isUserInputRequest) {
    panel.appendChild(
      createUserInputRequestForm({
        busy,
        deps,
        lensText,
        request,
        sessionId,
        state,
      }),
    );
    actions.appendChild(panel);
    return actions;
  }

  panel.appendChild(createApprovalButtonRow(busy, deps, lensText, request, sessionId));
  actions.appendChild(panel);
  return actions;
}

function createUserInputRequestForm(args: {
  busy: boolean;
  deps: AgentHistoryRequestDomDeps;
  lensText: LensText;
  request: LensPulseRequestSummary;
  sessionId: string;
  state: SessionLensViewState;
}): HTMLElement {
  const { busy, deps, lensText, request, sessionId, state } = args;
  const draftAnswers = ensureRequestDraftAnswers(state, request);
  const activeQuestionIndex = resolveActiveRequestQuestionIndex(state, request);
  const activeQuestion = request.questions[activeQuestionIndex];
  const form = document.createElement('form');
  form.className = 'agent-request-form';
  if (!activeQuestion) {
    return form;
  }

  form.appendChild(
    createQuestionField({
      deps,
      draftAnswers,
      index: activeQuestionIndex,
      lensText,
      question: activeQuestion,
      request,
      sessionId,
      totalQuestions: request.questions.length,
    }),
  );
  form.appendChild(
    createUserInputControls(
      busy,
      deps,
      lensText,
      request,
      sessionId,
      activeQuestion,
      activeQuestionIndex,
      draftAnswers,
    ),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (activeQuestionIndex < request.questions.length - 1) {
      setActiveRequestQuestionIndex(deps, sessionId, request.requestId, activeQuestionIndex + 1);
      return;
    }

    void handleResolveUserInput(
      deps,
      lensText,
      sessionId,
      request.requestId,
      collectQuestionAnswers(state, request),
    );
  });
  return form;
}

function createUserInputControls(
  busy: boolean,
  deps: AgentHistoryRequestDomDeps,
  lensText: LensText,
  request: LensPulseRequestSummary,
  sessionId: string,
  activeQuestion: LensPulseRequestSummary['questions'][number],
  activeQuestionIndex: number,
  draftAnswers: Record<string, string[]>,
): HTMLElement {
  const formControls = document.createElement('div');
  formControls.className = 'agent-request-button-row';

  if (activeQuestionIndex > 0) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'agent-view-btn';
    back.disabled = busy;
    back.textContent = lensText('lens.request.back', 'Back');
    back.addEventListener('click', () => {
      setActiveRequestQuestionIndex(deps, sessionId, request.requestId, activeQuestionIndex - 1);
    });
    formControls.appendChild(back);
  }

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'agent-view-btn agent-view-btn-primary';
  submit.disabled = busy || !hasDraftAnswerForQuestion(draftAnswers, activeQuestion);
  submit.textContent =
    activeQuestionIndex < request.questions.length - 1
      ? lensText('lens.request.continue', 'Continue')
      : busy
        ? lensText('lens.request.sending', 'Sending…')
        : lensText('lens.request.sendAnswer', 'Send answer');
  formControls.appendChild(submit);

  return formControls;
}

function createApprovalButtonRow(
  busy: boolean,
  deps: AgentHistoryRequestDomDeps,
  lensText: LensText,
  request: LensPulseRequestSummary,
  sessionId: string,
): HTMLElement {
  const buttonRow = document.createElement('div');
  buttonRow.className = 'agent-request-button-row';

  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'agent-view-btn agent-view-btn-primary';
  approve.disabled = busy;
  approve.textContent = busy
    ? lensText('lens.request.working', 'Working…')
    : lensText('lens.request.approveOnce', 'Approve once');
  approve.addEventListener('click', () => {
    void runRequestAction(deps, lensText, sessionId, request.requestId, () =>
      approveLensRequest(sessionId, request.requestId),
    );
  });

  const decline = document.createElement('button');
  decline.type = 'button';
  decline.className = 'agent-view-btn';
  decline.disabled = busy;
  decline.textContent = lensText('lens.request.decline', 'Decline');
  decline.addEventListener('click', () => {
    void runRequestAction(deps, lensText, sessionId, request.requestId, () =>
      declineLensRequest(sessionId, request.requestId),
    );
  });

  buttonRow.append(approve, decline);
  return buttonRow;
}

function createRequestPanelHeader(
  request: LensPulseRequestSummary,
  lensText: LensText,
  lensFormat: LensFormat,
): HTMLElement {
  const header = document.createElement('div');
  header.className = 'agent-request-panel-header';
  const topRow = document.createElement('div');
  topRow.className = 'agent-request-panel-topline';

  const eyebrow = document.createElement('span');
  eyebrow.className = 'agent-request-eyebrow';
  eyebrow.textContent =
    request.kind === 'tool_user_input'
      ? lensText('lens.request.pendingUserInput', 'Pending user input')
      : lensText('lens.request.pendingApproval', 'Pending approval');
  topRow.appendChild(eyebrow);

  const summary = document.createElement('span');
  summary.className = 'agent-request-summary';
  summary.textContent = summarizeRequestInterruption(request, lensText, lensFormat);
  topRow.appendChild(summary);
  header.appendChild(topRow);

  if (request.detail?.trim()) {
    const detail = document.createElement('p');
    detail.className = 'agent-request-detail';
    detail.textContent = request.detail;
    header.appendChild(detail);
  }

  return header;
}

function summarizeRequestInterruption(
  request: LensPulseRequestSummary,
  lensText: LensText,
  lensFormat: LensFormat,
): string {
  if (request.kind === 'tool_user_input') {
    const activeQuestion = request.questions[0];
    if (request.questions.length === 1 && activeQuestion?.options.length) {
      return activeQuestion.multiSelect
        ? lensFormat(
            'lens.request.selectManyToContinue',
            'Select one or more of {count} options to continue.',
            { count: activeQuestion.options.length },
          )
        : lensFormat(
            'lens.request.selectOneToContinue',
            'Select 1 of {count} options to continue.',
            { count: activeQuestion.options.length },
          );
    }

    return request.questions.length === 1
      ? lensText('lens.request.needsOneAnswer', 'The agent needs one answer to continue.')
      : lensFormat(
          'lens.request.needsManyAnswers',
          'The agent needs {count} answers to continue.',
          { count: request.questions.length },
        );
  }

  const label = request.kindLabel.trim() || lensText('lens.request.approvalLabel', 'Approval');
  return lensFormat(
    'lens.request.requiredBeforeContinue',
    '{label} required before the turn can continue.',
    { label },
  );
}

function createQuestionField(args: {
  deps: AgentHistoryRequestDomDeps;
  draftAnswers: Record<string, string[]>;
  index: number;
  lensText: LensText;
  question: LensPulseRequestSummary['questions'][number];
  request: LensPulseRequestSummary;
  sessionId: string;
  totalQuestions: number;
}): HTMLElement {
  const { deps, draftAnswers, index, lensText, question, request, sessionId, totalQuestions } =
    args;
  const wrapper = document.createElement('section');
  wrapper.className = 'agent-request-field';

  if (question.header && question.header.trim()) {
    const header = document.createElement('div');
    header.className = 'agent-request-field-header';
    const fieldHeader = document.createElement('span');
    fieldHeader.className = 'agent-request-field-label';
    fieldHeader.textContent = question.header;
    header.appendChild(fieldHeader);
    wrapper.appendChild(header);
  }

  const title = document.createElement('p');
  title.className = 'agent-request-question';
  title.textContent = question.question;
  wrapper.appendChild(title);

  const draftValue = draftAnswers[question.id] ?? [];
  if (question.options.length > 0 && question.multiSelect) {
    wrapper.appendChild(
      createQuestionChoiceList({
        autoAdvance: false,
        deps,
        inputType: 'checkbox',
        question,
        request,
        selectedAnswers: draftValue,
        sessionId,
      }),
    );
    return wrapper;
  }

  if (question.options.length > 0) {
    wrapper.appendChild(
      createQuestionChoiceList({
        autoAdvance: index < totalQuestions - 1,
        deps,
        inputType: 'radio',
        question,
        request,
        selectedAnswers: draftValue,
        sessionId,
      }),
    );
    return wrapper;
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.name = question.id;
  input.className = 'agent-request-input';
  input.placeholder = lensText('lens.request.typeAnswer', 'Type answer');
  input.value = draftValue[0] || '';
  input.addEventListener('input', () => {
    updateRequestDraftAnswers(deps, sessionId, request.requestId, question.id, [
      input.value.trim(),
    ]);
  });
  wrapper.appendChild(input);
  return wrapper;
}

function createQuestionChoiceList(args: {
  autoAdvance: boolean;
  deps: AgentHistoryRequestDomDeps;
  inputType: 'checkbox' | 'radio';
  question: LensPulseRequestSummary['questions'][number];
  request: LensPulseRequestSummary;
  selectedAnswers: readonly string[];
  sessionId: string;
}): HTMLElement {
  const { autoAdvance, deps, inputType, question, request, selectedAnswers, sessionId } = args;
  const options = document.createElement('div');
  options.className = 'agent-request-choice-list';

  for (const [index, option] of question.options.entries()) {
    const optionLabel = document.createElement('label');
    optionLabel.className = 'agent-request-choice';
    const input = document.createElement('input');
    input.type = inputType;
    input.name = question.id;
    input.value = option.label;
    input.className = 'agent-request-choice-input';
    input.checked = selectedAnswers.includes(option.label);
    input.addEventListener('change', () => {
      if (inputType === 'radio') {
        updateRequestDraftAnswers(
          deps,
          sessionId,
          request.requestId,
          question.id,
          [option.label],
          false,
        );
        if (autoAdvance) {
          const currentIndex =
            deps.getState(sessionId)?.requestQuestionIndexById[request.requestId] ?? 0;
          setActiveRequestQuestionIndex(deps, sessionId, request.requestId, currentIndex + 1);
          return;
        }

        deps.renderCurrentAgentView(sessionId);
        return;
      }

      const nextAnswers = Array.from(
        options.querySelectorAll<HTMLInputElement>(
          `input[name="${CSS.escape(question.id)}"]:checked`,
        ),
      ).map((candidate) => candidate.value);
      updateRequestDraftAnswers(deps, sessionId, request.requestId, question.id, nextAnswers);
    });
    optionLabel.appendChild(input);

    if (index < 9) {
      const shortcut = document.createElement('span');
      shortcut.className = 'agent-request-choice-shortcut';
      shortcut.textContent = String(index + 1);
      optionLabel.appendChild(shortcut);
    }

    const copy = document.createElement('span');
    copy.className = 'agent-request-choice-copy';
    const title = document.createElement('span');
    title.className = 'agent-request-choice-title';
    title.textContent = option.label;
    copy.appendChild(title);
    if (option.description && option.description !== option.label) {
      const description = document.createElement('span');
      description.className = 'agent-request-choice-description';
      description.textContent = option.description;
      copy.appendChild(description);
    }

    optionLabel.appendChild(copy);
    options.appendChild(optionLabel);
  }

  return options;
}

function collectQuestionAnswers(
  state: SessionLensViewState,
  request: LensPulseRequestSummary,
): Array<{ questionId: string; answers: string[] }> {
  const draftAnswers = ensureRequestDraftAnswers(state, request);
  return request.questions.map((question) => ({
    questionId: question.id,
    answers: (draftAnswers[question.id] ?? []).filter(Boolean),
  }));
}

function resolveActiveRequestQuestionIndex(
  state: SessionLensViewState,
  request: LensPulseRequestSummary,
): number {
  const maxIndex = Math.max(0, request.questions.length - 1);
  const currentIndex = state.requestQuestionIndexById[request.requestId] ?? 0;
  return Math.max(0, Math.min(currentIndex, maxIndex));
}

function setActiveRequestQuestionIndex(
  deps: AgentHistoryRequestDomDeps,
  sessionId: string,
  requestId: string,
  nextIndex: number,
): void {
  const state = deps.getState(sessionId);
  if (!state) {
    return;
  }

  state.requestQuestionIndexById[requestId] = Math.max(0, nextIndex);
  deps.renderCurrentAgentView(sessionId);
}

function ensureRequestDraftAnswers(
  state: SessionLensViewState,
  request: LensPulseRequestSummary,
): Record<string, string[]> {
  const existing = state.requestDraftAnswersById[request.requestId];
  if (existing) {
    for (const question of request.questions) {
      existing[question.id] ??= [];
    }
    return existing;
  }

  const nextDraft: Record<string, string[]> = {};
  for (const question of request.questions) {
    nextDraft[question.id] = [];
  }

  state.requestDraftAnswersById[request.requestId] = nextDraft;
  return nextDraft;
}

function updateRequestDraftAnswers(
  deps: AgentHistoryRequestDomDeps,
  sessionId: string,
  requestId: string,
  questionId: string,
  answers: string[],
  rerender = true,
): void {
  const state = deps.getState(sessionId);
  if (!state) {
    return;
  }

  const requestDrafts = state.requestDraftAnswersById[requestId] ?? {};
  requestDrafts[questionId] = answers.filter((answer) => answer.trim().length > 0);
  state.requestDraftAnswersById[requestId] = requestDrafts;
  if (rerender) {
    deps.renderCurrentAgentView(sessionId);
  }
}

function hasDraftAnswerForQuestion(
  draftAnswers: Record<string, string[]>,
  question: LensPulseRequestSummary['questions'][number],
): boolean {
  return (draftAnswers[question.id] ?? []).some((answer) => answer.trim().length > 0);
}

async function handleResolveUserInput(
  deps: AgentHistoryRequestDomDeps,
  lensText: LensText,
  sessionId: string,
  requestId: string,
  answers: Array<{ questionId: string; answers: string[] }>,
): Promise<void> {
  await runRequestAction(deps, lensText, sessionId, requestId, () =>
    resolveLensUserInput(sessionId, requestId, {
      answers: answers.filter((answer) => answer.answers.length > 0),
    }),
  );
}

async function runRequestAction(
  deps: AgentHistoryRequestDomDeps,
  lensText: LensText,
  sessionId: string,
  requestId: string,
  action: () => Promise<unknown>,
): Promise<void> {
  const state = deps.getState(sessionId);
  if (!state || state.requestBusyIds.has(requestId)) {
    return;
  }

  state.requestBusyIds.add(requestId);
  deps.renderCurrentAgentView(sessionId);
  try {
    await action();
    await deps.refreshLensSnapshot(sessionId);
  } catch (error) {
    deps.logWarn(
      () => `Failed to resolve Lens request ${requestId} for ${sessionId}: ${String(error)}`,
    );
    showDevErrorDialog({
      title: lensText('lens.error.requestTitle', 'Lens request failed'),
      context: `Lens request action failed for session ${sessionId}, request ${requestId}`,
      error,
    });
  } finally {
    state.requestBusyIds.delete(requestId);
    deps.renderCurrentAgentView(sessionId);
  }
}
