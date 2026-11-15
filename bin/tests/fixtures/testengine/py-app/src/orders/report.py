import importlib


def render(kind):
    return importlib.import_module("orders.pricing").subtotal([kind])
