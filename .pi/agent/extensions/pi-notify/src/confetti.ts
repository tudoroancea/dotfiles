/**
 * Confetti Module
 *
 * Triggers confetti celebration via Raycast.
 */

import { exec } from "node:child_process";

/**
 * Trigger confetti via Raycast.
 *
 * Uses the Raycast URL scheme to trigger the built-in confetti command.
 * Runs in background (-g flag) to not steal focus.
 *
 * @returns Promise that resolves when the command is executed
 */
export async function triggerConfetti(): Promise<void> {
  return new Promise((resolve) => {
    // Use open -g to run in background without stealing focus
    exec("open -g raycast://extensions/raycast/raycast/confetti", (err) => {
      if (err) {
        // Raycast might not be installed, fail silently
        // This is expected on systems without Raycast
      }
      resolve();
    });
  });
}

/**
 * Check if Raycast is available on the system.
 *
 * @returns Promise that resolves to true if Raycast is available
 */
export async function isRaycastAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    exec("mdfind 'kMDItemCFBundleIdentifier == \"com.raycast.macos\"'", (err, stdout) => {
      if (err) {
        resolve(false);
        return;
      }
      resolve(stdout.trim().length > 0);
    });
  });
}
