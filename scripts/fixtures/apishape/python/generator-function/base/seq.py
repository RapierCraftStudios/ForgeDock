def pairs(items):
    for i in range(0, len(items), 2):
        yield items[i:i + 2]
