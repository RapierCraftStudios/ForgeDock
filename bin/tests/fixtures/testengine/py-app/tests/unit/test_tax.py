import helpers
from orders import tax


def test_with_tax(items):
    assert helpers.approx(tax.with_tax(items), 3.6)
