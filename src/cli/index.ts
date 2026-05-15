#!/usr/bin/env node

import { Command } from 'commander';
import { registerPrepareCommand } from './commands/prepare.js';
import { registerStatusCommand } from './commands/status.js';
import { registerCheckoutCommand } from './commands/checkout.js';
import { registerCleanCommand } from './commands/clean.js';
import { registerPublishCommand } from './commands/publish.js';
import { registerConfigCommand } from './commands/config.js';
import { registerSetupCommand } from './commands/setup.js';

const program = new Command();

program
  .name('revpack')
  .description('CLI for preparing AI-ready PR/MR review bundles and publishing review feedback.')
  .version('0.2.0');

registerPrepareCommand(program);
registerStatusCommand(program);
registerCheckoutCommand(program);
registerCleanCommand(program);
registerPublishCommand(program);
registerConfigCommand(program);
registerSetupCommand(program);

program.parse();
