export function setMcpServerToolTimeout(
  configToml: string,
  serverName: string,
  timeoutSeconds: number,
): string {
  const newline = configToml.includes("\r\n") ? "\r\n" : "\n";
  const lines = configToml.split(/\r?\n/);
  const timeoutLine = `tool_timeout_sec = ${timeoutSeconds}.0`;

  let foundTarget = false;
  let inTarget = false;
  let sawTimeout = false;
  const output: string[] = [];

  for (const line of lines) {
    if (isTableHeader(line)) {
      if (inTarget && !sawTimeout) {
        output.push(timeoutLine);
      }

      inTarget = isMcpServerRootTable(line, serverName);
      foundTarget ||= inTarget;
      sawTimeout = false;
      output.push(line);
      continue;
    }

    if (inTarget && /^\s*tool_timeout_sec\s*=/.test(line)) {
      output.push(timeoutLine);
      sawTimeout = true;
      continue;
    }

    output.push(line);
  }

  if (!foundTarget) {
    throw new Error(`Could not find [mcp_servers.${serverName}] in Codex config`);
  }

  if (inTarget && !sawTimeout) {
    output.push(timeoutLine);
  }

  return output.join(newline);
}

function isTableHeader(line: string): boolean {
  return /^\s*\[[^\]]+\]\s*$/.test(line);
}

function isMcpServerRootTable(line: string, serverName: string): boolean {
  const trimmed = line.trim();
  return trimmed === `[mcp_servers.${serverName}]` || trimmed === `[mcp_servers."${serverName}"]`;
}
