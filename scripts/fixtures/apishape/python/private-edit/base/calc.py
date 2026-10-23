def _scale(value):
    return value * 2


def total(values):
    return sum(_scale(v) for v in values)
