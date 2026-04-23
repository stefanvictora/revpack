#!/usr/bin/env node

import { Command } from 'commander';
import { registerReviewCommand } from './commands/review.js';
import { registerStatusCommand } from './commands/status.js';
import { registerCheckoutCommand } from './commands/checkout.js';
import { registerResetCommand } from './commands/reset.js';
import { registerPublishCommand } from './commands/publish.js';
import { registerConfigCommand } from './commands/config.js';
import { registerInitCommand } from './commands/init.js';

const program = new Command();

program
  .name('review-assist')
  .description('CLI assistant for code review workflows')
  .version('0.1.0');

registerReviewCommand(program);
registerStatusCommand(program);
registerCheckoutCommand(program);
registerResetCommand(program);
registerPublishCommand(program);
registerConfigCommand(program);
registerInitCommand(program);

program.parse();
