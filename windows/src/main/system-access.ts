import { homedir } from "node:os";

/**
 * How dangerous a system-access request is.
 *
 * - `tier1`  allowed once the user has switched system access on, and still
 *            confirmed per action. Read-only or plainly user-scoped work.
 * - `tier2`  needs the separate arbitrary-commands switch, and its own louder
 *            confirmation text. Anything that changes software or the system.
 * - `blocked` never runs, whatever is switched on. Ustaad says why instead.
 */
export type SystemAccessTier = "tier1" | "tier2" | "blocked";

export interface SystemAccessClassification {
  tier: SystemAccessTier;
  /** Plain-language reason, shown on the confirmation card and in the audit log. */
  reason: string;
}

/** Folders a Tier 1 file operation may touch, relative to the user's home. */
export const userScopedFolderNames = [
  "Documents",
  "Downloads",
  "Desktop",
  "Pictures",
  "Videos",
  "Music",
] as const;

/**
 * Paths Ustaad refuses to touch at all, whatever tier is switched on: credential
 * stores, security configuration and the places browsers keep saved passwords.
 */
const blockedPathFragments = [
  "\\windows\\system32\\config",   // SAM, SECURITY, SYSTEM hives
  "\\windows\\system32\\catroot",
  "\\appdata\\local\\microsoft\\credentials",
  "\\appdata\\roaming\\microsoft\\credentials",
  "\\appdata\\local\\google\\chrome\\user data\\default\\login data",
  "\\appdata\\local\\microsoft\\edge\\user data\\default\\login data",
  "\\appdata\\roaming\\mozilla\\firefox\\profiles",
  "\\appdata\\local\\microsoft\\vault",
  "\\.ssh",
  "\\.aws",
  "\\.azure",
  "\\.gnupg",
];

/** Commands that are read-only enough to be Tier 1 even as raw PowerShell. */
const tier1CommandNames = [
  "get-date",
  "get-process",
  "get-service",
  "get-childitem",
  "get-item",
  "get-itemproperty",
  "get-content",
  "get-volume",
  "get-computerinfo",
  "get-ciminstance",
  "get-netipconfiguration",
  "get-netadapter",
  "get-printer",
  "get-hotfix",
  "get-eventlog",
  "get-location",
  "get-command",
  "get-module",
  "get-scheduledtask",
  "get-localuser",
  "get-disk",
  "get-partition",
  "get-timezone",
  "get-culture",
  "measure-object",
  "select-object",
  "where-object",
  "sort-object",
  "format-table",
  "format-list",
  "test-path",
  "test-connection",
  "resolve-dnsname",
  "ipconfig",
  "ping",
  "nslookup",
  "tracert",
  "whoami",
  "hostname",
  "systeminfo",
  "tasklist",
  "where",
  "ver",
  "dir",
  "echo",
  "type",
  "findstr",
  "netstat",
  "driverquery",
  "getmac",
  "chkdsk",
  "sfc",              // only ever report-only without /scannow-adjacent flags; see below
];

/**
 * Shapes that mean "this is not a diagnostic any more". Each one is a reason a
 * careful person would stop and ask, so Ustaad stops and asks too.
 */
const tier2Patterns: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(start-process|start|invoke-item)\b/iu, reason: "starts a program" },
  { pattern: /\b(stop-process|kill|taskkill)\b/iu, reason: "closes running programs" },
  { pattern: /\b(remove-item|del|rmdir|erase)\b/iu, reason: "deletes files" },
  { pattern: /\b(copy-item|move-item|move|copy|xcopy|robocopy)\b/iu, reason: "moves or copies files" },
  { pattern: /\b(new-item|mkdir|md)\b/iu, reason: "creates files or folders" },
  { pattern: /\b(set-itemproperty|set-item|new-itemproperty|reg\s+add)\b/iu, reason: "changes settings" },
  { pattern: /\b(install-|uninstall-|winget|choco|msiexec)\b/iu, reason: "installs or removes software" },
  { pattern: /\b(restart-computer|stop-computer|shutdown)\b/iu, reason: "restarts or shuts down the pc" },
  { pattern: /\b(set-service|start-service|restart-service|sc\s+(config|start|stop)|net\s+(start|stop))\b/iu, reason: "changes a windows service" },
  { pattern: /\b(schtasks|register-scheduledtask)\b/iu, reason: "sets up something that runs on its own later" },
  { pattern: /\b(set-executionpolicy)\b/iu, reason: "changes how scripts are allowed to run" },
  { pattern: /\b(enable-psremoting|winrm)\b/iu, reason: "opens remote access to this pc" },
  { pattern: /\b(invoke-webrequest|invoke-restmethod|curl|wget|bitsadmin|downloadstring|downloadfile)\b/iu, reason: "reaches out to the network" },
  { pattern: /\b(stop-service|disable-|set-mppreference|netsh\s+advfirewall)\b/iu, reason: "touches security software or the firewall" },
  { pattern: /\b(new-localuser|net\s+user|add-localgroupmember|remove-localuser)\b/iu, reason: "changes user accounts" },
  { pattern: /\b(icacls|takeown|attrib)\b/iu, reason: "changes file permissions" },
  { pattern: /\b(reg\s+delete|remove-itemproperty)\b/iu, reason: "removes settings" },
  { pattern: /\b(set-mppreference|defender|windefend)\b/iu, reason: "touches windows security" },
];

/** Requests Ustaad refuses outright, whatever the user has switched on. */
const blockedPatterns: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(disable-|stop-service\s+windefend|stop-service\s+sense)/iu, reason: "turning windows security off is not something Ustaad will do" },
  { pattern: /\bset-mppreference\b[^|;]*\bdisable\w*/iu, reason: "turning windows security off is not something Ustaad will do" },
  { pattern: /\b(netsh\s+advfirewall\s+set\s+\w+\s+(state\s+)?off|netsh\s+advfirewall\s+set\s+firewallpolicy)/iu, reason: "Ustaad will not switch the windows firewall off" },
  { pattern: /\b(net\s+user\s+\S+\s+\/add|net\s+localgroup\s+administrators|add-localgroupmember\s+-group\s+administrators)/iu, reason: "Ustaad will not grant administrator rights" },
  { pattern: /\b(runas|verb\s+runas|-verb\s+runas)/iu, reason: "Ustaad never runs anything elevated on its own" },
  { pattern: /\b(format|diskpart|cleanmgr\s+\/d|chkdsk\s+\w:\s+\/f)\b/iu, reason: "that could destroy the disk" },
  { pattern: /\b(shadowcopy|wbadmin|cipher\s+\/w|vssadmin\s+delete)\b/iu, reason: "that could destroy backups" },
  { pattern: /\b(sam|security)\s+(hive|file)|reg\s+(save|export)\b[^|;]*(sam|security)/iu, reason: "that is a windows credential store" },
  { pattern: /\b(vaultcmd|credentialmanager|credential\s+manager|dpapi|sekurlsa|mimikatz)\b/iu, reason: "that is a credential store" },
  { pattern: /\b(login\s+data|key3\.db|key4\.db|logins\.json|cookies\.sqlite|signons\.sqlite)\b/iu, reason: "that is where browsers keep saved passwords" },
  { pattern: /\biwr\s|invoke-expression|\biex\b|\|\s*(iex|invoke-expression)/iu, reason: "Ustaad will not run code it cannot read first" },
  { pattern: /\b(downloadstring|downloadfile|invoke-webrequest[^|;]*\|\s*(iex|invoke-expression))/iu, reason: "downloading something and running it blindly is not something Ustaad will do" },
  // `\b` cannot sit before a dash, so the switch is matched on the space before it.
  { pattern: /(^|\s)-e(nc|ncodedcommand)?\b|\bfrombase64string\b/iu, reason: "Ustaad will not run an encoded command" },
  { pattern: /\b(bcdedit|bootrec|bootsect|fdisk)\b/iu, reason: "that changes how the pc starts" },
  { pattern: /(rm\s+-rf\s+\/|del\s+\/f\s+\/s\s+\/q\s+c:\\|remove-item[^|;]*-recurse[^|;]*-force\s+c:\\)/iu, reason: "that would delete the system drive" },
];

/**
 * Splits a Windows path into comparable parts.
 *
 * Ustaad runs on Windows but is tested everywhere, so it does its own path
 * normalisation instead of leaning on Node's platform-dependent helpers: both
 * separators collapse to one, `.` and `..` resolve, and case stops mattering.
 */
export function splitWindowsPath(rawPath: string): string[] {
  const parts: string[] = [];

  for (const rawPart of rawPath.replace(/\//gu, "\\").split("\\")) {
    const part = rawPart.trim();
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    // A drive or UNC root is a part like any other, but never popped away.
    parts.push(parts.length === 0 ? part.toLowerCase() : part.toLowerCase());
  }

  return parts;
}

/** True when every part of `basePath` starts `targetPath`, in order. */
function isSamePathOrInside(targetPath: string[], basePath: string[]): boolean {
  if (basePath.length > targetPath.length) {
    return false;
  }
  return basePath.every((basePart, partIndex) => targetPath[partIndex] === basePart);
}

/** True when a path is inside one of the user's own folders. */
export function isPathInsideUserFolders(rawPath: string, homeDirectory = homedir()): boolean {
  const targetParts = splitWindowsPath(rawPath);
  const homeParts = splitWindowsPath(homeDirectory);

  return userScopedFolderNames.some((folderName) => (
    isSamePathOrInside(targetParts, [...homeParts, folderName.toLowerCase()])
  ));
}

/** True when a path is one Ustaad must never read or write. */
export function isBlockedPath(rawPath: string): boolean {
  const normalizedTarget = `\\${splitWindowsPath(rawPath).join("\\")}\\`;
  return blockedPathFragments.some((fragment) => normalizedTarget.includes(fragment));
}

/**
 * Classifies a raw PowerShell command or script.
 *
 * Blocked wins over everything, Tier 2 wins over Tier 1, and anything Ustaad
 * does not positively recognise as a diagnostic is Tier 2 rather than being
 * waved through: the default is "ask the user properly".
 */
export function classifySystemCommand(rawCommand: string): SystemAccessClassification {
  const command = rawCommand.trim();
  if (!command) {
    return { tier: "blocked", reason: "there was nothing to run" };
  }

  for (const blockedPattern of blockedPatterns) {
    if (blockedPattern.pattern.test(command)) {
      return { tier: "blocked", reason: blockedPattern.reason };
    }
  }

  for (const tier2Pattern of tier2Patterns) {
    if (tier2Pattern.pattern.test(command)) {
      return { tier: "tier2", reason: tier2Pattern.reason };
    }
  }

  // Redirecting output, running something in the background and evaluating
  // arbitrary expressions are never diagnostics, however harmless they look.
  if (/[><`&]|\$\(/u.test(command)) {
    return { tier: "tier2", reason: "it writes output or builds a command on the fly" };
  }

  // Pipes and semicolons are how people write real diagnostics, so each part of
  // a chain is allowed only when every single one of them is read-only.
  const commandSegments = command
    .split(/\||;|&&|\|\|/u)
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (const commandSegment of commandSegments) {
    const firstWord = commandSegment
      .split(/\s+/u)[0]
      ?.replace(/^[.\\/]+/u, "")
      .replace(/\.exe$/iu, "")
      .toLowerCase() ?? "";
    if (!tier1CommandNames.includes(firstWord)) {
      return { tier: "tier2", reason: "a command Ustaad does not recognise as read-only" };
    }
  }

  return { tier: "tier1", reason: "a read-only diagnostic" };
}

export interface SystemAccessDecision {
  allowed: boolean;
  tier: SystemAccessTier;
  /** Empty when the request is allowed. */
  message: string;
  /** The louder wording Tier 2 carries, shown on its confirmation card. */
  confirmationNote: string;
}

/**
 * The single place that decides whether a system-access request may go ahead.
 * Both the action executor and the panel ask this, so the rules cannot drift.
 */
export function decideSystemAccess(options: {
  request:
    | { kind: "command"; command: string }
    | { kind: "file"; path: string; operation: "read" | "write" | "list" }
    | { kind: "registry"; path: string };
  abilities: { systemAccessTier1: boolean; systemAccessTier2: boolean };
  /** The user's profile directory. Defaults to the real one for this machine. */
  homeDirectory?: string;
}): SystemAccessDecision {
  const { request } = options;

  if (request.kind === "registry") {
    if (!options.abilities.systemAccessTier1) {
      return {
        allowed: false,
        tier: "tier1",
        message: "system access is switched off, so I did not read that registry key.",
        confirmationNote: "",
      };
    }
    if (isBlockedPath(request.path) || /\\sam\b|\\security\b/iu.test(request.path)) {
      return {
        allowed: false,
        tier: "blocked",
        message: "that is a windows credential store, so I will not read it.",
        confirmationNote: "",
      };
    }
    return { allowed: true, tier: "tier1", message: "", confirmationNote: "reads one registry key, and changes nothing" };
  }

  if (request.kind === "file") {
    if (!options.abilities.systemAccessTier1) {
      return {
        allowed: false,
        tier: "tier1",
        message: "system access is switched off, so I did not touch that file.",
        confirmationNote: "",
      };
    }
    if (isBlockedPath(request.path)) {
      return {
        allowed: false,
        tier: "blocked",
        message: "that path holds saved passwords or credentials, so I will not touch it.",
        confirmationNote: "",
      };
    }
    if (!isPathInsideUserFolders(request.path, options.homeDirectory ?? homedir())) {
      return {
        allowed: false,
        tier: "blocked",
        message: "I only work with files inside your own Documents, Downloads, Desktop, Pictures, Videos and Music folders.",
        confirmationNote: "",
      };
    }
    if (request.operation !== "read" && request.operation !== "list" && !options.abilities.systemAccessTier1) {
      return {
        allowed: false,
        tier: "tier1",
        message: "system access is switched off, so I did not write that file.",
        confirmationNote: "",
      };
    }
    return {
      allowed: true,
      tier: "tier1",
      message: "",
      confirmationNote: request.operation === "read" || request.operation === "list"
        ? "reads one of your files, and changes nothing"
        : "writes that file in your own folder",
    };
  }

  const classification = classifySystemCommand(request.command);
  if (classification.tier === "blocked") {
    return { allowed: false, tier: "blocked", message: classification.reason, confirmationNote: "" };
  }
  if (classification.tier === "tier2") {
    if (!options.abilities.systemAccessTier2) {
      return {
        allowed: false,
        tier: "tier2",
        message: `that is ${classification.reason}, which needs the "arbitrary commands" switch in system access.`,
        confirmationNote: "",
      };
    }
    return {
      allowed: true,
      tier: "tier2",
      message: "",
      confirmationNote: `this runs a real command on your pc (${classification.reason}) — read it carefully before you say yes`,
    };
  }
  if (!options.abilities.systemAccessTier1) {
    return {
      allowed: false,
      tier: "tier1",
      message: "system access is switched off, so I did not run that.",
      confirmationNote: "",
    };
  }
  return { allowed: true, tier: "tier1", message: "", confirmationNote: "runs one read-only diagnostic" };
}
