from orders import tax
from orders.store import (
    load,
    save as persist,
)


def checkout(order_id):
    return persist(order_id, tax.with_tax(load(order_id)))
