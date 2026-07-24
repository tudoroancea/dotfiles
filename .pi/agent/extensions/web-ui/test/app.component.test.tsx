// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/web/app.js";

afterEach(cleanup);

describe("web skeleton", () => {
  it("mounts the session placeholder", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Pi Web UI" })).toBeTruthy();
  });
});
