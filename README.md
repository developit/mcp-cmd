# mcp-cmd

A simple Node.js-based command line MCP Client that exposes commands for listing and calling MCP tools.

### Why?

There are other command line MCP Clients out there, but all of them spawn the referenced MCP Servers for every tool call.

**`mcp-cmd` is different:** you use its CLI to start and stop MCP servers, and the servers run **in the background**. That means successive tool calls to an MCP Server are handled by the same running instance of that server.

### Usage

First, start a server by giving it a name and the command + args, then interact with it, then stop it.

```sh
# Start an MCP server
mcp-cmd start <servername> <...url-or-commands>

# List server tools
mcp-cmd tools <servername>

# Call a tool provided by the server
mcp-cmd call <servername> <toolname> --arg1=value1 --arg2=value2

# Stop the MCP server
mcp-cmd stop <servername>
```

### Example

```sh
# start server
mcp-cmd start puppeteer npx -y @modelcontextprotocol/server-puppeteer

# list tools
mcp-cmd tools puppeteer

# navigate to a page, log the title, then take a screenshot
mcp-cmd tools puppeteer navigate --url=https://example.com
mcp-cmd tools puppeteer execute --code=document.title
mcp-cmd tools puppeteer screenshot --name=example

# stop the server
mcp-cmd stop puppeteer
```

### Implementation Details

- dead simple CLI built using [sade](https://www.npmjs.com/package/sade)
- based on the official `@modelcontextprotocol/sdk` package
- only supports starting and stopping MCP servers, listing and calling tools (no resources)
- stderr from the tool during the call is forwarded to stderr
