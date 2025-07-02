import { createRequire } from 'node:module';
import sade from 'sade';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const prog = sade(pkg.name)
  .version(pkg.version)
  .describe(pkg.description);

prog
  .command('start <servername> [...url-or-command]', 'Start an mcp server')
  .option('--cwd <cwd>', 'set working directory', process.cwd())
  .option('--env KEY=VALUE', 'set environment variables')
  .action(async (servername, urlOrCommand, {cwd, env, _: args}) => {
    env = [].concat(env || []).reduce((env, e) => {
      const parts = e.split('=');
      env[parts[0]] = parts.slice(1).join('=');
      return env;
    }, {});

    const client = new Client({
      name: pkg.name,
      version: pkg.version,
    });

    let url;
    try {
      url = new URL([urlOrCommand, ...args].join(' '));
    } catch (e) {}

    if (url) {
      await client.connect(new SSEClientTransport(url));
    } else {
      await client.connect(new StdioClientTransport({
        command: urlOrCommand,
        args,
        cwd,
        env: {
          ...getDefaultEnvironment(),
          ...env,
        },
      }), {});
    }
  });

prog.parse(process.argv);
