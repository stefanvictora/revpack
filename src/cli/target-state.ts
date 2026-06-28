import chalk from 'chalk';

export type TargetStateTone = 'open' | 'merged' | 'closed' | 'locked' | 'default';

export function getTargetStateTone(state: string): TargetStateTone {
  switch (state.toLowerCase()) {
    case 'open':
    case 'opened':
      return 'open';
    case 'merged':
      return 'merged';
    case 'closed':
    case 'declined':
    case 'superseded':
      return 'closed';
    case 'locked':
      return 'locked';
    default:
      return 'default';
  }
}

export function getTargetStateColor(state: string): (text: string) => string {
  switch (getTargetStateTone(state)) {
    case 'open':
      return chalk.green;
    case 'merged':
      return chalk.magenta;
    case 'closed':
      return chalk.red;
    case 'locked':
      return chalk.yellow;
    case 'default':
      return chalk.white;
  }
}
