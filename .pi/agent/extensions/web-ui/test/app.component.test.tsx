// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/web/app.js";

afterEach(cleanup);

describe("web shell", () => {
  it("mounts the session timeline shell", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Session timeline" })).toBeTruthy();
  });
});
