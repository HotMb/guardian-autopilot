import {appendFile, mkdir, readFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {EXECUTION_STATES, type State} from '@cleancode/shared/types';

export type AuditEvent = {
  schemaVersion: 1;
  id: string;
  action: string;
  state: State;
  occurredAt: string;
  details?: Readonly<Record<string, unknown>>;
};

export type AuditEventInput = Omit<AuditEvent, 'schemaVersion'>;

function normalizeEvent(value: AuditEventInput): AuditEvent {
  if (value === null || typeof value !== 'object') throw new Error('Audit event must be an object');
  if (typeof value.id !== 'string' || value.id.trim() === '') throw new Error('Audit event id is required');
  if (typeof value.action !== 'string' || value.action.trim() === '') throw new Error('Audit event action is required');
  if (!EXECUTION_STATES.includes(value.state)) throw new Error('Audit event state is invalid');
  if (Number.isNaN(new Date(value.occurredAt).getTime())) throw new Error('Audit event timestamp is invalid');
  if (value.details !== undefined && (value.details === null || typeof value.details !== 'object' || Array.isArray(value.details))) throw new Error('Audit event details must be an object');
  return {schemaVersion: 1, ...value};
}

export class AuditLog {
  constructor(private readonly path: string) {}

  async append(event: AuditEventInput): Promise<void> {
    const normalized = normalizeEvent(event);
    await mkdir(dirname(this.path), {recursive: true});
    await appendFile(this.path, `${JSON.stringify(normalized)}\n`, 'utf8');
  }

  async read(): Promise<AuditEvent[]> {
    let content: string;
    try { content = await readFile(this.path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return content.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => {
      let value: unknown;
      try { value = JSON.parse(line); } catch { throw new Error('Audit log contains invalid JSONL'); }
      const event = value as AuditEventInput & {schemaVersion?: unknown};
      if (event.schemaVersion !== 1) throw new Error('Audit log schema version is invalid');
      return normalizeEvent(event);
    });
  }
}
