// Destructive-command patterns. Purely informational — shown on the approval
// card so the user knows what an exec_cmd may do before clicking 执行. Does NOT
// block; the server sandbox/blacklist is the actual enforcement. Ported from
// Claude Code's destructiveCommandWarning.ts.
const DESTRUCTIVE_COMMAND_PATTERNS: { pattern: RegExp; warning: string }[] = [
  { pattern: /\bgit\s+reset\s+--hard\b/, warning: '可能丢弃未提交的更改' },
  { pattern: /\bgit\s+push\b[^;&|\n]*[ \t](--force|--force-with-lease|-f)\b/, warning: '可能覆盖远程历史' },
  { pattern: /\bgit\s+clean\b(?![^;&|\n]*(?:-[a-zA-Z]*n|--dry-run))[^;&|\n]*-[a-zA-Z]*f/, warning: '可能永久删除未跟踪文件' },
  { pattern: /\bgit\s+checkout\s+(--\s+)?\.[ \t]*($|[;&|\n])/, warning: '可能丢弃工作区所有更改' },
  { pattern: /\bgit\s+restore\s+(--\s+)?\.[ \t]*($|[;&|\n])/, warning: '可能丢弃工作区所有更改' },
  { pattern: /\bgit\s+stash[ \t]+(drop|clear)\b/, warning: '可能永久移除 stash 内容' },
  { pattern: /\bgit\s+branch\s+(-D[ \t]|--delete\s+--force|--force\s+--delete)\b/, warning: '可能强制删除分支' },
  { pattern: /\bgit\s+(commit|push|merge)\b[^;&|\n]*--no-verify\b/, warning: '可能跳过安全钩子' },
  { pattern: /\bgit\s+commit\b[^;&|\n]*--amend\b/, warning: '可能改写上一个提交' },
  { pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f|(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/, warning: '可能递归强制删除文件' },
  { pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR]/, warning: '可能递归删除文件' },
  { pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f/, warning: '可能强制删除文件' },
  { pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, warning: '可能删除或清空数据库对象' },
  { pattern: /\bDELETE\s+FROM\s+\w+[ \t]*(;|"|'|\n|$)/i, warning: '可能删除整张表的数据' },
  { pattern: /\bkubectl\s+delete\b/, warning: '可能删除 Kubernetes 资源' },
  { pattern: /\bterraform\s+destroy\b/, warning: '可能销毁 Terraform 基础设施' },
];

// Returns a short human warning if the command matches a known destructive
// pattern, or null. Matches the FIRST pattern, so order matters: most specific
// (e.g. rm -rf) before the more general (rm -r) so the strongest note wins.
export function getDestructiveCommandWarning(command: string): string | null {
  if (!command) return null;
  for (const { pattern, warning } of DESTRUCTIVE_COMMAND_PATTERNS) {
    if (pattern.test(command)) return warning;
  }
  return null;
}
