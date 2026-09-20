// Standalone production browser entry.
//
// Vite bundles this module, the shared TSX client, and the pinned local Preact /
// Marked / DOMPurify dependencies into one self-contained asset with no runtime
// network imports. It mounts the shared session UI with the standalone transport.

import { mount } from "@dotfiles/pi-web-ui-client/client";
import "@dotfiles/pi-web-ui-client/styles.css";
import { createStandaloneTransport } from "./standalone-transport.ts";

mount(document.getElementById("app")!, createStandaloneTransport());
