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

  // Strip ANSI codes to compute visual width
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

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

  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

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

  // Collect keys that started with low confidence (for TODO flag injection).
  const lowConfidenceKeys = REVIEW_FIELDS.filter(
    (fd) => confidences[fd.key] === "low",
  ).map((fd) => fd.key);

  // Non-TTY: return detect values directly without interaction.
  if (!process.stdin.isTTY) {
    return { ...values, lowConfidenceKeys };
  }

  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

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
      // Truncate long values for table display
      const displayVal = stripAnsi(rawVal).length > VAL_W
        ? rawVal.slice(0, VAL_W - 1) + dim("…")
        : rawVal.padEnd(VAL_W - (stripAnsi(rawVal).length < VAL_W ? 0 : 0));
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

    // TODO flag notice for low-confidence fields
    if (lowConfidenceKeys.length > 0) {
      const todoNames = lowConfidenceKeys
        .map((k) => REVIEW_FIELDS.find((f) => f.key === k)?.label ?? k)
        .join(", ");
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
    return { ...values, lowConfidenceKeys };
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

  return { ...values, lowConfidenceKeys };
}
