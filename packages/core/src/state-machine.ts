import {CleanCodeError} from '../../shared/dist/errors.js';
import {
  isValidStateTransition,
  type State,
} from '../../shared/dist/types.js';

export class ExecutionStateMachine {
  private state: State;
  private readonly states: State[];

  constructor(initial: State = 'DISCOVERED') {
    this.state = initial;
    this.states = [initial];
  }

  get current(): State {
    return this.state;
  }

  get history(): readonly State[] {
    return [...this.states];
  }

  transitionTo(next: State): void {
    if (!isValidStateTransition(this.state, next)) {
      throw new CleanCodeError(
        'POLICY_VIOLATION',
        `Invalid state transition: ${this.state} -> ${next}`,
        {from: this.state, to: next},
      );
    }
    this.state = next;
    this.states.push(next);
  }
}
