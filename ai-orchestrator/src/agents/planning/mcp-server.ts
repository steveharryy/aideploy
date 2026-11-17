/**
 * Local MCP tool server for one planning session (stdio). Started by the Claude Code CLI from a
 * per-run config; serves the planner tools (jira_read, list_repos, search_code, read_file, submit_plan) and writes the outcome to the session's result
 * file after every call. Usage: node mcp-server.js <session.json>
 *
 * Jira credentials reach this process through its environment (from the private per-run MCP
 * config), never through the model.
 */
import fs from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { JiraClient } from '../../integrations/jira/jira-client.js';
import { PlannerTools, TOOL_DEFINITIONS, type PlannerSession } from './tools.js';

async function main() {
  const sessionFile = process.argv[2];
  if (!sessionFile) throw new Error('usage: mcp-server <session.json>');
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8')) as PlannerSession;

  let jiraGetTask: ((key: string) => Promise<import('../../models/types.js').TaskInput>) | undefined;
  if (process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN) {
    const jira = new JiraClient({
      productField: process.env.JIRA_PRODUCT_FIELD || undefined,
      storyPointsField: process.env.JIRA_STORY_POINTS_FIELD || undefined
    });
    jiraGetTask = (key) => jira.getTask(key);
  }
  const tools = new PlannerTools(session, jiraGetTask);
  const save = () => fs.writeFileSync(session.resultFile, JSON.stringify(tools.outcome, null, 2), { mode: 0o600 });
  save();

  const server = new Server({ name: 'planner', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as unknown as { type: 'object' } }))
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await tools.call(req.params.name, (req.params.arguments || {}) as Record<string, unknown>);
    save();
    return { content: [{ type: 'text' as const, text: result.text }], ...(result.isError ? { isError: true } : {}) };
  });
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`planner mcp-server: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
