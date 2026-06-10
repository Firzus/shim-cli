import { test, expect } from "bun:test";
import { parsePortOwnerPid } from "./service.ts";

test("parsePortOwnerPid extracts the owning pid from the probe output", () => {
  expect(parsePortOwnerPid("20580\r\n", 999)).toBe(20580);
  expect(parsePortOwnerPid("  1234  ", 999)).toBe(1234);
});

test("parsePortOwnerPid is null when the port is free (empty probe)", () => {
  expect(parsePortOwnerPid("", 999)).toBeNull();
  expect(parsePortOwnerPid("\r\n", 999)).toBeNull();
});

test("parsePortOwnerPid never targets this process", () => {
  expect(parsePortOwnerPid("999", 999)).toBeNull();
});

test("parsePortOwnerPid never targets a system pid (0/4) or garbage", () => {
  expect(parsePortOwnerPid("0", 999)).toBeNull();
  expect(parsePortOwnerPid("4", 999)).toBeNull();
  expect(parsePortOwnerPid("not-a-pid", 999)).toBeNull();
});
