import type { Session } from '../../api/types';

export function isAdHocSession(session: Pick<Session, 'isAdHoc' | 'spaceId'>): boolean {
  if (typeof session.isAdHoc === 'boolean') {
    return session.isAdHoc;
  }

  return !session.spaceId?.trim();
}
