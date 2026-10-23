from itertools import islice

__all__ = ["ichunked"]


def _take(iterator, n):
    return list(islice(iterator, n))


def _chunks(iterator, n):
    while True:
        chunk = _take(iterator, n)
        if not chunk:
            return
        yield iter(chunk)


def ichunked(iterable, n):
    """Return an iterator over successive chunks of length n from iterable."""
    return _chunks(iter(iterable), n)
