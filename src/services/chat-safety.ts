import { HttpError } from "../middleware/error.js";

interface SafetyRule {
  pattern: RegExp;
  reason: string;
}

/**
 * High-confidence "weak command" patterns. These are unambiguous enough that
 * blocking them does not meaningfully hurt the agent's business Q&A use cases
 * (financial-data lookups, wiki queries, table recommendations).
 *
 * The filter is intentionally conservative: when in doubt, block + audit.
 */
const DANGEROUS_PATTERNS: SafetyRule[] = [
  // System identity / sensitive file reconnaissance
  { pattern: /\bwhoami\b/i, reason: "system identity reconnaissance command" },
  { pattern: /\buname\s+-[ar]/i, reason: "system information command" },
  { pattern: /\/etc\/passwd/, reason: "sensitive file /etc/passwd" },
  { pattern: /\/etc\/shadow/, reason: "sensitive file /etc/shadow" },
  { pattern: /\/etc\/sudoers/, reason: "sensitive file /etc/sudoers" },
  { pattern: /\/root\/\.ssh\/|\.ssh\/authorized_keys|\bid_rsa\b/i, reason: "SSH private key material" },
  { pattern: /\bgetent\s+passwd\b/i, reason: "user account enumeration" },

  // Destructive / system state changes
  { pattern: /\brm\s+-(rf|fr)\b/i, reason: "recursive force delete (rm -rf)" },
  { pattern: /\bmkfs\b/i, reason: "filesystem formatting" },
  { pattern: /\bdd\s+if=\/dev\/(zero|urandom)/i, reason: "raw device overwrite (dd)" },
  { pattern: /\bchmod\s+(-R\s+)?777\s+\//i, reason: "world-writable root (chmod 777 /)" },
  { pattern: /\b(shutdown|poweroff|halt|reboot|init\s+0)\b/i, reason: "system shutdown/reboot" },
  { pattern: /\bkill\s+-9\b/i, reason: "force kill" },
  { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\};?\s*:/, reason: "fork bomb" },

  // Remote access / backdoors
  { pattern: /\bnc\s+-[el]/i, reason: "netcat listener/backdoor" },
  { pattern: /\b(netcat|ncat)\s+-[el]/i, reason: "netcat listener/backdoor" },
  { pattern: /reverse\s*shell|反弹\s*(shell|shell)|反弹shell/i, reason: "reverse shell" },
  { pattern: /bind\s*shell/i, reason: "bind shell" },

  // Attack tooling / credential dumping
  { pattern: /\bmimikatz\b/i, reason: "credential dumping tool" },
  { pattern: /\bmsfvenom\b|\bmetasploit\b/i, reason: "exploit framework" },
  { pattern: /\bhydra\b/i, reason: "password brute-force tool" },
  { pattern: /\bsqlmap\b/i, reason: "SQL injection tool" },
  { pattern: /\bnmap\s+-s[STP]/i, reason: "network port scanning" },
  { pattern: /\bmasscan\s+-p/i, reason: "network mass scanning" },

  // Arbitrary command execution via shells / interpreters
  { pattern: /\bcmd(\.exe)?\s+\/c\b/i, reason: "cmd.exe /c command execution" },
  { pattern: /\b(bash|sh|zsh)\s+-c\b/i, reason: "shell -c command execution" },
  { pattern: /\bpython\s+-c\b/i, reason: "python -c command execution" },
  { pattern: /\bnode\s+-e\b/i, reason: "node -e command execution" },
  { pattern: /\bperl\s+-e\b/i, reason: "perl -e command execution" },
  { pattern: /\bruby\s+-e\b/i, reason: "ruby -e command execution" },
  { pattern: /\bphp\s+-r\b/i, reason: "php -r command execution" },
  { pattern: /\b(powershell|pwsh)(\.exe)?\s+.*(-enc\b|-encodedcommand\b)/i, reason: "encoded PowerShell command" },
  { pattern: /\binvoke-expression\b|\biex\s*\(/i, reason: "PowerShell Invoke-Expression" },
  { pattern: /\bbase64\s+(-d|--decode)\b/i, reason: "base64 decode chain" },

  // Download-and-execute
  { pattern: /(curl|wget)\s+\S+\s*\|\s*(ba)?sh\b/i, reason: "download-and-execute pipe" },
  { pattern: /(iwr|invoke-webrequest)[^\n]*\biex\b/i, reason: "download-and-execute (PowerShell)" },

  // Chinese-language attack intent
  { pattern: /爆破|撞库|脱库|提权|留后门|种马|勒索|拿\s*(shell|服务器|主机)/i, reason: "attack intent keyword" },
];

export type MessageSafetyResult = { safe: true } | { safe: false; reason: string };

export function checkMessageSafety(message: string): MessageSafetyResult {
  if (typeof message !== "string" || message.length === 0) {
    return { safe: true };
  }
  for (const rule of DANGEROUS_PATTERNS) {
    if (rule.pattern.test(message)) {
      return { safe: false, reason: rule.reason };
    }
  }
  return { safe: true };
}

/** Throws a 400 HttpError when the message looks like a weak-command prompt. */
export function assertMessageSafe(message: string): void {
  const result = checkMessageSafety(message);
  if (!result.safe) {
    throw new HttpError(400, `Message blocked by security policy (${result.reason})`, "UNSAFE_MESSAGE");
  }
}
