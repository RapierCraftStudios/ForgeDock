from itertools import islice

__all__ = ["ichunked"]


def _take(iterator, n):
    return list(islice(iterator, n))


def ichunked(iterable, n):
    """Yield successive chunks of length n from iterable."""
    iterator = iter(iterable)
    while True:
        chunk = _take(iterator, n)
        if not chunk:
            return
        yield iter(chunk)
