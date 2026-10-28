// Imported FIRST by tests/claude-code.test.ts: an isolated data dir and
// Claude Code config dir for this file only (config.ts reads LH_DATA_DIR at
// import), and the scripted fake `claude` in place of the real one.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "lh-claude-code-"));
export const DATA_DIR = path.join(root, "data");
export const CONFIG_DIR = path.join(root, "claude-config");
export const SCENARIO = path.join(root, "scenario.json");
export const LOG = path.join(root, "fake.log");
export const FAKE_BIN = path.resolve("tests/fixtures/fake-claude.mjs");

process.env.LH_DATA_DIR = DATA_DIR;
process.env.CLAUDE_CONFIG_DIR = CONFIG_DIR;
process.env.LH_CLAUDE_CODE_BIN = FAKE_BIN;
process.env.LH_FAKE_CLAUDE_SCENARIO = SCENARIO;
process.env.LH_FAKE_CLAUDE_LOG = LOG;
// A key in the server's env must never reach Claude Code.
process.env.ANTHROPIC_API_KEY = "sk-ant-must-never-reach-claude-code";

process.on("exit", () => rmSync(root, { recursive: true, force: true }));
