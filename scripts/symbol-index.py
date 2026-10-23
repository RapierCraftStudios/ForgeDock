#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# symbol-index.py: deterministic Python symbol index + module import-cycle detector for refactor:split (forge#4208).
# stdlib only (ast). No LLM, no network. Never emits source text, docstrings or literal values.
#
# Usage: python3 scripts/symbol-index.py [--shape] <file.py | dir>...
# Output (stdout, one JSON object):
#   {"symbols":[{name,kind,start,end,lines,public[,file]}], "edges":[{from,to}],
#    "imports":[{module,names,line[,file]}], "cycles":[[module,...],...]}
#   kind: function|async_function|class|method|const. Methods (and nested classes) are named Class.method.
#   start includes decorators; lines = end - start + 1. public = no leading underscore (method dunders count as
#   public), and listed in a static __all__ when the module defines one.
#   --shape (forge#4449, bin/lean/apishape.mjs): function/async_function/method entries also carry async (bool),
#   generator (yield in the def's own scope) and sig: the normalized parameter list (kinds, names, annotation text,
#   "=" for a default but never its value) plus " -> <return annotation>". Without --shape the output is unchanged.
#   One .py file: names are bare. Otherwise (a directory or several files) each entry carries `file` and edge ends
#   are "<module>:<symbol>"; module names are dotted paths relative to each root (a root that has __init__.py is
#   itself the top package, so root .../pkg yields pkg.a). edges = references from one indexed symbol to another.
#   cycles = strongly connected components (size > 1, or a self-import) of the module-level import graph between
#   indexed modules; function-local and `if TYPE_CHECKING:` imports are ignored. Everything is sorted, so a
#   before/after pair of runs can be diffed for new cycles.
# Unsupported input (non-.py file, no .py files, a file that does not parse) prints only
#   {"unsupported":"<lang>","reason":"..."} and exits 0: never partial output.
# Exit: 0 ok or unsupported | 2 usage or missing path.

import ast
import json
import os
import sys

LANGS = {
    ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts",
    ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js",
    ".go": "go", ".rs": "rust", ".rb": "ruby", ".java": "java", ".kt": "kotlin",
    ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp", ".cs": "csharp",
    ".php": "php", ".swift": "swift", ".sh": "shell", ".bash": "shell",
}
SKIP_DIRS = {"__pycache__", "node_modules", "site-packages", "venv", "env"}


class Unsupported(Exception):
    def __init__(self, lang, reason):
        super().__init__(reason)
        self.lang, self.reason = lang, reason


def lang_of(path):
    ext = os.path.splitext(path)[1].lower()
    return LANGS.get(ext, ext[1:] if ext else "unknown")


def is_private(name):
    return name.startswith("_")


def is_dunder(name):
    return len(name) > 4 and name.startswith("__") and name.endswith("__")


def static_all(tree):
    """Names in a statically readable module-level __all__, or None when absent or not static."""
    names, seen = [], False
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "__all__" for t in node.targets):
            value, seen, names = node.value, True, []
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == "__all__":
            value, seen, names = node.value, True, []
        elif isinstance(node, ast.AugAssign) and isinstance(node.target, ast.Name) and node.target.id == "__all__":
            value = node.value
        else:
            continue
        if not isinstance(value, (ast.List, ast.Tuple)):
            return None
        for elt in value.elts:
            if not (isinstance(elt, ast.Constant) and isinstance(elt.value, str)):
                return None
            names.append(elt.value)
    return set(names) if seen else None


def def_start(node):
    decos = getattr(node, "decorator_list", None) or []
    return min([node.lineno] + [d.lineno for d in decos])


def is_type_checking(test):
    return (isinstance(test, ast.Name) and test.id == "TYPE_CHECKING") or (
        isinstance(test, ast.Attribute) and test.attr == "TYPE_CHECKING")


def module_imports(body):
    """Import statements at module level (descending into if/try/with, never into def/class or TYPE_CHECKING)."""
    out = []
    for node in body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            out.append(node)
        elif isinstance(node, ast.If):
            if not is_type_checking(node.test):
                out.extend(module_imports(node.body))
            out.extend(module_imports(node.orelse))
        elif isinstance(node, (ast.Try, getattr(ast, "TryStar", ast.Try))):
            out.extend(module_imports(node.body))
            for h in node.handlers:
                out.extend(module_imports(h.body))
            out.extend(module_imports(node.orelse))
            out.extend(module_imports(node.finalbody))
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            out.extend(module_imports(node.body))
    return out


def is_generator(fn):
    """True when yield / yield from occurs in fn's own scope (not in nested defs, lambdas or classes)."""
    work = list(ast.iter_child_nodes(fn))
    while work:
        n = work.pop()
        if isinstance(n, (ast.Yield, ast.YieldFrom)):
            return True
        if not isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            work.extend(ast.iter_child_nodes(n))
    return False


def signature(fn):
    """Normalized parameter list of a def: names, kinds, annotation text, '=' for a default (never its value)."""
    a = fn.args

    def one(arg, default=False, prefix=""):
        out = prefix + arg.arg
        if arg.annotation is not None:
            out += ": " + ast.unparse(arg.annotation)
        return out + ("=" if default else "")

    positional = a.posonlyargs + a.args
    first_default = len(positional) - len(a.defaults)
    parts = [one(x, i >= first_default) for i, x in enumerate(positional)]
    if a.posonlyargs:
        parts.insert(len(a.posonlyargs), "/")
    if a.vararg is not None:
        parts.append(one(a.vararg, prefix="*"))
    elif a.kwonlyargs:
        parts.append("*")
    parts += [one(x, d is not None) for x, d in zip(a.kwonlyargs, a.kw_defaults)]
    if a.kwarg is not None:
        parts.append(one(a.kwarg, prefix="**"))
    sig = "(" + ", ".join(parts) + ")"
    return sig + (" -> " + ast.unparse(fn.returns) if fn.returns is not None else "")


class Module:
    def __init__(self, path, name, is_pkg, shape=False):
        self.path, self.name, self.is_pkg, self.shape = path, name, is_pkg, shape
        self.symbols = []      # dicts without file
        self.nodes = {}        # symbol name -> (ast node, owning class name or None)
        self.imports = []      # (ast import node)
        self.tree = None

    def parse(self):
        try:
            with open(self.path, "rb") as fh:
                self.tree = ast.parse(fh.read(), filename=self.path)
        except SyntaxError as e:
            raise Unsupported("python", "parse-error: %s:%s" % (self.path, e.lineno or 0))
        except (ValueError, UnicodeDecodeError, OSError):
            raise Unsupported("python", "parse-error: %s:0" % self.path)
        exported = static_all(self.tree)

        def top_public(name):
            return not is_private(name) and (exported is None or name in exported)

        def add(name, kind, node, public, owner=None):
            start, end = def_start(node), node.end_lineno or node.lineno
            sym = {"name": name, "kind": kind, "start": start, "end": end, "lines": end - start + 1, "public": public}
            if self.shape and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                sym.update({"async": isinstance(node, ast.AsyncFunctionDef), "generator": is_generator(node),
                            "sig": signature(node)})
            self.symbols.append(sym)
            self.nodes[name] = (node, owner)

        def add_class(node, prefix, public):
            name = prefix + node.name
            add(name, "class", node, public)
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    mpub = public and (not is_private(item.name) or is_dunder(item.name))
                    add(name + "." + item.name, "method", item, mpub, owner=name)
                elif isinstance(item, ast.ClassDef):
                    add_class(item, name + ".", public and not is_private(item.name))

        for node in self.tree.body:
            if isinstance(node, ast.FunctionDef):
                add(node.name, "function", node, top_public(node.name))
            elif isinstance(node, ast.AsyncFunctionDef):
                add(node.name, "async_function", node, top_public(node.name))
            elif isinstance(node, ast.ClassDef):
                add_class(node, "", top_public(node.name))
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for t in targets:
                    for n in ([t] if isinstance(t, ast.Name) else getattr(t, "elts", [])):
                        if isinstance(n, ast.Name) and n.id not in self.nodes:
                            add(n.id, "const", node, top_public(n.id))
        self.imports = module_imports(self.tree.body)

    def package(self):
        return self.name if self.is_pkg else self.name.rpartition(".")[0]

    def resolve(self, node):
        """Absolute module named by an ImportFrom (relative levels resolved), or None when it climbs past the root."""
        if node.level == 0:
            return node.module or ""
        parts = self.package().split(".") if self.package() else []
        if node.level - 1 > len(parts):
            return None
        base = parts[:len(parts) - (node.level - 1)]
        if node.module:
            base = base + node.module.split(".")
        return ".".join(base)


def walk_roots(paths):
    """[(path, module name, is_pkg)] for every .py file under the given roots, sorted."""
    found = []
    for root in paths:
        root = os.path.normpath(root)
        if os.path.isfile(root):
            if not root.endswith(".py"):
                raise Unsupported(lang_of(root), "unsupported-language")
            stem = os.path.splitext(os.path.basename(root))[0]
            found.append((root, stem, False))
            continue
        prefix = os.path.basename(os.path.abspath(root)) if os.path.isfile(os.path.join(root, "__init__.py")) else ""
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d not in SKIP_DIRS)
            for fn in sorted(filenames):
                if not fn.endswith(".py"):
                    continue
                path = os.path.join(dirpath, fn)
                rel = os.path.relpath(path, root)[:-3].split(os.sep)
                is_pkg = rel[-1] == "__init__"
                if is_pkg:
                    rel = rel[:-1]
                name = ".".join(([prefix] if prefix else []) + rel)
                found.append((path, name, is_pkg))
    if not found:
        raise Unsupported("unknown", "no-python-files")
    return sorted(found)


def tarjan(graph):
    """Strongly connected components, iterative (no recursion limit on large packages)."""
    index, low, on, stack, comps, counter = {}, {}, set(), [], [], [0]
    for start in sorted(graph):
        if start in index:
            continue
        work = [(start, iter(sorted(graph[start])))]
        index[start] = low[start] = counter[0]; counter[0] += 1
        stack.append(start); on.add(start)
        while work:
            v, it = work[-1]
            advanced = False
            for w in it:
                if w not in index:
                    index[w] = low[w] = counter[0]; counter[0] += 1
                    stack.append(w); on.add(w)
                    work.append((w, iter(sorted(graph.get(w, ())))))
                    advanced = True
                    break
                if w in on:
                    low[v] = min(low[v], index[w])
            if advanced:
                continue
            work.pop()
            if work:
                low[work[-1][0]] = min(low[work[-1][0]], low[v])
            if low[v] == index[v]:
                comp = []
                while True:
                    w = stack.pop(); on.discard(w); comp.append(w)
                    if w == v:
                        break
                comps.append(sorted(comp))
    return comps


def build(paths, shape=False):
    entries = walk_roots(paths)
    multi = not (len(entries) == 1 and os.path.isfile(paths[0]) and len(paths) == 1)
    modules, by_name = [], {}
    for path, name, is_pkg in entries:
        m = Module(path, name, is_pkg, shape)
        m.parse()
        modules.append(m)
        by_name.setdefault(name, m)

    def ref(m, sym):
        return "%s:%s" % (m.name, sym) if multi else sym

    symbols, imports, edges, graph = [], [], set(), {m.name: set() for m in modules}
    for m in modules:
        rel = os.path.relpath(m.path)
        for s in m.symbols:
            symbols.append(dict(s, file=rel) if multi else s)
        # bindings: local name -> (module, symbol or None for a module object)
        bindings, first_import = {}, len(imports)
        for node in m.imports:
            if isinstance(node, ast.Import):
                for a in node.names:
                    imports.append({"module": a.name, "names": [], "line": node.lineno})
                    if a.name in by_name:
                        graph[m.name].add(a.name)
                    if a.asname:
                        bindings[a.asname] = (a.name, None)
                    else:
                        bindings[a.name.split(".")[0]] = (a.name.split(".")[0], None)
            else:
                target = m.resolve(node)
                shown = target if target is not None else "." * node.level + (node.module or "")
                imports.append({"module": shown, "names": [a.name for a in node.names], "line": node.lineno})
                if target is None:
                    continue
                for a in node.names:
                    sub = (target + "." + a.name) if target else a.name
                    if sub in by_name:
                        graph[m.name].add(sub)
                        bindings[a.asname or a.name] = (sub, None)
                    elif target in by_name:
                        graph[m.name].add(target)
                        bindings[a.asname or a.name] = (target, a.name)
        local = set(m.nodes)
        for name, (node, owner) in m.nodes.items():
            src = ref(m, name)
            first_arg = None
            if owner and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.args.args:
                first_arg = node.args.args[0].arg
            body = [node]
            if isinstance(node, ast.ClassDef):  # methods and nested classes are their own symbols
                body = node.decorator_list + node.bases + [k.value for k in node.keywords] + [
                    b for b in node.body if not isinstance(b, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                body = [node.value] if node.value is not None else []
            for root in body:
                for n in ast.walk(root):
                    to = None
                    if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load):
                        if n.id in local:
                            to = ref(m, n.id)
                        elif n.id in bindings:
                            mod, sym = bindings[n.id]
                            if sym is not None and sym in by_name[mod].nodes:
                                to = "%s:%s" % (mod, sym)
                    elif isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name):
                        base = n.value.id
                        if owner and base == first_arg and (owner + "." + n.attr) in local:
                            to = ref(m, owner + "." + n.attr)
                        elif base in local and (base + "." + n.attr) in local:
                            to = ref(m, base + "." + n.attr)
                        elif base in bindings and bindings[base][1] is None:
                            mod = bindings[base][0]
                            if mod in by_name and n.attr in by_name[mod].nodes:
                                to = "%s:%s" % (mod, n.attr)
                    if to is not None and to != src:
                        edges.add((src, to))
        if multi:
            for imp in imports[first_import:]:
                imp["file"] = rel

    cycles = sorted(c for c in tarjan(graph) if len(c) > 1 or c[0] in graph[c[0]])
    if multi:
        symbols.sort(key=lambda s: (s["file"], s["start"], s["name"]))
        imports.sort(key=lambda i: (i["file"], i["line"], i["module"]))
    else:
        symbols.sort(key=lambda s: (s["start"], s["name"]))
        imports.sort(key=lambda i: (i["line"], i["module"]))
    return {"symbols": symbols, "edges": [{"from": f, "to": t} for f, t in sorted(edges)],
            "imports": imports, "cycles": cycles}


def main(argv):
    shape = "--shape" in argv
    argv = [a for a in argv if a != "--shape"]
    if not argv or argv[0] in ("-h", "--help"):
        sys.stderr.write("usage: symbol-index.py [--shape] <file.py | dir>...\n")
        return 2
    for p in argv:
        if not os.path.exists(p):
            sys.stderr.write("symbol-index: no such path: %s\n" % p)
            return 2
    try:
        out = build(argv, shape)
    except Unsupported as u:
        out = {"unsupported": u.lang, "reason": u.reason}
    sys.stdout.write(json.dumps(out, sort_keys=True, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
