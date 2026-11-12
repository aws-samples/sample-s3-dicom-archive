"""Per-file -> import status aggregation (contract "Queue and encapsulator")."""

FILE_STATUSES = ('PENDING', 'ENCAPSULATING', 'WRITTEN', 'INDEXED', 'FAILED')


def aggregate(statuses):
    """All INDEXED -> COMPLETED; all FAILED -> FAILED; some FAILED and the rest
    INDEXED -> PARTIAL; anything else (work still pending) -> PROCESSING."""
    statuses = list(statuses)
    if not statuses:
        return 'PROCESSING'
    if all(s == 'INDEXED' for s in statuses):
        return 'COMPLETED'
    if all(s == 'FAILED' for s in statuses):
        return 'FAILED'
    if all(s in ('INDEXED', 'FAILED') for s in statuses):
        return 'PARTIAL'
    return 'PROCESSING'
