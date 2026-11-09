#!/usr/bin/env node
import { join } from 'node:path';
import { runCli } from './lib.mjs';

runCli(process.argv.slice(2), { home: process.env.EFFORT_HOME || join(process.cwd(), '.effort') })
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
