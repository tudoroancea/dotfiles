/**
 * Focus Detection Module
 *
 * Tracks whether the terminal window is focused using terminal escape sequences.
 * This approach works with terminals that support focus reporting (DECSET 1004),
 * including Ghostty, iTerm2, and most modern terminals.
 *
 * The module is designed to be easily swapped for macOS-specific APIs later.
 */

let focused = true; // Assume focused initially
let cleanupFn: (() => void) | null = null;

/**
 * Check if the terminal window is currently focused.
 */
export function isFocused(): boolean {
  return focused;
}

/**
 * Setup focus tracking using terminal escape sequences.
 *
 * Enables focus reporting (DECSET 1004) which causes the terminal to send
 * escape sequences when focus changes:
 * - \x1b[I = focus gained
 * - \x1b[O = focus lost
 */
export function setupFocusTracking(): void {
  if (cleanupFn) {
    return; // Already set up
  }

  // Enable focus reporting
  process.stdout.write("\x1b[?1004h");

  // Buffer for accumulating escape sequence data
  let buffer = "";

  const handleData = (data: Buffer) => {
    const str = data.toString();
    buffer += str;

    // Check for focus events in the buffer
    // Focus gained: \x1b[I or \x1b[1;I
    // Focus lost: \x1b[O or \x1b[1;O
    if (buffer.includes("\x1b[I")) {
      focused = true;
      buffer = buffer.replace(/\x1b\[I/g, "");
    }
    if (buffer.includes("\x1b[O")) {
      focused = false;
      buffer = buffer.replace(/\x1b\[O/g, "");
    }

    // Clear buffer if it gets too long (prevent memory leak)
    if (buffer.length > 100) {
      buffer = buffer.slice(-20);
    }
  };

  // Listen for stdin data in raw mode
  if (process.stdin.isTTY) {
    process.stdin.on("data", handleData);

    cleanupFn = () => {
      // Disable focus reporting
      process.stdout.write("\x1b[?1004l");
      process.stdin.off("data", handleData);
    };
  } else {
    // Not a TTY, assume always focused (prevents notifications in non-interactive mode)
    focused = true;
    cleanupFn = () => {};
  }
}

/**
 * Cleanup focus tracking.
 */
export function cleanupFocusTracking(): void {
  if (cleanupFn) {
    cleanupFn();
    cleanupFn = null;
  }
}

/**
 * Manually set focus state (for testing or fallback).
 */
export function setFocused(value: boolean): void {
  focused = value;
}
