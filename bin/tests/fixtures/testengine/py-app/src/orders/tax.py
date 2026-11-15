from .pricing import subtotal


def with_tax(items, rate=0.2):
    return subtotal(items) * (1 + rate)
