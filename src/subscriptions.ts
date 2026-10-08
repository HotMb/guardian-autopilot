import type {EntitlementSnapshot} from './billing.js';

export type SubscriptionRecord = {
  subscriptionId: string;
  customerId?: string;
  eventId: string;
  updatedAt: number;
  snapshot: EntitlementSnapshot;
};

export type SubscriptionApplyResult = 'applied' | 'duplicate';

/**
 * Minimal persistence boundary for subscription webhooks.
 * Implementations must make apply atomic so a retried webhook cannot create
 * two state transitions for the same event id.
 */
export interface SubscriptionStore {
  apply(eventId: string, record: SubscriptionRecord): SubscriptionApplyResult;
  get(subscriptionId: string): SubscriptionRecord | undefined;
}

export class MemorySubscriptionStore implements SubscriptionStore {
  private readonly records = new Map<string, SubscriptionRecord>();
  private readonly processedEvents = new Set<string>();

  apply(eventId: string, record: SubscriptionRecord): SubscriptionApplyResult {
    if (eventId.trim() === '' || record.subscriptionId.trim() === '') throw new Error('Subscription identifiers are required');
    if (this.processedEvents.has(eventId)) return 'duplicate';
    this.processedEvents.add(eventId);
    this.records.set(record.subscriptionId, structuredClone(record));
    return 'applied';
  }

  get(subscriptionId: string): SubscriptionRecord | undefined {
    const record = this.records.get(subscriptionId);
    return record === undefined ? undefined : structuredClone(record);
  }
}
