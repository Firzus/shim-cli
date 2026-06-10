/**
 * Small injected clipboard adapter for the TUI's endpoint-copy key. The
 * platform → command selection and the OSC52 escape are pure and unit-tested;
 * only the default spawn/stdout writers touch the real system, and both are
 * injectable so presenters and tests never reach the real clipboard.
 */

export interface ClipboardAdapter {
  /** Copy `text` to the system clipboard. Resolves false when no mechanism worked. */
  copy(text: string): Promise<boolean>;
}

/**
 * The native copy command for a platform, or null when there is none to try
 * (the OSC52 escape is then the only mechanism). Pure.
 */
export function clipboardCommand(platform: string): readonly string[] | null {
  if (platform === "win32") return ["clip"];
  if (platform === "darwin") return ["pbcopy"];
  if (platform === "linux") return ["xclip", "-selection", "clipboard"];
  return null;
}

/**
 * The OSC52 escape sequence that asks the terminal itself to set the clipboard
 * — the fallback when no native command is available (e.g. over SSH). Pure.
 */
export function osc52Sequence(text: string): string {
  return `]52;c;${Buffer.from(text, "utf8").toString("base64")}`;
}

/** Pipe `text` into a copy command's stdin and report whether it exited 0. */
async function spawnCopy(cmd: readonly string[], text: string): Promise<boolean> {
  try {
    const proc = Bun.spawn([...cmd], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    proc.stdin.write(text);
    await proc.stdin.end();
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/**
 * Build the clipboard adapter: try the platform's native command first, then
 * fall back to OSC52 through the terminal; false when neither is available so
 * the caller can degrade to a message instead of failing silently.
 */
export function createClipboard(
  platform: string = process.platform,
  runCopy: (cmd: readonly string[], text: string) => Promise<boolean> = spawnCopy,
  writeRaw: (seq: string) => boolean = (seq) => (process.stdout.isTTY ? process.stdout.write(seq) : false),
): ClipboardAdapter {
  return {
    async copy(text: string): Promise<boolean> {
      const cmd = clipboardCommand(platform);
      if (cmd && (await runCopy(cmd, text))) return true;
      return writeRaw(osc52Sequence(text));
    },
  };
}
