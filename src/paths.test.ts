import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateLegacyRuntimeState } from "./paths.ts";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cursor-relay-paths-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("migrateLegacyRuntimeState moves the old runtime directory and renames sqlite files", () => {
  const root = tempRoot();
  const legacyDir = join(root, ".shim");
  const currentDir = join(root, ".cursor-relay");
  mkdirSync(legacyDir);
  writeFileSync(join(legacyDir, "shim.db"), "db");
  writeFileSync(join(legacyDir, "shim.db-wal"), "wal");
  writeFileSync(join(legacyDir, "service.log"), "log");

  migrateLegacyRuntimeState({ currentDir, legacyDir });

  expect(existsSync(legacyDir)).toBe(false);
  expect(readFileSync(join(currentDir, "cursor-relay.db"), "utf8")).toBe("db");
  expect(readFileSync(join(currentDir, "cursor-relay.db-wal"), "utf8")).toBe("wal");
  expect(readFileSync(join(currentDir, "service.log"), "utf8")).toBe("log");
  expect(existsSync(join(currentDir, "shim.db"))).toBe(false);
});

test("migrateLegacyRuntimeState preserves current files when a legacy file conflicts", () => {
  const root = tempRoot();
  const legacyDir = join(root, ".shim");
  const currentDir = join(root, ".cursor-relay");
  mkdirSync(legacyDir);
  mkdirSync(currentDir);
  writeFileSync(join(legacyDir, "shim.db"), "legacy");
  writeFileSync(join(legacyDir, "runner.cmd"), "runner");
  writeFileSync(join(currentDir, "cursor-relay.db"), "current");

  migrateLegacyRuntimeState({ currentDir, legacyDir });

  expect(readFileSync(join(currentDir, "cursor-relay.db"), "utf8")).toBe("current");
  expect(readFileSync(join(legacyDir, "shim.db"), "utf8")).toBe("legacy");
  expect(readFileSync(join(currentDir, "runner.cmd"), "utf8")).toBe("runner");
});
