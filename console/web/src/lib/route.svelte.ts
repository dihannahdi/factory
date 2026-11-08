// Two pages on one origin: "/" is the Foundry, "/map" the dependency map. History API only; the
// server already answers any non-asset path with index.html (server.mjs handleStatic, SPA fallback).
// The selected issue on the map lives in the query (?issue=23), so a map link can be shared.

export type Page = "foundry" | "map";

/** "/map" and "/map/" are the map (so are the old "/peta" and "/peta/"); everything else is the Foundry. */
export function pageOf(pathname: string): Page {
  return /^\/(map|peta)\/?$/.test(pathname) ? "map" : "foundry";
}

/** The ?issue= number, or null when absent or not a positive integer. */
export function issueOf(search: string): number | null {
  const v = new URLSearchParams(search).get("issue");
  return v != null && /^[1-9]\d{0,8}$/.test(v) ? Number(v) : null;
}

const TITLES: Record<Page, string> = { foundry: "factory", map: "map · factory" };

class Route {
  page = $state<Page>(typeof location === "undefined" ? "foundry" : pageOf(location.pathname));
  issue = $state<number | null>(typeof location === "undefined" ? null : issueOf(location.search));

  constructor() {
    if (typeof window === "undefined") return;
    window.addEventListener("popstate", () => this.read());
    // The map used to live at /peta; rewrite old links to /map in place, keeping ?issue=.
    if (/^\/peta\/?$/.test(location.pathname)) history.replaceState(null, "", `/map${location.search}${location.hash}`);
    document.title = TITLES[this.page];
  }

  private read() {
    this.page = pageOf(location.pathname);
    this.issue = issueOf(location.search);
    document.title = TITLES[this.page];
  }

  /** Go to a page (a new history entry). */
  go(page: Page) {
    if (page === this.page) return;
    history.pushState(null, "", page === "map" ? "/map" : "/");
    this.read();
  }

  /** Reflect the selected issue in the URL without a new history entry. */
  setIssue(n: number | null) {
    if (this.page !== "map" || n === this.issue) return;
    history.replaceState(null, "", n == null ? "/map" : `/map?issue=${n}`);
    this.issue = n;
  }
}

export const route = new Route();
