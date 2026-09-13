export interface PollingState {
  key: string;
  startedAt: Date;
  lastCompletedAt: Date | null;
  leaseOwner: string | null;
  leaseUntil: Date | null;
}

export interface PollingStateRepository {
  initialize(key: string, startedAt: Date): Promise<PollingState>;
  acquire(key: string, owner: string, now: Date, until: Date): Promise<boolean>;
  renew(key: string, owner: string, now: Date, until: Date): Promise<boolean>;
  complete(key: string, owner: string, now: Date, through: Date): Promise<boolean>;
  release(key: string, owner: string): Promise<void>;
}
