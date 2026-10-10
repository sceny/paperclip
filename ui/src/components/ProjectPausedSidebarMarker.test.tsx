// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectPausedSidebarMarker } from "./ProjectPausedSidebarMarker";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ProjectPausedSidebarMarker", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  function render(pauseReason: Parameters<typeof ProjectPausedSidebarMarker>[0]["pauseReason"]) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(<ProjectPausedSidebarMarker pauseReason={pauseReason} />));
    return container;
  }

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  it("labels a budget pause", () => {
    expect(render("budget").querySelector('[aria-label="Project paused by budget"]')).not.toBeNull();
  });

  it("labels a manual pause", () => {
    expect(render("manual").querySelector('[aria-label="Project paused manually"]')).not.toBeNull();
  });

  it.each([null, undefined])("renders nothing when the project is not paused (%s)", (reason) => {
    expect(render(reason).innerHTML).toBe("");
  });
});
