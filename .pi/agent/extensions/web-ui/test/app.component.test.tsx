// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/web/app.js";

afterEach(cleanup);

describe("web shell", () => {
  it("mounts the session timeline shell without a sticky title bar", () => {
    render(<App />);
    // The transcript intro replaced the old sticky topbar heading.
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Connecting…");
    expect(screen.getByText("Waiting for the session snapshot…")).toBeTruthy();
  });
});
