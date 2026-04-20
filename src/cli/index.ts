#!/usr/bin/env node

import { Command } from 'commander';
import { registerOpenCommand } from './commands/open.js';
import { registerThreadsCommand } from './commands/threads.js';
import { registerPrepareCommand } from './commands/prepare.js';
import { registerSummarizeCommand } from './commands/summarize.js';
import { registerPublishReplyCommand } from './commands/publish-reply.js';
import { registerUpdateDescriptionCommand } from './commands/update-description.js';
import { registerConfigCommand } from './commands/config.js';
import { registerInitCommand } from './commands/init.js';

const program = new Command();

program
  .name('review-assist')
  .description('CLI assistant for code review workflows')
  .version('0.1.0');

registerOpenCommand(program);
registerThreadsCommand(program);
registerPrepareCommand(program);
registerSummarizeCommand(program);
registerPublishReplyCommand(program);
registerUpdateDescriptionCommand(program);
registerConfigCommand(program);
registerInitCommand(program);

program.parse();
