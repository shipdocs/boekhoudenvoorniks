import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MCP_NAME, OLD_MCP_NAME } from '../shared/brand';

export { MCP_NAME, OLD_MCP_NAME };

type Kind = 'claude-code' | 'codex';

/** Staat de oude koppeling nog in de instellingen van Claude Code (~/.claude.json) of Codex (~/.codex/config.toml)? */
export function hasOldMcp(kind: Kind, home: string, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): boolean {
  try {
    if (kind === 'claude-code') {
      const config = JSON.parse(read(join(home, '.claude.json'))) as { mcpServers?: Record<string, unknown> };
      return Boolean(config.mcpServers && OLD_MCP_NAME in config.mcpServers);
    }
    return /^\s*\[mcp_servers\.(?:"gratis-boekhouden"|gratis-boekhouden)\]/m.test(read(join(home, '.codex', 'config.toml')));
  } catch {
    return false;
  }
}

/** De opdrachten om de oude koppeling weg te halen en de nieuwe toe te voegen. */
export function mcpCommands(kind: Kind, command: string, args: string[]): { remove: string[]; add: string[] } {
  return kind === 'codex'
    ? { remove: ['mcp', 'remove', OLD_MCP_NAME], add: ['mcp', 'add', MCP_NAME, '--', command, ...args] }
    : { remove: ['mcp', 'remove', '--scope', 'user', OLD_MCP_NAME], add: ['mcp', 'add', '--scope', 'user', MCP_NAME, '--', command, ...args] };
}
