from typing import TYPE_CHECKING

from . import c

if TYPE_CHECKING:
    from . import a


def step():
    from .a import run  # function-local: not a module-level edge
    return c.value + (0 if run else 1)


from .a import run as _run_alias  # noqa: E402  module-level a <-> b cycle
