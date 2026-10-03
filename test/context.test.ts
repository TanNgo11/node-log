import { describe, expect, it } from "vitest";
import { addContext, attachStore, getContext, recordError, runWithStore, storeOf, withContext } from "../src/context";

describe("context", () => {
  it("is empty outside a context", () => {
    expect(getContext()).toEqual({});
    addContext({ a: 1 }); // no-op, must not throw
    recordError(new Error("x")); // no-op
  });
  it("carries fields across awaits and nests by copying the parent", async () => {
    await withContext({ request_id: "r1" }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(getContext()).toEqual({ request_id: "r1" });
      addContext({ user_id: "u1" });
      await withContext({ job_id: "j1" }, async () => {
        expect(getContext()).toEqual({ request_id: "r1", user_id: "u1", job_id: "j1" });
      });
      expect(getContext()).toEqual({ request_id: "r1", user_id: "u1" });
    });
  });
  it("records errors on the current store", () => {
    runWithStore({}, (store) => {
      const e = new Error("x");
      recordError(e);
      expect(store.error).toBe(e);
    });
  });
  it("attaches stores to objects", () => {
    const target = {};
    runWithStore({ a: 1 }, (store) => attachStore(target, store));
    expect(storeOf(target)?.fields).toEqual({ a: 1 });
    expect(storeOf({})).toBeUndefined();
    expect(storeOf(null)).toBeUndefined();
  });
});

describe("nested contexts", () => {
  it("addContext and recordError reach the enclosing request context", async () => {
    await runWithStore({ request_id: "r1" }, async (request) => {
      await withContext({ step: "inner" }, async () => {
        addContext({ user_id: "u1" });
        recordError(new Error("inner failure"));
      });
      expect(request.fields).toEqual({ request_id: "r1", user_id: "u1" });
      expect((request.error as Error).message).toBe("inner failure");
    });
  });
  it("does not overwrite an error the outer context already recorded", () => {
    runWithStore({}, (outer) => {
      const first = new Error("first");
      recordError(first);
      withContext({}, () => recordError(new Error("second")));
      expect(outer.error).toBe(first);
    });
  });
});
