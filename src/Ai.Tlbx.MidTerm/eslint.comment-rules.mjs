function getDirectiveText(sourceCode, comment) {
  return sourceCode.getText(comment).replace(/^\/[/*]+\s?/, '').replace(/\s*\*\/$/, '').trim();
}

function isDisableDirective(text) {
  return /^eslint-disable(?:\s|$)/u.test(text);
}

function isScopedDisableDirective(text) {
  return /^eslint-disable-(?:next-line|line)(?:\s|$)/u.test(text);
}

function isEnableDirective(text) {
  return /^eslint-enable(?:\s|$)/u.test(text);
}

function getDirectiveBody(text) {
  return text.split(/--/u, 1)[0]?.trim() ?? '';
}

function hasDescription(text) {
  const [, description = ''] = text.split(/--/u, 2);
  return description.trim().length > 0;
}

function hasRuleList(text) {
  const directiveBody = getDirectiveBody(text);
  return /^eslint-disable\s+\S+/u.test(directiveBody);
}

function createCommentDirectiveRule(visitComment) {
  return {
    meta: {
      type: 'problem',
      schema: [],
    },
    create(context) {
      const sourceCode = context.sourceCode ?? context.getSourceCode();
      return {
        Program() {
          for (const comment of sourceCode.getAllComments()) {
            visitComment({ comment, context, sourceCode });
          }
        },
      };
    },
  };
}

const requireDisableDescription = createCommentDirectiveRule(({ comment, context, sourceCode }) => {
  const text = getDirectiveText(sourceCode, comment);
  if (!isDisableDirective(text) || hasDescription(text)) {
    return;
  }

  context.report({
    loc: comment.loc,
    message: 'eslint-disable directives must include a justification after `--`.',
  });
});

const noUnlimitedDisable = createCommentDirectiveRule(({ comment, context, sourceCode }) => {
  const text = getDirectiveText(sourceCode, comment);
  if (!isDisableDirective(text) || isScopedDisableDirective(text) || hasRuleList(text)) {
    return;
  }

  context.report({
    loc: comment.loc,
    message: 'eslint-disable must name at least one rule; unlimited disables are not allowed.',
  });
});

const disableEnablePair = {
  meta: {
    type: 'problem',
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    return {
      Program() {
        const comments = sourceCode.getAllComments();
        const enableDirectiveLocations = comments
          .filter((comment) => isEnableDirective(getDirectiveText(sourceCode, comment)))
          .map((comment) => comment.range[0]);

        for (const comment of comments) {
          const text = getDirectiveText(sourceCode, comment);
          if (!isDisableDirective(text) || isScopedDisableDirective(text)) {
            continue;
          }

          const hasLaterEnable = enableDirectiveLocations.some((location) => location > comment.range[0]);
          if (hasLaterEnable) {
            continue;
          }

          context.report({
            loc: comment.loc,
            message: 'eslint-disable blocks must be followed by a matching eslint-enable directive.',
          });
        }
      },
    };
  },
};

export default {
  rules: {
    'require-disable-description': requireDisableDescription,
    'no-unlimited-disable': noUnlimitedDisable,
    'disable-enable-pair': disableEnablePair,
  },
};
