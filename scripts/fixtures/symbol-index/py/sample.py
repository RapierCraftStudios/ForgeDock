"""Fixture module for symbol-index.test.sh. SECRET_DOCSTRING_MARKER"""
import os
from collections import OrderedDict as OD

__all__ = ["Greeter", "greet", "fetch", "LIMIT"]

LIMIT = 10
_cache = OD()


def _normalise(name):
    return name.strip().lower()


def greet(name):
    return "hi " + _normalise(name)


async def fetch(key):
    return _cache.get(key, LIMIT)


def helper():
    return os.getcwd()


class Greeter:
    """SECRET_CLASS_DOC_MARKER"""

    def __init__(self, name):
        self.name = name

    @property
    def text(self):
        return greet(self.name)

    def _shout(self):
        return self.text.upper()

    def shout(self):
        return self._shout()
