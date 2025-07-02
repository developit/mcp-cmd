#!/usr/bin/env node
import { fork } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { inspect } from 'node:util';
import { createRequire } from 'node:module';
import sade from 'sade';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const SERVERS_FILE = join(process.cwd(), '.mcp-cmd.json');

function loadServers() {
  if (!existsSync(SERVERS_FILE)) return {};
  return JSON.parse(readFileSync(SERVERS_FILE, 'utf8'));
}

function saveServers(servers) {
  writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2));
}

function getSocketPath(servername) {
  return join(tmpdir(), `mcp-cmd-${servername}.sock`);
}

// Utility functions
function parseEnvVars(envArray) {
  return [].concat(envArray || []).reduce((acc, e) => {
    const [key, ...value] = e.split('=');
    acc[key] = value.join('=');
    return acc;
  }, {});
}

function outputJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

function cleanupServer(servers, servername) {
  delete servers[servername];
  saveServers(servers);
}

// Server operation pattern
async function withServer(servername, operation) {
  const servers = loadServers();

  if (!servers[servername]) {
    console.error(`Server "${servername}" is not running`);
    process.exit(1);
  }

  const server = servers[servername];

  try {
    process.kill(server.pid, 0); // Check if process exists
    return await operation(server);
  } catch (error) {
    if (error.code === 'ESRCH') {
      console.error(`Server "${servername}" process is no longer running`);
      cleanupServer(servers, servername);
    } else {
      console.error(`Operation failed for "${servername}":`, error.message);
    }
    process.exit(1);
  }
}

function sendRpc(socketPath, method, params = null) {
  return new Promise((resolve, reject) => {
    const client = connect(socketPath);
    const id = Math.random().toString(36).substr(2, 9);

    let responseData = '';

    client.on('data', (data) => {
      responseData += data.toString();
      try {
        const response = JSON.parse(responseData);
        if (response.id === id) {
          client.end();
          if (response.error) {
            reject(new Error(response.error.message));
          } else {
            resolve(response.result);
          }
        }
      } catch (e) {
        // Partial data, continue reading
      }
    });

    client.on('error', reject);
    client.on('end', () => {
      if (!responseData) {
        reject(new Error('Connection closed without response'));
      }
    });

    const request = {
      id,
      method,
      ...(params && { params })
    };

    client.write(JSON.stringify(request) + '\n');
  });
}

const prog = sade(pkg.name)
  .version(pkg.version)
  .describe(pkg.description);

prog
  .command('start <servername> [...url-or-command]', 'Start an mcp server')
  .option('--cwd <cwd>', 'set working directory', process.cwd())
  .option('--env KEY=VALUE', 'set environment variables')
  .action(async (servername, urlOrCommand, {cwd, env, _}) => {
    const servers = loadServers();

    if (servers[servername]) {
      console.error(`Server "${servername}" is already running`);
      return process.exit(1);
    }

    // ignore all arg parsing
    _ = process.argv.slice(process.argv.indexOf(urlOrCommand) + 1);

    let command, args, url;
    try {
      url = new URL([urlOrCommand, ..._].join(' ')).href;
    } catch (e) {
      command = urlOrCommand;
      args = _;
    }

    const config = {
      command,
      args,
      url,
      env: parseEnvVars(env),
      cwd,
    };

    const child = fork(fileURLToPath(import.meta.url), ['_internal_runner', servername, JSON.stringify(config)], {
      detached: true,
      silent: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('Server startup timeout'));
      }, 60_000);

      child.on('message', (msg) => {
        if (msg.type !== 'ready') return;
        clearTimeout(timeout);
        servers[servername] = {
          ...config,
          pid: child.pid,
          socketPath: msg.socketPath,
          started: new Date().toISOString()
        };
        saveServers(servers);
        console.log(`Started server "${servername}" with PID ${child.pid}`);
        resolve();
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    child.unref();
    process.exit(0);
  });

prog
  .command('stop <servername>', 'Stop an mcp server')
  .action(async (servername) => {
    const servers = loadServers();

    if (!servers[servername]) {
      console.error(`Server "${servername}" is not running`);
      process.exit(1);
    }

    const { pid, socketPath } = servers[servername];

    try {
      process.kill(pid, 'SIGTERM');

      // Clean up socket file if it exists
      if (socketPath && existsSync(socketPath)) {
        try {
          unlinkSync(socketPath);
        } catch (e) {
          // Ignore cleanup errors
        }
      }

      cleanupServer(servers, servername);
      console.log(`Stopped server "${servername}"`);
    } catch (error) {
      if (error.code === 'ESRCH') {
        // Process doesn't exist, just clean up
        cleanupServer(servers, servername);
        console.log(`Server "${servername}" was already stopped`);
      } else {
        console.error(`Failed to stop server "${servername}":`, error.message);
        process.exit(1);
      }
    }
  });

prog
  .command('tools <servername>', 'List tools for an mcp server')
  .action(async (servername) => {
    const result = await withServer(servername, async (server) => {
      return await sendRpc(server.socketPath, 'listTools');
    });
    outputJson(result);
  });

prog
  .command('call <servername> <toolname>', 'Call a tool on an mcp server. Pass arguments as JSON or named arguments.')
  .action(async (servername, toolname, {_, ...args}) => {
    if (_.length) {
      Object.assign(args, JSON.parse(_.join(' ')));
    }

    const result = await withServer(servername, async (server) => {
      return await sendRpc(server.socketPath, 'callTool', {
        name: toolname,
        arguments: args
      });
    });
    outputJson(result);
  });

prog
  .command('ps [servername]', 'List running servers or show details for a specific server')
  .action(async (servername) => {
    const servers = loadServers();

    if (servername) {
      // Show specific server info
      if (!servers[servername]) {
        console.error(`Server "${servername}" is not running`);
        process.exit(1);
      }

      console.log(servername);
      console.log(inspect(servers[servername], { colors: true, depth: null })
        .split('\n')
        .map(line => '  ' + line)
        .join('\n'));
    } else {
      // Show all servers
      if (Object.keys(servers).length === 0) {
        console.log('No servers running');
        return;
      }

      for (const [name, info] of Object.entries(servers)) {
        console.log(name);
        console.log(inspect(info, { colors: true, depth: null })
          .split('\n')
          .map(line => '  ' + line)
          .join('\n'));
        console.log(); // Empty line between servers
      }
    }
  });

// Internal command for background processes
prog
  .command('_internal_runner <servername>')
  .action(async (servername, {_}) => {
    const client = new Client({
      name: pkg.name,
      version: pkg.version,
    });

    const {command, args, cwd, env} = JSON.parse(_.join(' '));
    console.log(`[${servername}] Starting MCP server...`);
    console.log({command, args, cwd, env});

    const socketPath = getSocketPath(servername);

    try {
      // Connect to MCP server
      await client.connect(new StdioClientTransport({
        command,
        args,
        cwd,
        env: {...getDefaultEnvironment(), ...env},
      }));

      console.log(`[${servername}] Connected to MCP server`);
    } catch (error) {
      console.error(`[${servername}] Failed to start:`, error);
      return process.exit(1);
    }

    // Create JSON-RPC server over Unix domain socket
    const server = createServer((socket) => {
      let buffer = '';

      socket.on('data', async (data) => {
        buffer += data.toString();

        // Process complete JSON-RPC messages (newline-delimited)
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          const {id, method, params} = JSON.parse(line);
          let result, error;
          try {
            switch (method) {
              case 'listTools':
                result = await client.listTools();
                break;
              case 'callTool':
                result = await client.callTool(params);
                break;
            }
          } catch (err) {
            error = String(err);
          }
          socket.write(JSON.stringify({id, result, error}) + '\n');
        }
      });

      socket.on('error', (err) => {
        console.error(`[${servername}] Socket error:`, err);
      });
    });

    const shutdown = () => {
      console.log(`[${servername}] Shutting down...`);
      server.close();
      client.close();
      try {
        unlinkSync(socketPath);
      } catch (e) {}
      process.exit(0);
    }
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    server.listen(socketPath, () => {
      console.log(`[${servername}] JSON-RPC server listening on ${socketPath}`);
      process.send({type: 'ready', socketPath});
    });
  });


prog.parse(process.argv);
