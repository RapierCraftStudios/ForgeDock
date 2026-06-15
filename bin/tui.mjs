/**
 * bin/tui.mjs — Zero-dependency TUI primitives for ForgeDock
 *
 * Provides: colors, box drawing, spinner, progress bar, prompts,
 * step renderer, and table renderer using only Node.js built-in APIs.
 *
 * NO_COLOR support: set NO_COLOR=1 or run in a non-TTY environment
 * to disable all ANSI escape codes. Unicode symbols (e.g. ●, ✔, ✖, ○, —) are
 * not ANSI codes and remain in the output even when NO_COLOR is set — this is
 * correct per the NO_COLOR specification (https://no-color.org/).
 */

import readline from "readline";

// ---------------------------------------------------------------------------
// ANSI detection — computed once at module load
// ---------------------------------------------------------------------------

const USE_ANSI =
  process.stdout.isTTY === true &&
  !process.env.NO_COLOR &&
  process.env.TERM !== "dumb";

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

function ansi(code) {
  return USE_ANSI ? `\x1b[${code}m` : "";
}

/** Wrap text in an ANSI escape sequence (or return plain text if ANSI disabled). */
function wrap(text, open, close) {
  if (!USE_ANSI) return String(text);
  return `\x1b[${open}m${text}\x1b[${close}m`;
}

export const reset = ansi(0);
export const RESET = reset; // alias for forgedock.mjs compat

export function bold(text) {
  return wrap(text, 1, 22);
}
export const BOLD = USE_ANSI ? "\x1b[1m" : ""; // constant alias

export function dim(text) {
  return wrap(text, 2, 22);
}

export function underline(text) {
  return wrap(text, 4, 24);
}

export function red(text) {
  return wrap(text, 31, 39);
}
export const RED = USE_ANSI ? "\x1b[31m" : ""; // constant alias

export function green(text) {
  return wrap(text, 32, 39);
}
export const GREEN = USE_ANSI ? "\x1b[32m" : ""; // constant alias

export function yellow(text) {
  return wrap(text, 33, 39);
}
export const YELLOW = USE_ANSI ? "\x1b[33m" : ""; // constant alias

export function cyan(text) {
  return wrap(text, 36, 39);
}
export const CYAN = USE_ANSI ? "\x1b[36m" : ""; // constant alias

export function magenta(text) {
  return wrap(text, 35, 39);
}

export function white(text) {
  return wrap(text, 37, 39);
}

// ---------------------------------------------------------------------------
// Box drawing
// ---------------------------------------------------------------------------

const BOX_CHARS = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
};

/**
 * Render a Unicode box around lines of text.
 *
 * @param {string|string[]} content  - Text content (or array of lines)
 * @param {object} [opts]
 * @param {string} [opts.title]      - Optional title shown in the top border
 * @param {number} [opts.padding]    - Horizontal padding inside box (default 1)
 * @param {number} [opts.width]      - Minimum inner width (auto-detected from content)
 * @returns {string} Rendered box string (includes trailing newline)
 */
export function box(content, { title = "", padding = 1, width } = {}) {
  const lines = Array.isArray(content) ? content : String(content).split("\n");
  const pad = " ".repeat(padding);

  const contentWidth = lines.reduce(
    (max, l) => Math.max(max, stripAnsi(l).length),
    0,
  );
  const titleLen = stripAnsi(title).length;
  const innerWidth = Math.max(
    width || 0,
    contentWidth,
    titleLen + (title ? 4 : 0),
    1,
  );
  const totalInner = innerWidth + padding * 2;

  function hLine(leftChar, rightChar, fill) {
    if (title) {
      const t = ` ${title} `;
      const tLen = stripAnsi(t).length;
      const remaining = totalInner - tLen;
      const left = Math.floor(remaining / 2);
      const right = remaining - left;
      return leftChar + fill.repeat(left) + t + fill.repeat(right) + rightChar;
    }
    return leftChar + fill.repeat(totalInner) + rightChar;
  }

  const top = hLine(
    BOX_CHARS.topLeft,
    BOX_CHARS.topRight,
    BOX_CHARS.horizontal,
  );
  const bottom =
    BOX_CHARS.bottomLeft +
    BOX_CHARS.horizontal.repeat(totalInner) +
    BOX_CHARS.bottomRight;

  const body = lines.map((line) => {
    const visual = stripAnsi(line).length;
    const spaces = Math.max(0, innerWidth - visual);
    return (
      BOX_CHARS.vertical +
      pad +
      line +
      " ".repeat(spaces) +
      pad +
      BOX_CHARS.vertical
    );
  });

  return [top, ...body, bottom].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Create an async spinner.
 *
 * @param {string} message - Initial spinner message
 * @param {object} [opts]
 * @param {string[]} [opts.frames] - Custom animation frames
 * @param {number}  [opts.interval] - Frame interval ms (default 80)
 * @returns {{ stop(status?, finalMsg?): void, update(msg): void }}
 *
 * Usage:
 *   const s = spinner('Loading…');
 *   // ... async work ...
 *   s.stop('success', 'Done!');
 */
export function spinner(
  message,
  { frames = BRAILLE_FRAMES, interval = 80 } = {},
) {
  let current = message;
  let frame = 0;
  let stopped = false;

  if (!USE_ANSI || !process.stderr.isTTY) {
    // Non-TTY: print message once and return a no-op stopper
    process.stderr.write(current + "\n");
    return {
      update(msg) {
        current = msg;
        process.stderr.write(msg + "\n");
      },
      stop(status, finalMsg) {
        const text = finalMsg || current;
        if (status === "success")
          process.stderr.write(green("✔") + " " + text + "\n");
        else if (status === "fail")
          process.stderr.write(red("✖") + " " + text + "\n");
        else process.stderr.write(text + "\n");
      },
    };
  }

  // Hide cursor
  process.stderr.write("\x1b[?25l");

  const timer = setInterval(() => {
    if (stopped) return;
    const f = frames[frame % frames.length];
    frame++;
    process.stderr.write(`\r${cyan(f)} ${current}  `);
  }, interval);

  // Allow process to exit even if timer is still running
  timer.unref();

  function cleanup(status, finalMsg) {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    // Clear current line and show cursor
    process.stderr.write("\r\x1b[K");
    process.stderr.write("\x1b[?25h");

    const text = finalMsg || current;
    if (status === "success") {
      process.stderr.write(green("✔") + " " + text + "\n");
    } else if (status === "fail") {
      process.stderr.write(red("✖") + " " + text + "\n");
    } else if (status === "warn") {
      process.stderr.write(yellow("⚠") + " " + text + "\n");
    } else if (text) {
      process.stderr.write(text + "\n");
    }
  }

  // SIGINT: clean up before exit so cursor is restored
  const sigintHandler = () => {
    cleanup(null, "");
    process.removeListener("SIGINT", sigintHandler);
    process.kill(process.pid, "SIGINT");
  };
  process.once("SIGINT", sigintHandler);

  return {
    /**
     * Update the spinner message.
     * @param {string} msg
     */
    update(msg) {
      current = msg;
    },

    /**
     * Stop the spinner.
     * @param {'success'|'fail'|'warn'|null} [status]
     * @param {string} [finalMsg] - Message to show on final line (defaults to current message)
     */
    stop(status = null, finalMsg) {
      process.removeListener("SIGINT", sigintHandler);
      cleanup(status, finalMsg);
    },
  };
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

/**
 * Render a single-line progress bar string.
 *
 * @param {number} current - Items completed
 * @param {number} total   - Total items
 * @param {object} [opts]
 * @param {number}  [opts.width]  - Bar character width (default 20)
 * @param {string}  [opts.label] - Optional label prefix
 * @returns {string} e.g. "  [████████░░░░░░░░░░░░] 8/20 (40%)"
 */
export function progressBar(current, total, { width = 20, label = "" } = {}) {
  const pct = total === 0 ? 1 : Math.min(current / total, 1);
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  const pctStr = `${Math.round(pct * 100)}%`;
  const counts = `${current}/${total}`;
  const prefix = label ? `${label} ` : "";
  return `${prefix}[${USE_ANSI ? cyan(bar) : bar}] ${counts} (${pctStr})`;
}

/**
 * Create a live progress bar that updates in-place on stderr.
 *
 * @param {number} total
 * @param {object} [opts]
 * @returns {{ tick(n?: number, msg?: string): void, done(msg?: string): void }}
 */
export function createProgressBar(total, opts = {}) {
  let current = 0;
  let started = false;

  function render(msg) {
    const bar = progressBar(current, total, opts);
    const suffix = msg ? `  ${dim(msg)}` : "";
    if (USE_ANSI && process.stderr.isTTY) {
      process.stderr.write(`\r${bar}${suffix}  `);
    } else {
      process.stderr.write(bar + suffix + "\n");
    }
  }

  return {
    tick(n = 1, msg) {
      current = Math.min(current + n, total);
      render(msg);
      started = true;
    },
    done(msg) {
      current = total;
      if (started && USE_ANSI && process.stderr.isTTY) {
        process.stderr.write("\r\x1b[K"); // clear line
      }
      const bar = progressBar(total, total, opts);
      const suffix = msg ? `  ${msg}` : "";
      process.stderr.write(bar + suffix + "\n");
    },
  };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/**
 * Create a readline interface for stdin prompt.
 * Callers must guard with `process.stdin.isTTY` before invoking.
 */
function makeRl() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

/**
 * Ask a yes/no question.
 *
 * @param {string} message
 * @param {boolean} [defaultValue=false]
 * @returns {Promise<boolean>}
 */
export function confirm(message, defaultValue = false) {
  if (!process.stdin.isTTY) return Promise.resolve(defaultValue);

  const hint = defaultValue ? "(Y/n)" : "(y/N)";
  const rl = makeRl();

  return new Promise((resolve) => {
    rl.question(`${cyan("?")} ${message} ${dim(hint)} `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === "") resolve(defaultValue);
      else resolve(a === "y" || a === "yes");
    });
  });
}

/**
 * Ask for text input.
 *
 * @param {string} message
 * @param {string} [defaultValue=""]
 * @returns {Promise<string>}
 */
export function input(message, defaultValue = "") {
  if (!process.stdin.isTTY) return Promise.resolve(defaultValue);

  const hint = defaultValue ? ` ${dim(`(${defaultValue})`)}` : "";
  const rl = makeRl();

  return new Promise((resolve) => {
    rl.question(`${cyan("?")} ${message}${hint} `, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed === "" ? defaultValue : trimmed);
    });
  });
}

/**
 * Single-selection list with arrow-key navigation.
 *
 * @param {string} message
 * @param {Array<string|{label:string, value:any}>} choices
 * @param {object} [opts]
 * @param {number} [opts.initialIndex=0]
 * @returns {Promise<any>} The selected value (or choice string if choices are strings)
 */
export function select(message, choices, { initialIndex = 0 } = {}) {
  if (choices.length === 0) return Promise.resolve(undefined);
  if (!process.stdin.isTTY) {
    // Non-TTY: return first choice value
    const first = choices[0];
    return Promise.resolve(typeof first === "object" ? first.value : first);
  }

  const items = choices.map((c) =>
    typeof c === "object" ? c : { label: String(c), value: c },
  );

  return new Promise((resolve) => {
    let idx = Math.min(initialIndex, items.length - 1);

    function render() {
      // Move cursor up to redraw list if not first render
      const lines = items.length + 1;
      if (render._rendered) {
        process.stdout.write(`\x1b[${lines}A`);
      }
      render._rendered = true;

      const header = `${cyan("?")} ${message}\n`;
      const body = items
        .map((item, i) => {
          const pointer = i === idx ? cyan("›") : " ";
          const text = i === idx ? bold(item.label) : item.label;
          return `  ${pointer} ${text}`;
        })
        .join("\n");
      process.stdout.write(header + body + "\n");
    }

    render._rendered = false;
    render();

    // Enter raw mode
    const wasRaw = process.stdin.isRaw;
    try {
      process.stdin.setRawMode(true);
    } catch {
      // Terminal doesn't support raw mode
      resolve(items[idx].value);
      return;
    }
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");

    function cleanup(value) {
      try {
        process.stdin.setRawMode(wasRaw || false);
      } catch {
        /* ignore */
      }
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      // Clear the rendered list and show final selection
      process.stdout.write(`\x1b[${items.length + 1}A\x1b[J`);
      process.stdout.write(
        `${cyan("✔")} ${message}: ${bold(items[idx].label)}\n`,
      );
      resolve(value);
    }

    function onData(key) {
      if (key === "\u0003") {
        // Ctrl+C
        cleanup(null);
        process.exit(130);
      } else if (key === "\u001b[A" || key === "k") {
        // Up arrow
        idx = (idx - 1 + items.length) % items.length;
        render();
      } else if (key === "\u001b[B" || key === "j") {
        // Down arrow
        idx = (idx + 1) % items.length;
        render();
      } else if (key === "\r" || key === "\n") {
        cleanup(items[idx].value);
      }
    }

    process.stdin.on("data", onData);
  });
}

/**
 * Multi-selection list with Space to toggle, Enter to confirm.
 *
 * @param {string} message
 * @param {Array<string|{label:string, value:any}>} choices
 * @param {object} [opts]
 * @param {number[]} [opts.initialSelected=[]] - Indices to pre-select
 * @returns {Promise<any[]>} Array of selected values
 */
export function multiSelect(message, choices, { initialSelected = [] } = {}) {
  if (choices.length === 0) return Promise.resolve([]);
  if (!process.stdin.isTTY) {
    // Non-TTY: return pre-selected values or empty array
    const items = choices.map((c) =>
      typeof c === "object" ? c : { label: String(c), value: c },
    );
    return Promise.resolve(
      initialSelected.map((i) => items[i]?.value).filter(Boolean),
    );
  }

  const items = choices.map((c) =>
    typeof c === "object" ? c : { label: String(c), value: c },
  );

  return new Promise((resolve) => {
    let idx = 0;
    const selected = new Set(initialSelected);

    function render() {
      const lines = items.length + 2; // header + items + hint
      if (render._rendered) {
        process.stdout.write(`\x1b[${lines}A`);
      }
      render._rendered = true;

      const header = `${cyan("?")} ${message} ${dim("(Space to toggle, Enter to confirm)")}\n`;
      const body = items
        .map((item, i) => {
          const pointer = i === idx ? cyan("›") : " ";
          const checkbox = selected.has(i) ? cyan("◉") : "○";
          const text = i === idx ? bold(item.label) : item.label;
          return `  ${pointer} ${checkbox} ${text}`;
        })
        .join("\n");
      const hint = `\n  ${dim(`${selected.size} selected`)}`;
      process.stdout.write(header + body + hint + "\n");
    }

    render._rendered = false;
    render();

    const wasRaw = process.stdin.isRaw;
    try {
      process.stdin.setRawMode(true);
    } catch {
      resolve([]);
      return;
    }
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");

    function cleanup() {
      try {
        process.stdin.setRawMode(wasRaw || false);
      } catch {
        /* ignore */
      }
      process.stdin.pause();
      process.stdin.removeListener("data", onData);

      const selectedValues = items
        .filter((_, i) => selected.has(i))
        .map((item) => item.value);

      const selectedLabels = items
        .filter((_, i) => selected.has(i))
        .map((item) => item.label)
        .join(", ");

      const lines = items.length + 2;
      process.stdout.write(`\x1b[${lines}A\x1b[J`);
      process.stdout.write(
        `${cyan("✔")} ${message}: ${bold(selectedLabels || "(none)")}\n`,
      );
      resolve(selectedValues);
    }

    function onData(key) {
      if (key === "\u0003") {
        cleanup();
        process.exit(130);
      } else if (key === "\u001b[A" || key === "k") {
        idx = (idx - 1 + items.length) % items.length;
        render();
      } else if (key === "\u001b[B" || key === "j") {
        idx = (idx + 1) % items.length;
        render();
      } else if (key === " ") {
        if (selected.has(idx)) selected.delete(idx);
        else selected.add(idx);
        render();
      } else if (key === "\r" || key === "\n") {
        cleanup();
      }
    }

    process.stdin.on("data", onData);
  });
}

// ---------------------------------------------------------------------------
// Step renderer
// ---------------------------------------------------------------------------

/** Valid step statuses */
const STEP_STATUS = {
  pending: dim("○"),
  active: cyan("●"),
  done: green("✔"),
  failed: red("✖"),
  skipped: dim("—"),
};

/**
 * Render a numbered step header.
 *
 * @param {number} current    - Current step number (1-based)
 * @param {number} total      - Total steps
 * @param {string} label      - Step description
 * @param {'pending'|'active'|'done'|'failed'|'skipped'} [status='active']
 * @returns {string} Formatted step header (no trailing newline)
 *
 * @remarks
 * **NO_COLOR behavior**: When \`NO_COLOR\` is set, ANSI color and style codes are
 * suppressed, but the Unicode status symbols (●, ✔, ✖, ○, —) remain in the
 * output. This is correct per the NO_COLOR specification
 * (https://no-color.org/), which only covers ANSI escape codes — not Unicode
 * characters. Callers that require fully plain-text output must substitute
 * their own ASCII symbols.
 */
export function stepHeader(current, total, label, status = "active") {
  const icon = STEP_STATUS[status] || STEP_STATUS.active;
  const counter = dim(`Step ${current} of ${total}`);
  const dash = dim(" — ");
  const name =
    status === "done" ? dim(label) : status === "active" ? bold(label) : label;
  return `${icon}  ${counter}${dash}${name}`;
}

// ---------------------------------------------------------------------------
// Table renderer
// ---------------------------------------------------------------------------

/**
 * Render a column-aligned table.
 *
 * @param {string[][]} rows     - 2D array of strings; first row is the header
 * @param {object} [opts]
 * @param {boolean} [opts.header=true]    - Treat first row as header (bold + underline + separator)
 * @param {number}  [opts.padding=2]      - Column padding (spaces between columns)
 * @param {string}  [opts.separator="─"]  - Separator line character
 * @returns {string} Rendered table string (includes trailing newline)
 */
export function table(
  rows,
  { header = true, padding = 2, separator = "─" } = {},
) {
  if (!rows || rows.length === 0) return "";

  // Compute column widths
  const colCount = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: colCount }, (_, c) =>
    Math.max(...rows.map((r) => (r[c] ? stripAnsi(String(r[c])).length : 0))),
  );

  function renderRow(row, isHeader) {
    return row
      .map((cell, c) => {
        const text = String(cell ?? "");
        const visual = stripAnsi(text).length;
        const spaces = " ".repeat(Math.max(0, widths[c] - visual));
        const formatted = isHeader ? bold(underline(text)) : text;
        const pad = c < row.length - 1 ? spaces + " ".repeat(padding) : spaces;
        return formatted + pad;
      })
      .join("")
      .trimEnd();
  }

  const lines = [];
  rows.forEach((row, i) => {
    if (i === 0 && header) {
      lines.push(renderRow(row, true));
      const sepLine = widths.reduce((w, c, ci) => {
        return (
          w +
          separator.repeat(c) +
          (ci < widths.length - 1 ? " ".repeat(padding) : "")
        );
      }, "");
      lines.push(dim(sepLine));
    } else {
      lines.push(renderRow(row, false));
    }
  });

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// ANSI string utilities (exported for testing)
// ---------------------------------------------------------------------------

/** Strip all ANSI CSI sequences from a string, returning only visible text. */
export function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * Truncate an ANSI-decorated string to at most `maxWidth` visible characters,
 * never bisecting an escape sequence.
 *
 * Tokens from the cut region are suppressed — only ANSI tokens encountered
 * while the visible budget is still live are forwarded to the output.
 * A trailing reset (\x1b[0m) is appended when truncation occurs and the
 * result already contains ANSI sequences, preventing color bleed into
 * adjacent columns.
 */
export function truncateVisible(str, maxWidth) {
  const ansiRe = /\x1b\[[0-9;]*[A-Za-z]/g;
  let visible = 0;
  let result = "";
  let lastIndex = 0;
  let m;
  ansiRe.lastIndex = 0;
  while ((m = ansiRe.exec(str)) !== null) {
    // Consume plain-text chars before this ANSI token
    const plain = str.slice(lastIndex, m.index);
    const remaining = maxWidth - visible;
    if (remaining > 0) {
      result += plain.slice(0, remaining);
      visible += Math.min(plain.length, remaining);
    }
    // Only include the ANSI token while the visible budget is not yet exhausted.
    // Once the cut point is reached, tokens from the removed region are suppressed;
    // the post-loop reset guard below handles color-state cleanup.
    if (visible < maxWidth) {
      result += m[0];
    }
    lastIndex = ansiRe.lastIndex;
  }
  // Remaining plain text after last ANSI token
  const remaining = maxWidth - visible;
  if (remaining > 0) {
    result += str.slice(lastIndex, lastIndex + remaining);
  }
  // If truncation occurred (or visible length exactly equals maxWidth) and the
  // result contains any ANSI sequences, append a full reset to prevent color from
  // bleeding into adjacent columns.  The guard uses >= rather than > to cover the
  // exact-boundary case: when visible === maxWidth the loop guard (visible < maxWidth)
  // suppresses the original trailing RESET token, so the post-loop guard must fire
  // to close any open sequences.  Inputs shorter than maxWidth are unaffected because
  // stripAnsi(str).length < maxWidth makes the condition false.
  if (stripAnsi(str).length >= maxWidth && result.includes("\x1b[")) {
    result += "\x1b[0m";
  }
  return result;
}

// ---------------------------------------------------------------------------
// Annotated Review Screen
// ---------------------------------------------------------------------------

/**
 * Confidence badge — returns a short colored indicator string.
 * Uses function wrappers (not raw ANSI constants) so NO_COLOR is respected.
 *
 * @param {'high'|'medium'|'low'} confidence
 * @returns {string}
 */
function confidenceBadge(confidence) {
  switch (confidence) {
    case "high":
      return green("[high]");
    case "medium":
      return yellow("[med] ");
    case "low":
      return red("[low] ");
    default:
      return dim("[???] ");
  }
}

/**
 * All ConfigDraft fields in display order with their human-readable labels
 * and the forge.yaml key used for TODO comments.
 */
const REVIEW_FIELDS = [
  { key: "owner",         label: "GitHub Owner",       section: "project",  draftPath: ["project", "owner"] },
  { key: "repo",          label: "Repository Name",    section: "project",  draftPath: ["project", "repo"] },
  { key: "name",          label: "Project Name",       section: "project",  draftPath: ["project", "name"] },
  { key: "description",   label: "Description",        section: "project",  draftPath: null },
  { key: "root",          label: "Repository Root",    section: "paths",    draftPath: ["paths", "root"] },
  { key: "worktreeBase",  label: "Worktree Base",      section: "paths",    draftPath: ["paths", "worktreeBase"] },
  { key: "defaultBranch", label: "Default Branch",     section: "branches", draftPath: ["branches", "default"] },
  { key: "stagingBranch", label: "Staging Branch",     section: "branches", draftPath: ["branches", "staging"] },
];

/**
 * Render the annotated review screen for a ConfigDraft.
 *
 * Shows every required forge.yaml field with its detected value, confidence
 * badge, source, and a plain-language "why" explanation. The user presses
 * Enter to accept all values, or types a field number to edit that field
 * inline. Fields with low confidence are flagged — the caller can use the
 * returned metadata to inject \`# TODO(forgedock:<field>)\` YAML comments.
 *
 * @param {import('./init-detect.mjs').ConfigDraft} draft
 *   The ConfigDraft returned by detectConfig().
 * @param {object} [opts]
 * @param {boolean} [opts.hasExistingConfig=false]
 *   When true, shows a "diff-style" header noting an existing forge.yaml will
 *   be overwritten.
 * @param {string} [opts.existingContent=""]
 *   Serialized content of the existing forge.yaml for diff context display.
 * @param {boolean} [opts.showSources=false]
 *   When true (e.g. \`--verbose\` mode), renders the Notes/why block for ALL
 *   fields — including high-confidence ones — so the user can see every
 *   detection source and reasoning string.
 *
 * @returns {Promise<{
 *   owner:         string,
 *   repo:          string,
 *   name:          string,
 *   description:   string,
 *   root:          string,
 *   worktreeBase:  string,
 *   defaultBranch: string,
 *   stagingBranch: string,
 *   lowConfidenceKeys: string[],
 * }>}
 * Resolves with the accepted (or edited) values, plus the list of field keys
 * that had low confidence at the time of the screen render (so the caller can
 * inject TODO comments).
 */
export async function annotatedReviewScreen(
  draft,
  { hasExistingConfig = false, existingContent = "", showSources = false } = {},
) {
  // Helper — pull a field from the draft by path, or return a low-confidence placeholder.
  function getField(draftPath) {
    if (!draftPath) return { value: "", confidence: "low", source: "none", why: "Not auto-detected" };
    let node = draft;
    for (const key of draftPath) {
      if (node && typeof node === "object" && key in node) {
        node = node[key];
      } else {
        return { value: "", confidence: "low", source: "none", why: "Not auto-detected" };
      }
    }
    if (node && typeof node === "object" && "value" in node) return node;
    return { value: "", confidence: "low", source: "none", why: "Not auto-detected" };
  }

  // Build the mutable values map (starts from draft detections).
  // Description is not part of ConfigDraft — always starts empty with low confidence.
  const values = {};
  const confidences = {};
  const sources = {};
  const whys = {};

  for (const fd of REVIEW_FIELDS) {
    const field = getField(fd.draftPath);
    values[fd.key] = field.value;
    confidences[fd.key] = field.confidence;
    sources[fd.key] = field.source;
    whys[fd.key] = field.why;
  }

  // Non-TTY: return detect values directly without interaction.
  if (!process.stdin.isTTY) {
    return {
      ...values,
      lowConfidenceKeys: REVIEW_FIELDS.filter(
        (fd) => confidences[fd.key] === "low",
      ).map((fd) => fd.key),
    };
  }

  // Pad an ANSI-decorated string to `width` visible characters.
  function padVisible(str, width) {
    const visual = stripAnsi(str).length;
    return str + " ".repeat(Math.max(0, width - visual));
  }

  // ── Render the annotated table ────────────────────────────────────────────
  function renderScreen() {
    process.stdout.write("\n");

    if (hasExistingConfig) {
      process.stdout.write(
        box(
          [
            "",
            `  ${yellow("forge.yaml already exists.")} The values below will ${bold("overwrite")} it.`,
            `  ${dim("A backup will be created before writing.")}`,
            "",
          ],
          { title: "Overwrite Mode" },
        ),
      );
    }

    // Header
    process.stdout.write(
      `${bold("  forge.yaml configuration")}  ${dim("(detected from this repository)")}\n\n`,
    );

    // Table header
    const NUM_W = 3;
    const KEY_W = 16;
    const VAL_W = 36;
    const BADGE_W = 7; // "[high]" + space = 7 visible chars
    const SOURCE_W = 32;

    const hdr = [
      dim("#".padEnd(NUM_W)),
      dim("Field".padEnd(KEY_W)),
      dim("Value".padEnd(VAL_W)),
      dim("Conf".padEnd(BADGE_W)),
      dim("Source"),
    ].join("  ");
    process.stdout.write("  " + hdr + "\n");
    process.stdout.write(
      "  " +
        dim("─".repeat(NUM_W + KEY_W + VAL_W + BADGE_W + SOURCE_W + 8)) +
        "\n",
    );

    for (let i = 0; i < REVIEW_FIELDS.length; i++) {
      const fd = REVIEW_FIELDS[i];
      const num = dim(String(i + 1).padEnd(NUM_W));
      const key = fd.label.padEnd(KEY_W);
      const rawVal = values[fd.key] || dim("(empty)");
      // Pad/truncate on visible width only — ANSI escape bytes must not be counted.
      const displayVal = stripAnsi(rawVal).length > VAL_W
        ? truncateVisible(rawVal, VAL_W - 1) + dim("…")
        : padVisible(rawVal, VAL_W);
      const badge = confidenceBadge(confidences[fd.key]);
      // Truncate long source strings
      const rawSrc = sources[fd.key] || "";
      const displaySrc = rawSrc.length > SOURCE_W
        ? rawSrc.slice(0, SOURCE_W - 1) + "…"
        : rawSrc;

      process.stdout.write(
        `  ${num}  ${key}  ${displayVal}  ${badge}  ${dim(displaySrc)}\n`,
      );
    }

    process.stdout.write("\n");

    // Legend
    process.stdout.write(
      `  ${dim("Confidence:")}  ${green("[high]")} detected  ${yellow("[med] ")} inferred  ${red("[low] ")} guessed\n`,
    );
    process.stdout.write("\n");

    // Why summary for non-high fields (or ALL fields when showSources is enabled)
    const interestingFields = REVIEW_FIELDS.filter(
      (fd) => (confidences[fd.key] !== "high" || showSources) && whys[fd.key],
    );
    if (interestingFields.length > 0) {
      process.stdout.write(`  ${bold("Notes:")}\n`);
      for (const fd of interestingFields) {
        const badge = confidenceBadge(confidences[fd.key]);
        process.stdout.write(
          `    ${badge}  ${bold(fd.label)}: ${dim(whys[fd.key])}\n`,
        );
      }
      process.stdout.write("\n");
    }

    // TODO flag notice for low-confidence fields — derived live so it
    // reflects any confidence promotions from interactive edits.
    const liveLowKeys = REVIEW_FIELDS.filter(
      (fd) => confidences[fd.key] === "low",
    );
    if (liveLowKeys.length > 0) {
      const todoNames = liveLowKeys.map((fd) => fd.label).join(", ");
      process.stdout.write(
        `  ${red("⚠")}  ${bold("Low-confidence fields")} will be written with a ${cyan("# TODO(forgedock:<field>)")} comment:\n`,
      );
      process.stdout.write(`     ${dim(todoNames)}\n\n`);
    }

    process.stdout.write(
      `  ${dim("Press")} ${bold("Enter")} ${dim("to accept all values, or enter a field number to edit it.")}\n\n`,
    );
  }

  // ── Inline editor for a single field ─────────────────────────────────────
  async function editField(index) {
    const fd = REVIEW_FIELDS[index];
    const current = values[fd.key];

    // We need to temporarily use readline (cooked mode input).
    // Exit raw mode first if it was active.
    let wasRaw = false;
    if (process.stdin.isRaw) {
      try {
        process.stdin.setRawMode(false);
        wasRaw = true;
      } catch {
        /* ignore */
      }
    }
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const hint = current ? ` ${dim(`(current: ${current})`)}` : "";
    const newValue = await new Promise((resolve) => {
      rl.question(
        `  ${cyan("?")} ${bold(fd.label)}${hint}: `,
        (answer) => {
          rl.close();
          resolve(answer.trim() === "" ? current : answer.trim());
        },
      );
    });

    // Restore raw mode if it was active.
    if (wasRaw) {
      try {
        process.stdin.setRawMode(true);
      } catch {
        /* ignore */
      }
    }

    // Mark as user-edited (medium confidence).
    values[fd.key] = newValue;
    if (confidences[fd.key] !== "high") {
      confidences[fd.key] = "medium";
      sources[fd.key] = "user input";
      whys[fd.key] = "Edited interactively during review";
    }
  }

  // ── Interaction loop ──────────────────────────────────────────────────────
  renderScreen();

  // Set up raw mode for single-keypress interaction.
  const wasRaw = process.stdin.isRaw;
  try {
    process.stdin.setRawMode(true);
  } catch {
    // Terminal doesn't support raw mode — fall back to accept-all.
    return {
      ...values,
      lowConfidenceKeys: REVIEW_FIELDS.filter(
        (fd) => confidences[fd.key] === "low",
      ).map((fd) => fd.key),
    };
  }
  process.stdin.resume();
  process.stdin.setEncoding("utf-8");

  let accepted = false;

  // Buffer for multi-character field number input (1–8 fields).
  let inputBuffer = "";

  const sigintHandler = () => {
    try {
      process.stdin.setRawMode(wasRaw || false);
    } catch {
      /* ignore */
    }
    process.stdin.pause();
    process.stdin.removeAllListeners("data");
    if (process.stdout.isTTY) process.stdout.write("\x1b[?25h");
    process.exit(130);
  };
  process.once("SIGINT", sigintHandler);

  await new Promise((resolve) => {
    function onData(key) {
      if (key === "") {
        // Ctrl+C
        sigintHandler();
        return;
      }

      if (key === "\r" || key === "\n") {
        // Enter with no pending number → accept all
        if (inputBuffer === "") {
          accepted = true;
          cleanup();
          resolve();
          return;
        }
        // Enter after typing a number → edit that field
        const num = parseInt(inputBuffer, 10);
        inputBuffer = "";
        if (num >= 1 && num <= REVIEW_FIELDS.length) {
          cleanup();
          editField(num - 1).then(() => {
            // Re-render and re-enter interaction loop
            renderScreen();
            try {
              process.stdin.setRawMode(true);
            } catch {
              accepted = true;
              resolve();
              return;
            }
            process.stdin.resume();
            process.stdin.setEncoding("utf-8");
            process.stdin.on("data", onData);
          });
        } else {
          // Invalid number — ignore
          process.stdout.write(
            `  ${red("Invalid field number")} — enter 1–${REVIEW_FIELDS.length} or press Enter to accept.\n`,
          );
        }
        return;
      }

      // Digit key — accumulate field number
      if (/^[0-9]$/.test(key)) {
        inputBuffer += key;
        process.stdout.write(key); // echo digit
        return;
      }

      // Backspace
      if (key === "" || key === "") {
        if (inputBuffer.length > 0) {
          inputBuffer = inputBuffer.slice(0, -1);
          process.stdout.write(" "); // erase char
        }
        return;
      }

      // Any other key — ignore
    }

    function cleanup() {
      try {
        process.stdin.setRawMode(wasRaw || false);
      } catch {
        /* ignore */
      }
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.removeListener("SIGINT", sigintHandler);
    }

    process.stdin.on("data", onData);
  });

  if (accepted) {
    process.stdout.write(
      `\n  ${green("✔")} ${bold("All values accepted.")}\n\n`,
    );
  }

  return {
    ...values,
    lowConfidenceKeys: REVIEW_FIELDS.filter(
      (fd) => confidences[fd.key] === "low",
    ).map((fd) => fd.key),
  };
}

// ---------------------------------------------------------------------------
// runSteps — live-checklist orchestrator
// ---------------------------------------------------------------------------

/**
 * Run an ordered list of async steps and render a live animated checklist.
 *
 * @param {Array<{label: string, run: (step: StepAPI) => Promise<void>}>} steps
 *   Each entry has a human-readable `label` and an async `run` function that
 *   receives a {@link StepAPI} object.
 *
 * @param {object} [opts]
 * @param {NodeJS.WritableStream} [opts.stream=process.stderr]
 *   Output stream. Defaults to stderr (consistent with spinner / progressBar).
 * @param {number} [opts.spinnerInterval=80]
 *   Braille frame interval in milliseconds (TTY only).
 * @param {boolean} [opts._forceNoAnsi]
 *   Internal override for testing: treat output as non-TTY / no-ANSI regardless
 *   of the runtime environment.
 *
 * @returns {Promise<RunStepsResult>}
 *
 * @typedef {{
 *   progress(current: number, total: number): void,
 *   note(text: string): void,
 *   skip(reason?: string): void,
 * }} StepAPI
 *
 * @typedef {{
 *   ok: true,
 *   elapsed: number,
 * } | {
 *   ok: false,
 *   failedStep: number,
 *   error: Error,
 *   elapsed: number,
 * }} RunStepsResult
 */
export async function runSteps(steps, opts = {}) {
  const {
    stream = process.stderr,
    spinnerInterval = 80,
    _forceNoAnsi = false,
  } = opts;

  const t0 = Date.now();
  const count = steps.length;

  // ── Helper: format elapsed seconds to 1 dp ────────────────────────────────
  function elapsedStr() {
    return ((Date.now() - t0) / 1000).toFixed(1) + "s";
  }

  // ── Non-TTY / no-ANSI path ─────────────────────────────────────────────────
  const useAnsi = !_forceNoAnsi && USE_ANSI && stream.isTTY;

  if (!useAnsi) {
    for (let i = 0; i < count; i++) {
      const step = steps[i];
      let skipped = false;
      let skipReason = "";

      const stepApi = {
        progress(_current, _total) {
          // No-op in non-TTY mode
        },
        note(_text) {
          // No-op in non-TTY mode
        },
        skip(reason = "") {
          skipped = true;
          skipReason = reason;
        },
      };

      try {
        await step.run(stepApi);
      } catch (err) {
        const elapsed = elapsedStr();
        stream.write(`✖ ${step.label} — ${err.message}\n`);
        stream.write(`✖ Failed in ${elapsed}\n`);
        return { ok: false, failedStep: i, error: err, elapsed: Date.now() - t0 };
      }

      if (skipped) {
        const suffix = skipReason ? ` — ${skipReason}` : "";
        stream.write(`— ${step.label}${suffix}\n`);
      } else {
        stream.write(`✔ ${step.label}\n`);
      }
    }

    const elapsed = elapsedStr();
    stream.write(`✔ Done in ${elapsed}\n`);
    return { ok: true, elapsed: Date.now() - t0 };
  }

  // ── TTY / ANSI path ────────────────────────────────────────────────────────

  // Track per-step state
  const statuses = steps.map(() => "pending"); // 'pending'|'active'|'done'|'failed'|'skipped'
  const annotations = steps.map(() => ""); // inline note or progress bar string

  // Render a single step row (no newline — caller moves cursor)
  function renderRow(i) {
    const status = statuses[i];
    const icon =
      status === "pending"  ? dim("○") :
      status === "done"     ? green("✔") :
      status === "failed"   ? red("✖") :
      status === "skipped"  ? dim("—") :
      /* active spinner handled separately */ dim("○");
    const label =
      status === "done" || status === "skipped" ? dim(steps[i].label) :
      status === "failed"                       ? red(steps[i].label) :
      steps[i].label;
    const ann = annotations[i] ? `  ${dim(annotations[i])}` : "";
    return `${icon}  ${label}${ann}`;
  }

  // Print all rows initially (pending)
  for (let i = 0; i < count; i++) {
    stream.write(renderRow(i) + "\n");
  }

  // Hide cursor
  stream.write("\x1b[?25l");

  let cursorAtBottom = true; // after the last row

  // Move cursor up N rows (relative)
  function cursorUp(n) {
    if (n > 0) stream.write(`\x1b[${n}A`);
  }

  // Move cursor back to the bottom (below all rows)
  function cursorToBottom() {
    if (!cursorAtBottom) {
      // We're somewhere in the middle; go to end
      stream.write(`\x1b[${count}B`);
      cursorAtBottom = true;
    }
  }

  // Rewrite a single row in-place (cursor must be on that row already)
  function overwriteRow(i) {
    stream.write(`\r\x1b[K${renderRow(i)}`);
  }

  let result;

  try {
    for (let i = 0; i < count; i++) {
      statuses[i] = "active";
      annotations[i] = "";

      // Move cursor up from bottom to row i, overwrite, return to bottom
      const rowsFromBottom = count - i; // rows below row i (including row i itself)
      cursorUp(rowsFromBottom);
      cursorAtBottom = false;

      let frame = 0;
      let currentProgressBar = "";
      let currentNote = "";

      // Draw the active spinner frame
      function drawActive() {
        const f = BRAILLE_FRAMES[frame % BRAILLE_FRAMES.length];
        frame++;
        const label = bold(steps[i].label);
        const ann = (currentProgressBar || currentNote)
          ? `  ${dim(currentProgressBar || currentNote)}`
          : "";
        stream.write(`\r\x1b[K${cyan(f)}  ${label}${ann}`);
      }

      drawActive();

      // Move back to bottom (the empty line AFTER the last step row).
      // drawActive() leaves the cursor on row i with no trailing newline,
      // so we need rowsFromBottom (not -1) to reach the line below row count-1.
      if (rowsFromBottom > 0) stream.write(`\x1b[${rowsFromBottom}B`);
      cursorAtBottom = true;

      // Spinner interval updates row i in-place
      const timer = setInterval(() => {
        cursorUp(rowsFromBottom);
        drawActive();
        if (rowsFromBottom > 0) stream.write(`\x1b[${rowsFromBottom}B`);
      }, spinnerInterval);
      timer.unref();

      let skipped = false;
      let skipReason = "";

      const stepApi = {
        progress(current, total) {
          currentProgressBar = progressBar(current, total, { width: 12 });
          currentNote = "";
        },
        note(text) {
          currentNote = text;
          currentProgressBar = "";
        },
        skip(reason = "") {
          skipped = true;
          skipReason = reason;
        },
      };

      let stepError = null;
      try {
        await steps[i].run(stepApi);
      } catch (err) {
        stepError = err;
      }

      clearInterval(timer);

      // Final state for this step
      if (stepError) {
        statuses[i] = "failed";
        annotations[i] = stepError.message;
      } else if (skipped) {
        statuses[i] = "skipped";
        annotations[i] = skipReason;
      } else {
        statuses[i] = "done";
        annotations[i] = "";
      }

      // Redraw final state for row i
      cursorUp(rowsFromBottom);
      cursorAtBottom = false;
      overwriteRow(i);
      stream.write("\n");
      // After the \n, cursor is on row i+1. Distance to bottom = rowsFromBottom - 1.
      const rowsBelowAfterNl = rowsFromBottom - 1;
      if (rowsBelowAfterNl > 0) stream.write(`\x1b[${rowsBelowAfterNl}B`);
      cursorAtBottom = true;

      if (stepError) {
        // Failure: stop run
        result = { ok: false, failedStep: i, error: stepError, elapsed: Date.now() - t0 };
        break;
      }
    }
  } finally {
    // Always restore cursor
    stream.write("\x1b[?25h");
  }

  const elapsed = elapsedStr();

  if (result) {
    // Failed
    stream.write(`\r\x1b[K${red("✖")} ${dim("Failed in")} ${elapsed}\n`);
    return result;
  }

  stream.write(`\r\x1b[K${green("✔")} ${dim("Done in")} ${elapsed}\n`);
  return { ok: true, elapsed: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// Logo rendering — ForgeDock F-monogram in half-block ANSI art
// ---------------------------------------------------------------------------

/**
 * Truecolor detection — distinct from USE_ANSI (which only checks for any ANSI support).
 * Half-block art requires 24-bit color for the RGB fg/bg per-cell approach.
 * Falls back to plain text on 256-color or less terminals.
 */
const USE_TRUECOLOR =
  USE_ANSI &&
  (process.env.COLORTERM === "truecolor" ||
    process.env.COLORTERM === "24bit" ||
    // Windows Terminal sets WT_SESSION but not always COLORTERM
    !!process.env.WT_SESSION ||
    process.env.TERM_PROGRAM === "iTerm.app" ||
    process.env.TERM_PROGRAM === "vscode" ||
    process.env.TERM_PROGRAM === "WezTerm" ||
    process.env.TERM_PROGRAM === "Hyper" ||
    // Ghostty, Alacritty, kitty — modern GPU-accelerated terminals
    process.env.TERM_PROGRAM === "ghostty" ||
    process.env.TERM === "xterm-kitty");

/**
 * Angular F-monogram pixel map — hand-crafted to match the ForgeDock brand mark.
 *
 * The logo is two forward-leaning parallelogram strokes forming an F:
 * - Upper arm: sweeps diagonally from center-left to upper-right
 * - Lower arm: shorter, sweeps from lower-left to center
 * - Vertical stem continues below
 *
 * 16 columns × 16 rows → 16 wide × 8 terminal rows (half-block pairs).
 * 1 = filled pixel, 0 = transparent (uses terminal default background).
 */
// prettier-ignore
const LOGO_PIXELS = [
  //0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5
  [0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,0],  //  0: tip of upper arm
  [0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,0],  //  1
  [0,0,0,0,0,0,1,1,1,1,1,1,1,1,0,0],  //  2
  [0,0,0,0,0,1,1,1,1,1,1,1,1,0,0,0],  //  3
  [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],  //  4
  [0,0,0,1,1,1,1,1,0,0,0,0,0,0,0,0],  //  5: bend to stem
  [0,0,1,1,1,1,0,0,0,0,0,0,0,0,0,0],  //  6: gap
  [0,0,1,1,1,0,0,0,0,0,0,0,0,0,0,0],  //  7: stem
  [0,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0],  //  8: middle arm top
  [0,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0],  //  9
  [1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0],  // 10
  [1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0],  // 11: bend back to stem
  [1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0],  // 12: stem
  [1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0],  // 13
  [1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0],  // 14
  [1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0],  // 15
];

/**
 * Gradient palette for the F-monogram — interpolates from bright ice-blue
 * at the top to deep ocean-blue at the bottom, creating a metallic sheen.
 *
 * Each entry is [R, G, B] for the corresponding pixel row pair.
 */
const LOGO_GRADIENT = [
  [150, 215, 255],  // rows  0-1: ice blue (highlight)
  [130, 200, 255],  // rows  2-3
  [110, 185, 255],  // rows  4-5
  [88, 166, 255],   // rows  6-7: brand blue
  [75, 150, 245],   // rows  8-9
  [60, 130, 230],   // rows 10-11
  [45, 110, 210],   // rows 12-13
  [35, 95, 190],    // rows 14-15: deep blue
];

/**
 * Render the F-monogram as half-block art with per-row gradient colors.
 * Uses transparent background (no bg color set — inherits terminal default).
 *
 * @returns {string[]} Array of ANSI-decorated terminal lines (8 lines)
 */
function renderLogoArt() {
  const RST = "\x1b[0m";
  const lines = [];

  for (let r = 0; r < LOGO_PIXELS.length; r += 2) {
    const top = LOGO_PIXELS[r];
    const bot = LOGO_PIXELS[r + 1];
    const pairIdx = r / 2; // 0..7
    const [tR, tG, tB] = LOGO_GRADIENT[pairIdx];

    // Slightly darker shade for the lower pixel row (depth effect)
    const bR = Math.max(0, tR - 15);
    const bG = Math.max(0, tG - 15);
    const bB = Math.max(0, tB - 15);

    let line = "";
    for (let c = 0; c < top.length; c++) {
      const hasTop = top[c];
      const hasBot = bot[c];

      if (hasTop && hasBot) {
        // Both filled: fg=top color, bg=bot color, print ▀
        line += `\x1b[38;2;${tR};${tG};${tB}m\x1b[48;2;${bR};${bG};${bB}m▀${RST}`;
      } else if (hasTop && !hasBot) {
        // Only top filled: fg=top color, no bg (transparent), print ▀
        line += `\x1b[38;2;${tR};${tG};${tB}m▀${RST}`;
      } else if (!hasTop && hasBot) {
        // Only bottom filled: fg=bot color, no bg, print ▄ (lower half block)
        line += `\x1b[38;2;${bR};${bG};${bB}m▄${RST}`;
      } else {
        // Both empty: space
        line += " ";
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Render text with a horizontal gradient (per-character 24-bit color).
 *
 * @param {string} text
 * @param {[number,number,number]} start - Start RGB
 * @param {[number,number,number]} end - End RGB
 * @returns {string} ANSI-colored string
 */
function gradientText(text, start, end) {
  const RST = "\x1b[0m";
  let result = "\x1b[1m"; // bold
  const len = text.length;
  for (let i = 0; i < len; i++) {
    if (text[i] === " ") {
      result += " ";
      continue;
    }
    const t = len === 1 ? 0 : i / (len - 1);
    const r = Math.round(start[0] + (end[0] - start[0]) * t);
    const g = Math.round(start[1] + (end[1] - start[1]) * t);
    const b = Math.round(start[2] + (end[2] - start[2]) * t);
    result += `\x1b[38;2;${r};${g};${b}m${text[i]}`;
  }
  return result + RST;
}

/**
 * Render the ForgeDock logo for display in the terminal.
 *
 * On truecolor TTY: angular F-monogram with gradient, brand name with gradient
 * text, and tagline — rendered side-by-side (logo left, text right).
 * On non-TTY / NO_COLOR / 256-color: plain text.
 *
 * @param {object} [opts]
 * @param {string} [opts.version]  - Package version string (e.g. "1.0.14")
 * @returns {string} Rendered logo string (may contain ANSI sequences)
 */
export function renderLogo({ version = "" } = {}) {
  const tagline = "GitHub as a knowledge graph for AI agents";
  const versionStr = version ? `ForgeDock · v${version}` : "ForgeDock";

  if (!USE_TRUECOLOR) {
    // Plain text fallback — NO_COLOR, non-TTY, or 256-color terminal
    return `${versionStr}\n${tagline}`;
  }

  // Truecolor: side-by-side layout — logo on left, text on right
  const art = renderLogoArt(); // 8 lines, each 16 chars wide (visible)
  const pad = "  "; // gap between logo and text

  // Text lines to appear to the right of the logo (vertically centered)
  const brandLine = gradientText(
    "FORGEDOCK",
    [150, 215, 255], // ice blue
    [35, 95, 190],   // deep blue
  );
  const versionLine = version
    ? `\x1b[2m\x1b[38;2;88;166;255mv${version}\x1b[0m`
    : "";
  const taglineLine = `\x1b[2m${tagline}\x1b[0m`;

  // Place text starting at row 2 (0-indexed) for vertical centering
  // art has 8 rows; text block occupies rows 2-5
  const textRows = [
    "",           // row 0
    "",           // row 1
    brandLine,    // row 2: FORGEDOCK
    versionLine,  // row 3: v1.0.14
    "",           // row 4
    taglineLine,  // row 5: tagline
    "",           // row 6
    "",           // row 7
  ];

  const lines = [""];
  for (let i = 0; i < art.length; i++) {
    const textPart = textRows[i] || "";
    lines.push(`  ${art[i]}${pad}${textPart}`);
  }
  lines.push("");
  return lines.join("\n");
}
