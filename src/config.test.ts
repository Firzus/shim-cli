import { test, expect, afterEach } from "bun:test";
import { parseCacheTtlEnv } from "./config.ts";

const KEY = "CACHE_TTL_TEST";

afterEach(() => {
  delete process.env[KEY];
});

test("parseCacheTtlEnv accepts the two valid TTLs", () => {
  process.env[KEY] = "1h";
  expect(parseCacheTtlEnv(KEY, "5m")).toBe("1h");
  process.env[KEY] = "5m";
  expect(parseCacheTtlEnv(KEY, "1h")).toBe("5m");
});

test("parseCacheTtlEnv is case- and whitespace-insensitive", () => {
  process.env[KEY] = "  1H  ";
  expect(parseCacheTtlEnv(KEY, "5m")).toBe("1h");
});

test("parseCacheTtlEnv falls back when unset or invalid", () => {
  expect(parseCacheTtlEnv(KEY, "1h")).toBe("1h"); // unset
  process.env[KEY] = "30m"; // not a supported value
  expect(parseCacheTtlEnv(KEY, "1h")).toBe("1h");
  process.env[KEY] = "";
  expect(parseCacheTtlEnv(KEY, "5m")).toBe("5m");
});
