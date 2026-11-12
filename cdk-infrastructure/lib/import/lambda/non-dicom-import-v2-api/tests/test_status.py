import pytest

from status import aggregate


@pytest.mark.parametrize('statuses,expected', [
    (['INDEXED', 'INDEXED'], 'COMPLETED'),
    (['FAILED', 'FAILED'], 'FAILED'),
    (['INDEXED', 'FAILED'], 'PARTIAL'),
    (['INDEXED', 'WRITTEN'], 'PROCESSING'),
    (['PENDING'], 'PROCESSING'),
    (['FAILED', 'ENCAPSULATING'], 'PROCESSING'),
    (['FAILED', 'WRITTEN', 'INDEXED'], 'PROCESSING'),
    ([], 'PROCESSING'),
])
def test_aggregate(statuses, expected):
    assert aggregate(statuses) == expected
