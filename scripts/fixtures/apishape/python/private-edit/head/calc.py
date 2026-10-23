def _scale(value, factor=2):
    return value * factor


def total(values):
    result = 0
    for v in values:
        result += _scale(v)
    return result
