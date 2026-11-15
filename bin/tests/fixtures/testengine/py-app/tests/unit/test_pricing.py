from orders.pricing import subtotal


def test_subtotal(items):
    assert subtotal(items) == 3
