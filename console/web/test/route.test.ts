import { describe, expect, it } from "vitest";
import { issueOf, pageOf } from "../src/lib/route.svelte";

describe("route", () => {
  it("only /map and /map/ are the map", () => {
    expect([pageOf("/map"), pageOf("/map/"), pageOf("/"), pageOf("/mapx"), pageOf("/map/x"), pageOf("")]).toEqual(
      ["map", "map", "foundry", "foundry", "foundry", "foundry"]);
  });
  it("the old map path still opens the map", () => {
    expect([pageOf("/peta"), pageOf("/peta/"), pageOf("/petax")]).toEqual(["map", "map", "foundry"]);
  });
  it("?issue= is a positive integer or nothing", () => {
    expect([issueOf("?issue=23"), issueOf(""), issueOf("?issue=0"), issueOf("?issue=-4"), issueOf("?issue=2x"), issueOf("?issue=1234567890")]).toEqual(
      [23, null, null, null, null, null]);
  });
});
