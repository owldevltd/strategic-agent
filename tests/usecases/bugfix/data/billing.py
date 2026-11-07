"""Invoice totals for the shop. Prices are net, in cents, as integers; VAT rates are in percent."""


def line_total(price_cents, quantity, vat_percent):
    """The gross amount of one invoice line, in EUR."""
    net = price_cents * quantity / 100
    return net * (1 + vat_percent / 100)


def invoice_total(lines):
    """lines: a list of [price_cents, quantity, vat_percent]. Returns the total in EUR as text with two decimals."""
    total = sum(line_total(*line) for line in lines)
    return f"{round(total, 2):.2f}"
