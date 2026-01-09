/**
 * Notification Module
 *
 * Sends native macOS notifications using node-notifier.
 * Supports click-to-activate Ghostty via AppleScript.
 */

import notifier from "node-notifier";
import { exec } from "node:child_process";

export interface NotificationOptions {
  title: string;
  message: string;
  critical?: boolean;
  sound?: string;
}

/**
 * Send a native macOS notification.
 *
 * @param options - Notification options
 * @returns Promise that resolves when notification is shown
 */
export async function sendNotification(options: NotificationOptions): Promise<void> {
  const { title, message, critical = false, sound } = options;

  return new Promise((resolve) => {
    // Use node-notifier's NotificationCenter for macOS
    notifier.notify(
      {
        title,
        message,
        sound: sound ?? (critical ? "Basso" : "Pop"),
        wait: true, // Wait for user interaction
        timeout: critical ? 30 : 10, // Critical notifications persist longer
      },
      (err, _response, _metadata) => {
        if (err) {
          console.error("Notification error:", err);
        }
        resolve();
      }
    );

    // Handle click to activate Ghostty
    notifier.on("click", () => {
      activateGhostty();
    });
  });
}

/**
 * Activate Ghostty using AppleScript.
 * This brings Ghostty to the foreground when the notification is clicked.
 */
function activateGhostty(): void {
  const script = `
    tell application "Ghostty"
      activate
    end tell
  `;

  exec(`osascript -e '${script}'`, (err) => {
    if (err) {
      // Ghostty might not be installed, try generic terminal activation
      console.error("Failed to activate Ghostty:", err.message);
    }
  });
}
