import { test, expect } from "bun:test";
import { clipboardCommand, createClipboard, osc52Sequence } from "./clipboard.ts";

test("clipboardCommand picks the native command per platform", () => {
  expect(clipboardCommand("win32")).toEqual(["clip"]);
  expect(clipboardCommand("darwin")).toEqual(["pbcopy"]);
  expect(clipboardCommand("linux")).toEqual(["xclip", "-selection", "clipboard"]);
});

test("clipboardCommand has no native command on other platforms", () => {
  expect(clipboardCommand("freebsd")).toBeNull();
  expect(clipboardCommand("")).toBeNull();
});

test("osc52Sequence wraps the base64 payload in the OSC52 escape", () => {
  expect(osc52Sequence("hi")).toBe("]52;c;aGk=");
  expect(osc52Sequence("")).toBe("]52;c;");
});

test("copy uses the native command when it succeeds, without touching OSC52", () => {
  const calls: Array<readonly string[]> = [];
  let rawWrites = 0;
  const clip = createClipboard(
    "win32",
    async (cmd, text) => {
      calls.push(cmd);
      expect(text).toBe("http://127.0.0.1:8787/v1");
      return true;
    },
    () => {
      rawWrites++;
      return true;
    },
  );
  expect(clip.copy("http://127.0.0.1:8787/v1")).resolves.toBe(true);
  expect(calls).toEqual([["clip"]]);
  expect(rawWrites).toBe(0);
});

test("copy falls back to OSC52 when the native command fails", async () => {
  const raw: string[] = [];
  const clip = createClipboard(
    "linux",
    async () => false, // xclip missing
    (seq) => {
      raw.push(seq);
      return true;
    },
  );
  expect(await clip.copy("hi")).toBe(true);
  expect(raw).toEqual([osc52Sequence("hi")]);
});

test("copy goes straight to OSC52 on a platform with no native command", async () => {
  const raw: string[] = [];
  const clip = createClipboard(
    "freebsd",
    async () => {
      throw new Error("must not be called");
    },
    (seq) => {
      raw.push(seq);
      return true;
    },
  );
  expect(await clip.copy("hi")).toBe(true);
  expect(raw).toEqual([osc52Sequence("hi")]);
});

test("copy is a graceful no-op (false) when no mechanism is available", async () => {
  const clip = createClipboard(
    "freebsd",
    async () => false,
    () => false, // not a TTY — OSC52 unavailable too
  );
  expect(await clip.copy("hi")).toBe(false);
});
