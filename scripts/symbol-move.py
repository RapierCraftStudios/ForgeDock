#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# symbol-move.py: codemod mover for refactor:split (forge#4210, #4196). Moves groups of top-level symbols out of one
# Python module into a sibling package and leaves a re-export shim at the old path. A CST tool (libcst) copies every
# moved statement byte-for-byte; no LLM, no network, nothing is retyped.
#
# Usage: python3 scripts/symbol-move.py --src <file.py> --plan <plan.json> [--package <name>] [--extend] [--dry-run]
#   plan: {"<module>": ["<top-level symbol>", ...], ...}, names as scripts/symbol-index.py reports them.
#   --package defaults to <stem>_parts, created next to --src. --extend (a chain step of a large split, forge#4211) adds
#   the plan's modules to an existing package dir instead: its __init__.py is left untouched (created when absent) and a
#   module file that already exists in it refuses. Without --extend an existing package path refuses.
# Output (stdout, one JSON object):
#   ok:      {"status":"ok","package":"<dotted package>","modules":{module:[symbols]},"shim":"<src path>"}
#   refused: {"status":"refused","reason":"..."}
# Result: <package>/__init__.py (empty) and <package>/<module>.py per plan entry, each holding, in order, the
#   source's `from __future__` imports, the source's module-level import statements its symbols use (verbatim;
#   relative imports gain one level), `from .<other> import ...` for symbols moved to sibling modules, then the
#   moved statements verbatim (leading comments included) in source order. --src keeps every unmoved statement
#   verbatim and gains `from <dotted package>.<module> import (...)` re-exports for every moved name, private ones
#   included, at the position of the first moved statement. Every changed line is a moved block or an import line,
#   so scripts/refactor-verify.sh can prove the move.
# Refuses (no file touched) when libcst is not importable, the source does not parse, or the plan is invalid:
#   unknown or non-top-level symbol, a symbol listed twice, a statement split across modules, a bad or colliding
#   module name, an existing package path, a moved symbol that needs a name staying in --src, a name bound by both
#   moved and kept statements, module-identity globals (__name__, globals(), ...) in moved code, a star import,
#   or an import cycle between the new modules.
# Writes are atomic: every file is built in memory, written to a temp file and os.replace'd in, the shim last.
# Exit: 0 ok | 2 usage or missing file | 3 refused.

import json
import keyword
import os
import shutil
import sys
import tempfile

MODULE_GLOBALS = {"__name__", "__file__", "__spec__", "__package__", "__loader__", "__path__", "__builtins__",
                  "__cached__", "globals", "vars"}


class Refused(Exception):
    pass


def emit(obj):
    sys.stdout.write(json.dumps(obj, sort_keys=True, separators=(",", ":")) + "\n")


def usage():
    sys.stderr.write("usage: symbol-move.py --src <file.py> --plan <plan.json> [--package <name>] [--extend] [--dry-run]\n")
    return 2


def parse_args(argv):
    opts, i = {"package": None, "dry_run": False, "extend": False}, 0
    while i < len(argv):
        a = argv[i]
        if a == "--dry-run":
            opts["dry_run"] = True
            i += 1
        elif a == "--extend":
            opts["extend"] = True
            i += 1
        elif a in ("--src", "--plan", "--package") and i + 1 < len(argv):
            opts[a[2:]] = argv[i + 1]
            i += 2
        else:
            return None
    return opts if opts.get("src") and opts.get("plan") else None


def dotted_package(directory):
    """Dotted import path of a directory, walking up while __init__.py exists ('' for a plain directory)."""
    parts, d = [], os.path.abspath(directory)
    while os.path.isfile(os.path.join(d, "__init__.py")):
        parts.append(os.path.basename(d))
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return ".".join(reversed(parts))


def load_plan(path):
    try:
        with open(path, encoding="utf-8") as fh:
            plan = json.load(fh)
    except (OSError, ValueError) as e:
        raise Refused("plan is not readable JSON: %s" % e)
    if not isinstance(plan, dict) or not plan:
        raise Refused("plan must be a non-empty object {module: [symbols]}")
    for mod, names in plan.items():
        if not isinstance(names, list) or not names or not all(isinstance(n, str) for n in names):
            raise Refused("plan entry %r must be a non-empty list of symbol names" % mod)
        if not mod.isidentifier() or keyword.iskeyword(mod) or mod == "__init__":
            raise Refused("module name %r is not a valid identifier" % mod)
    return plan


def build(cst, src, plan, package, extend=False):
    from libcst.metadata import GlobalScope, MetadataWrapper, ScopeProvider

    with open(src, "rb") as fh:
        raw = fh.read()
    try:
        module = cst.parse_module(raw)
    except Exception as e:  # libcst.ParserSyntaxError and decode errors
        raise Refused("source does not parse: %s" % str(e).splitlines()[0])
    body = list(module.body)

    def is_import_line(stmt):
        return isinstance(stmt, cst.SimpleStatementLine) and all(
            isinstance(s, (cst.Import, cst.ImportFrom)) for s in stmt.body)

    def is_future(stmt):
        return is_import_line(stmt) and all(
            isinstance(s, cst.ImportFrom) and isinstance(s.module, cst.Name) and s.module.value == "__future__"
            for s in stmt.body)

    def target_names(t):
        if isinstance(t, cst.Name):
            return [t.value]
        if isinstance(t, (cst.Tuple, cst.List)) and all(isinstance(e.value, cst.Name) for e in t.elements):
            return [e.value.value for e in t.elements]
        return None

    # movable top-level statements: def, class, or a line of plain assignments; index -> names it binds
    movable = {}
    for idx, stmt in enumerate(body):
        if isinstance(stmt, (cst.FunctionDef, cst.ClassDef)):
            movable[idx] = [stmt.name.value]
        elif isinstance(stmt, cst.SimpleStatementLine) and all(
                isinstance(s, (cst.Assign, cst.AnnAssign)) for s in stmt.body):
            names, ok = [], True
            for s in stmt.body:
                targets = [t.target for t in s.targets] if isinstance(s, cst.Assign) else [s.target]
                for t in targets:
                    got = target_names(t)
                    if got is None:
                        ok = False
                    else:
                        names.extend(got)
            if ok:
                movable[idx] = names
        if is_import_line(stmt) and any(isinstance(s, cst.ImportFrom) and isinstance(s.names, cst.ImportStar)
                                        for s in stmt.body):
            raise Refused("source has a star import at line %d; names cannot be resolved" % (idx + 1))

    symbol_stmt = {}
    for idx, names in movable.items():
        for n in names:
            symbol_stmt.setdefault(n, idx)

    # plan -> statement index -> module
    assigned, stmt_module = {}, {}
    for mod, names in plan.items():
        for n in names:
            if n in assigned:
                raise Refused("symbol %r is listed twice (%s, %s)" % (n, assigned[n], mod))
            assigned[n] = mod
            if "." in n:
                raise Refused("%r is not a top-level symbol; only top-level symbols move" % n)
            if n not in symbol_stmt:
                raise Refused("unknown symbol %r: not a top-level def, class or assignment in %s" % (n, src))
            idx = symbol_stmt[n]
            if stmt_module.setdefault(idx, mod) != mod:
                raise Refused("symbol %r shares a statement with symbols planned for another module" % n)
    for idx, mod in stmt_module.items():
        missing = [n for n in movable[idx] if assigned.get(n) != mod]
        if missing:
            raise Refused("statement binding %s also binds %s, which the plan does not move with it"
                          % (", ".join(sorted(set(movable[idx]) - set(missing))), ", ".join(missing)))

    # node -> owning top-level statement
    owner = {}
    for idx, stmt in enumerate(body):
        stack = [stmt]
        while stack:
            node = stack.pop()
            owner[id(node)] = idx
            stack.extend(node.children)

    wrapper = MetadataWrapper(module, unsafe_skip_copy=True)
    scopes = wrapper.resolve(ScopeProvider)
    gscope = next((s for s in scopes.values() if isinstance(s, GlobalScope)), None)
    binders, users = {}, {}
    if gscope is not None:
        for a in gscope.assignments:
            b = owner.get(id(a.node))
            if b is None:
                continue
            binders.setdefault(a.name, set()).add(b)
            for r in a.references:
                u = owner.get(id(r.node))
                if u is not None:
                    users.setdefault(a.name, set()).add(u)

    top_names = set(binders) | set(symbol_stmt)
    for mod in plan:
        if mod in top_names:
            raise Refused("module name %r collides with a top-level name in %s" % (mod, src))

    for name, bs in sorted(binders.items()):
        mods = {stmt_module.get(b) for b in bs}
        if len(mods) > 1:
            where = sorted(m or "<kept>" for m in mods)
            raise Refused("name %r is bound by statements going to different places (%s)" % (name, ", ".join(where)))

    # identity-dependent globals in moved code would change meaning in a new module
    for idx in sorted(stmt_module):
        stack = [(body[idx], None)]
        while stack:
            node, parent = stack.pop()
            if isinstance(node, cst.Name) and node.value in MODULE_GLOBALS and not (
                    isinstance(parent, cst.Attribute) and parent.attr is node):
                raise Refused("moved symbol %s uses module-identity global %r" % (movable[idx][0], node.value))
            stack.extend((c, node) for c in node.children)

    need_imports = {m: set() for m in plan}      # module -> import statement indexes
    need_from = {m: {} for m in plan}            # module -> {other module: set(names)}
    for name in sorted(users):
        bs = binders.get(name, set())
        for u in sorted(users[name]):
            mod = stmt_module.get(u)
            if mod is None or not bs:
                continue
            kept = [b for b in bs if b not in stmt_module and not is_import_line(body[b])]
            if kept:
                raise Refused("moved symbol %s (-> %s) needs %r, which stays in %s (line of statement %d)"
                              % (movable[u][0], mod, name, src, min(kept) + 1))
            other = stmt_module.get(next(iter(bs)))
            if other is None:
                need_imports[mod].update(bs)
            elif other != mod:
                need_from[mod].setdefault(other, set()).add(name)

    # import cycles between the new modules
    state = {}

    def visit(m, path):
        state[m] = 1
        for o in sorted(need_from[m]):
            if state.get(o) == 1:
                raise Refused("plan creates an import cycle: %s" % " -> ".join(path[path.index(o):] + [o]))
            if o not in state:
                visit(o, path + [o])
        state[m] = 2
    for m in sorted(plan):
        if m not in state:
            visit(m, [m])

    src_dir = os.path.dirname(os.path.abspath(src))
    pkg_dir = os.path.join(src_dir, package)
    if os.path.exists(pkg_dir + ".py") or (os.path.exists(pkg_dir) and not (extend and os.path.isdir(pkg_dir))):
        raise Refused("package path already exists: %s" % pkg_dir)
    if extend:
        taken = [m for m in plan if os.path.exists(os.path.join(pkg_dir, m + ".py"))]
        if taken:
            raise Refused("module already exists in package %s: %s" % (pkg_dir, ", ".join(sorted(taken))))
    base = dotted_package(src_dir)
    dotted = (base + "." if base else "") + package

    def code(stmt, strip_leading=False):
        if strip_leading:
            stmt = stmt.with_changes(leading_lines=())
        return module.code_for_node(stmt)

    def import_code(idx):
        stmt = body[idx]
        stmt = stmt.with_changes(body=[
            s.with_changes(relative=[cst.Dot()] + list(s.relative))
            if isinstance(s, cst.ImportFrom) and s.relative else s for s in stmt.body])
        return code(stmt, strip_leading=True)

    newline = module.default_newline

    def from_import(target, names):
        return "from %s import (%s%s)%s" % (target, newline, "".join("    %s,%s" % (n, newline) for n in names), newline)

    futures = [i for i, s in enumerate(body) if is_future(s)]
    order = sorted(plan, key=lambda m: min(i for i, mm in stmt_module.items() if mm == m))
    files, modules_out = {}, {}
    for mod in order:
        moved = sorted(i for i, mm in stmt_module.items() if mm == mod)
        head = [code(body[i], strip_leading=True) for i in futures]
        head += [import_code(i) for i in sorted(need_imports[mod]) if i not in futures]
        for other in sorted(need_from[mod], key=order.index):
            names = sorted(need_from[mod][other], key=lambda n: (symbol_stmt[n], n))
            head.append(from_import("." + other, names))
        files[os.path.join(pkg_dir, mod + ".py")] = "".join(head) + "".join(code(body[i]) for i in moved)
        modules_out[mod] = [n for i in moved for n in movable[i]]
    if not os.path.exists(os.path.join(pkg_dir, "__init__.py")):
        files[os.path.join(pkg_dir, "__init__.py")] = ""

    first = min(stmt_module)
    reexport = "".join(from_import("%s.%s" % (dotted, mod), modules_out[mod]) for mod in order)
    shim_stmts = list(cst.parse_module(reexport).body)
    blank = [ln for ln in body[first].leading_lines if ln.comment is None]
    shim_stmts[0] = shim_stmts[0].with_changes(leading_lines=blank)
    new_body = []
    for idx, stmt in enumerate(body):
        if idx == first:
            new_body.extend(shim_stmts)
        if idx not in stmt_module:
            new_body.append(stmt)
    shim = module.with_changes(body=new_body)
    return {"files": files, "shim": shim.code, "encoding": module.encoding, "pkg_dir": pkg_dir,
            "result": {"status": "ok", "package": dotted, "modules": modules_out, "shim": src}}


def write_atomic(src, plan_out):
    enc, pkg_dir = plan_out["encoding"], plan_out["pkg_dir"]
    temps, created, placed = [], False, []
    try:
        if not os.path.isdir(pkg_dir):
            os.mkdir(pkg_dir)
            created = True
        staged = []
        for path, text in sorted(plan_out["files"].items()) + [(src, plan_out["shim"])]:
            fd, tmp = tempfile.mkstemp(prefix=".symbol-move-", suffix=".tmp", dir=os.path.dirname(os.path.abspath(path)))
            temps.append(tmp)
            with os.fdopen(fd, "wb") as fh:
                fh.write(text.encode(enc))
            if path == src:
                shutil.copymode(src, tmp)
            staged.append((tmp, path))
        for tmp, path in staged:  # shim last: until then --src is untouched
            os.replace(tmp, path)
            temps.remove(tmp)
            if path != src:
                placed.append(path)
    except BaseException:
        for tmp in temps:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        if created:
            shutil.rmtree(pkg_dir, ignore_errors=True)
        else:  # --extend: remove only the files this run added to the existing package
            for path in placed:
                try:
                    os.unlink(path)
                except OSError:
                    pass
        raise


def main(argv):
    opts = parse_args(argv)
    if opts is None:
        return usage()
    src, plan_path = opts["src"], opts["plan"]
    for p in (src, plan_path):
        if not os.path.exists(p):
            sys.stderr.write("symbol-move: no such file: %s\n" % p)
            return 2
    try:
        import libcst as cst
    except ImportError:
        emit({"status": "refused",
              "reason": "no codemod tool: libcst (or rope) not importable for %s" % sys.executable})
        return 3
    try:
        if not src.endswith(".py") or not os.path.isfile(src):
            raise Refused("source is not a .py file: %s" % src)
        package = opts["package"] or os.path.splitext(os.path.basename(src))[0] + "_parts"
        if not package.isidentifier() or keyword.iskeyword(package):
            raise Refused("package name %r is not a valid identifier" % package)
        out = build(cst, src, load_plan(plan_path), package, opts["extend"])
    except Refused as r:
        emit({"status": "refused", "reason": str(r)})
        return 3
    if not opts["dry_run"]:
        write_atomic(src, out)
    emit(out["result"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
