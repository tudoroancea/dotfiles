// Daemon-served production browser entry.
//
// The browser bundler bundles this module, the shared TSX client, and the
// pinned shared dependencies into one self-contained daemon asset with no
// runtime network imports. It loads the shared session styles first, then the
// focused shell chrome, and starts the machine/session shell.

import "@dotfiles/pi-web-ui-client/styles.css";
import "./styles.css";
import { startManagedShell } from "./shell.ts";

startManagedShell(document.getElementById("managed-root") ?? document.body);
