/**
 * bin/tests/env-detect.test.mjs
 *
 * Unit tests for detectEnvironment from bin/env-detect.mjs.
 *
 * Every scenario is driven entirely through injected `platform`/`env`/
 * `release`/`readFileSync` — no process mocking, no real filesystem or OS
 * dependency. This lets Windows/macOS/Linux/WSL behavior be tested
 * deterministically regardless of the CI runner's actual OS.
 *
 * Covers:
 *   - Windows 11 vs Windows 10 vs generic Windows label (build-number parsing)
 *   - macOS / Linux labels
 *   - WSL detection via WSL_DISTRO_NAME
 *   - WSL detection via /proc/version fallback (no WSL_DISTRO_NAME)
 *   - Non-WSL Linux (no signals present)
 *   - /proc/version read failure degrades to "not WSL" (never throws)
 *   - Shell detection: $SHELL (POSIX/Git-Bash), PSModulePath, ComSpec, unknown
 *   - symlinkSupport best-guess: true off Windows, false on Windows
 *   - detectEnvironment() never throws even when every injected reader throws
 *
 * Run with: node --test bin/tests/env-detect.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectEnvironment } from "../env-detect.mjs";

describe("detectEnvironment — platform label", () => {
  it("win32 with build >= 22000 reports Windows 11", () => {
    const info = detectEnvironment({ platform: "win32", env: {}, release: "10.0.22631" });
    assert.equal(info.platformLabel, "Windows 11");
    assert.equal(info.platform, "win32");
  });

  it("win32 with build < 22000 reports Windows 10", () => {
    const info = detectEnvironment({ platform: "win32", env: {}, release: "10.0.19045" });
    assert.equal(info.platformLabel, "Windows 10");
  });

  it("win32 with an unrecognized release string falls back to generic Windows", () => {
    const info = detectEnvironment({ platform: "win32", env: {}, release: "6.1.7601" });
    assert.equal(info.platformLabel, "Windows");
  });

  it("darwin reports macOS", () => {
    const info = detectEnvironment({ platform: "darwin", env: {}, release: "23.1.0" });
    assert.equal(info.platformLabel, "macOS");
  });

  it("linux reports Linux", () => {
    const info = detectEnvironment({ platform: "linux", env: {}, release: "5.15.0" });
    assert.equal(info.platformLabel, "Linux");
  });

  it("unrecognized platform falls back to the raw platform string", () => {
    const info = detectEnvironment({ platform: "freebsd", env: {}, release: "13.0" });
    assert.equal(info.platformLabel, "freebsd");
  });
});

describe("detectEnvironment — WSL detection", () => {
  it("detects WSL via WSL_DISTRO_NAME regardless of /proc/version", () => {
    const info = detectEnvironment({
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu-22.04" },
      readFileSync: () => {
        throw new Error("should not be called when WSL_DISTRO_NAME is present");
      },
    });
    assert.equal(info.isWSL, true);
    assert.equal(info.wslDistro, "Ubuntu-22.04");
  });

  it("falls back to /proc/version containing 'microsoft' when env var is absent", () => {
    const info = detectEnvironment({
      platform: "linux",
      env: {},
      readFileSync: () => "Linux version 5.15.90.1-microsoft-standard-WSL2",
    });
    assert.equal(info.isWSL, true);
    assert.equal(info.wslDistro, null);
  });

  it("plain Linux (no WSL signals) reports isWSL: false", () => {
    const info = detectEnvironment({
      platform: "linux",
      env: {},
      readFileSync: () => "Linux version 5.15.0-generic",
    });
    assert.equal(info.isWSL, false);
    assert.equal(info.wslDistro, null);
  });

  it("unreadable /proc/version degrades to not-WSL instead of throwing", () => {
    assert.doesNotThrow(() => {
      const info = detectEnvironment({
        platform: "linux",
        env: {},
        readFileSync: () => {
          throw new Error("ENOENT: no such file or directory, open '/proc/version'");
        },
      });
      assert.equal(info.isWSL, false);
    });
  });

  it("never checks /proc/version on non-linux platforms", () => {
    const info = detectEnvironment({
      platform: "darwin",
      env: {},
      readFileSync: () => {
        throw new Error("should not be called on darwin");
      },
    });
    assert.equal(info.isWSL, false);
  });
});

describe("detectEnvironment — shell detection", () => {
  it("prefers $SHELL and strips the path down to a basename", () => {
    const info = detectEnvironment({ platform: "linux", env: { SHELL: "/usr/bin/zsh" } });
    assert.equal(info.shell, "zsh");
  });

  it("$SHELL also covers Git-Bash/MSYS on Windows", () => {
    const info = detectEnvironment({ platform: "win32", env: { SHELL: "/usr/bin/bash" } });
    assert.equal(info.shell, "bash");
  });

  it("win32 without $SHELL but with PSModulePath reports PowerShell", () => {
    const info = detectEnvironment({
      platform: "win32",
      env: { PSModulePath: "C:\\Program Files\\WindowsPowerShell\\Modules" },
    });
    assert.equal(info.shell, "PowerShell");
  });

  it("win32 without $SHELL/PSModulePath but with ComSpec reports cmd", () => {
    const info = detectEnvironment({
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" },
    });
    assert.equal(info.shell, "cmd");
  });

  it("no shell signals at all reports unknown", () => {
    const info = detectEnvironment({ platform: "linux", env: {} });
    assert.equal(info.shell, "unknown");
  });
});

describe("detectEnvironment — symlinkSupport", () => {
  it("is true on non-Windows platforms", () => {
    assert.equal(detectEnvironment({ platform: "linux", env: {} }).symlinkSupport, true);
    assert.equal(detectEnvironment({ platform: "darwin", env: {} }).symlinkSupport, true);
  });

  it("is false on win32 (conservative best-guess)", () => {
    assert.equal(detectEnvironment({ platform: "win32", env: {} }).symlinkSupport, false);
  });
});

describe("detectEnvironment — never throws", () => {
  it("returns a best-guess result even when platform/env/release/readFileSync are all hostile", () => {
    assert.doesNotThrow(() => {
      const info = detectEnvironment({
        platform: undefined,
        env: {},
        release: undefined,
        readFileSync: () => {
          throw new Error("boom");
        },
      });
      assert.equal(typeof info, "object");
      assert.equal(info.isWSL, false);
    });
  });

  it("works with zero arguments (falls back to real process.platform/env/os.release())", () => {
    assert.doesNotThrow(() => {
      const info = detectEnvironment();
      assert.equal(typeof info.platform, "string");
      assert.equal(typeof info.platformLabel, "string");
      assert.equal(typeof info.shell, "string");
      assert.equal(typeof info.symlinkSupport, "boolean");
    });
  });
});
