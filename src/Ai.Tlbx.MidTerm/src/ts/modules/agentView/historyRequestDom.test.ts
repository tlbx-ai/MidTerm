import { describe, expect, it } from 'vitest';
import { parseApprovalDetail } from './historyRequestDom';

describe('parseApprovalDetail', () => {
  it('uses the human description and keeps the command behind technical disclosure', () => {
    expect(
      parseApprovalDetail(
        'PowerShell: {"command":"Invoke-WebRequest https://example.com","description":"Check whether example.com is reachable"}',
      ),
    ).toEqual({
      summary: 'Check whether example.com is reachable',
      technicalDetail: 'Invoke-WebRequest https://example.com',
      tool: 'PowerShell',
    });
  });

  it('does not expose raw JSON as the visible summary when no description exists', () => {
    expect(parseApprovalDetail('Bash: {"command":"git status"}')).toEqual({
      summary: null,
      technicalDetail: 'git status',
      tool: 'Bash',
    });
  });

  it('preserves provider text that is not a tool JSON envelope', () => {
    expect(parseApprovalDetail('Read the current repository status')).toEqual({
      summary: 'Read the current repository status',
      technicalDetail: null,
      tool: null,
    });
  });
});
