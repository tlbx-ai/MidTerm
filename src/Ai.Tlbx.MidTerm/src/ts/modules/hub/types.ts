import type { SessionInfoDto } from '../../api/types';

export interface HubMachineInfo {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  hasApiKey: boolean;
  hasPassword: boolean;
  lastFingerprint: string | null;
  pinnedFingerprint: string | null;
}

export interface HubMachineState {
  machine: HubMachineInfo;
  status: string;
  error: string | null;
  fingerprintMismatch: boolean;
  requiresTrust: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  sessions: SessionInfoDto[];
}

export interface HubStateResponse {
  machines: HubMachineState[];
}

export interface HubMachineUpsertRequest {
  name: string;
  baseUrl: string;
  enabled: boolean;
  apiKey?: string | null;
  password?: string | null;
}

export interface HubPinRequest {
  fingerprint?: string | null;
}

export interface HubUpdateRolloutRequest {
  machineIds: string[];
}

export interface HubUpdateRolloutItem {
  machineId: string;
  machineName: string;
  status: string;
  message: string;
}

export interface HubUpdateRolloutResponse {
  results: HubUpdateRolloutItem[];
}

export interface HubSessionRecord {
  compositeId: string;
  machineId: string;
  machineName: string;
  remoteSessionId: string;
  session: SessionInfoDto;
}
