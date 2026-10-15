#!/usr/bin/env node
import('../dist/cli.js').then((m) => m.main(process.argv.slice(2)));
