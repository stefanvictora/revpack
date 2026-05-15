#!/usr/bin/env node

import { Command } from 'commander';
import { createRequire } from 'node:module';
import { registerPrepareCommand } from './commands/prepare.js';
import { registerStatusCommand } from './commands/status.js';
import { registerCheckoutCommand } from './commands/checkout.js';
import { registerCleanCommand } from './commands/clean.js';
import { registerPublishCommand } from './commands/publish.js';
import { registerConfigCommand } from './commands/config.js';
import { registerSetupCommand } from './commands/setup.js';

const program = new Command();
const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

program
  .name('revpack')
  .description('Prepare AI-ready PR/MR review bundles and publish review feedback.')
  .version(version);

registerPrepareCommand(program);
registerStatusCommand(program);
registerCheckoutCommand(program);
registerCleanCommand(program);
registerPublishCommand(program);
registerConfigCommand(program);
registerSetupCommand(program);

program.parse();
