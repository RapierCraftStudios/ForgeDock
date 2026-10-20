#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# gen_big.py: deterministic fixture for scripts/symbol-move.test.sh (forge#4210). stdlib only, no randomness.
# Usage: python3 gen_big.py <out_root>
# Writes <out_root>/pkg/__init__.py, pkg/big.py (~3k lines) and tests/__init__.py, tests/test_big.py.
# big.py groups (the test's plan): consts (LIMIT_*, _SEPARATOR), helpers (_scale_*, compute_*, join_parts),
# aio (fetch_*), models (Item_*); VERSION, describe() and DEFAULT_TOTAL stay behind and use moved names.

import os
import sys

N_FUNCS = 90
N_ASYNC = 30
N_CLASSES = 30


def big():
    out = ['"""Fixture module for the symbol-move codemod test."""', "",
           "from __future__ import annotations", "",
           "import functools", "import os", "", "", "# ---- constants ----", ""]
    for i in range(N_FUNCS):
        out.append("LIMIT_%02d = %d  # upper bound for compute_%02d" % (i, 10 + i, i))
    out += ["", '_SEPARATOR = os.sep + "|"', "", ""]
    out += ["# ---- helpers ----", ""]
    for i in range(N_FUNCS):
        out += [
            "",
            "def _scale_%02d(value: int) -> int:" % i,
            "    # private helper: scales by the group factor",
            "    factor = %d" % (i % 7 + 1),
            "    if value < 0:",
            "        return -value * factor",
            "    return value * factor",
            "",
            "",
            "def compute_%02d(value: int) -> int:" % i,
            '    """Scale value and clamp it to LIMIT_%02d."""' % i,
            "    scaled = _scale_%02d(value)" % i,
            "    if scaled > LIMIT_%02d:" % i,
            "        return LIMIT_%02d" % i,
            "    total = 0",
            "    for step in range(scaled):",
            "        total += step % 3",
            "    return scaled + total - total",
            "",
        ]
    out += [
        "",
        "def join_parts(*parts: str) -> str:",
        "    # joins with the module separator",
        "    return _SEPARATOR.join(str(p) for p in parts)",
        "",
        "",
        "# ---- async ----",
        "",
    ]
    for i in range(N_ASYNC):
        out += [
            "",
            "async def fetch_%02d(value: int) -> dict:" % i,
            '    """Pretend to fetch: returns the computed value in a record."""',
            "    result = compute_%02d(value)" % i,
            '    record = {"id": %d, "value": result}' % i,
            "    if result % 2:",
            '        record["odd"] = True',
            "    return record",
            "",
        ]
    out += ["", "# ---- models ----", ""]
    for i in range(N_CLASSES):
        out += [
            "",
            "@functools.total_ordering",
            "class Item_%02d:" % i,
            '    """A comparable item backed by compute_%02d."""' % i,
            "",
            '    kind = "item-%02d"' % i,
            "",
            "    def __init__(self, raw: int) -> None:",
            "        self.raw = raw",
            "",
            "    @property",
            "    def value(self) -> int:",
            "        return compute_%02d(self.raw)" % i,
            "",
            "    def label(self) -> str:",
            '        return join_parts(self.kind, self.value, LIMIT_%02d)' % i,
            "",
            "    def __eq__(self, other: object) -> bool:",
            "        if not isinstance(other, Item_%02d):" % i,
            "            return NotImplemented",
            "        return self.value == other.value",
            "",
            "    def __lt__(self, other: Item_%02d) -> bool:" % i,
            "        return self.value < other.value",
            "",
            "    def __hash__(self) -> int:",
            "        return hash((self.kind, self.value))",
            "",
        ]
    out += [
        "",
        "# ---- kept in place ----",
        "",
        'VERSION = "1.0"',
        "",
        "",
        "def describe() -> str:",
        "    return join_parts(VERSION, compute_00(1), Item_01(2).label())",
        "",
        "",
        "DEFAULT_TOTAL = LIMIT_03 * 2",
    ]
    return "\n".join(out) + "\n"


TESTS = '''import asyncio
import os
import unittest

from pkg.big import (
    DEFAULT_TOTAL,
    LIMIT_05,
    VERSION,
    Item_03,
    _scale_02,
    _SEPARATOR,
    compute_04,
    compute_89,
    describe,
    fetch_08,
    join_parts,
)
import pkg.big as big


class BigTest(unittest.TestCase):
    def test_constant(self):
        self.assertEqual(LIMIT_05, 15)

    def test_private_helper(self):
        self.assertEqual(_scale_02(-2), 6)

    def test_compute_clamps(self):
        self.assertEqual(compute_04(100), 14)

    def test_compute_last(self):
        self.assertEqual(compute_89(1), 6)

    def test_join(self):
        self.assertEqual(join_parts("a", 1), "a" + os.sep + "|1")
        self.assertEqual(_SEPARATOR, os.sep + "|")

    def test_async(self):
        self.assertEqual(asyncio.run(fetch_08(1)), {"id": 8, "value": 2})

    def test_item_order(self):
        self.assertLess(Item_03(1), Item_03(2))
        self.assertEqual(Item_03(1), Item_03(1))
        self.assertGreaterEqual(Item_03(3), Item_03(2))

    def test_item_label(self):
        self.assertEqual(Item_03(1).label(), join_parts("item-03", 4, 13))

    def test_kept_names(self):
        self.assertEqual(VERSION, "1.0")
        self.assertEqual(DEFAULT_TOTAL, 26)
        self.assertTrue(describe().startswith("1.0"))

    def test_module_attributes(self):
        self.assertIs(big.os, os)
        self.assertEqual(big.Item_29(1).value, 2)

    @unittest.skip("documents a skipped case for the count check")
    def test_skipped(self):
        pass


if __name__ == "__main__":
    unittest.main()
'''


def main(argv):
    if len(argv) != 1:
        sys.stderr.write("usage: gen_big.py <out_root>\n")
        return 2
    root = argv[0]
    for d in ("pkg", "tests"):
        os.makedirs(os.path.join(root, d), exist_ok=True)
    files = {"pkg/__init__.py": "", "pkg/big.py": big(), "tests/__init__.py": "", "tests/test_big.py": TESTS}
    for rel, text in files.items():
        with open(os.path.join(root, rel), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
