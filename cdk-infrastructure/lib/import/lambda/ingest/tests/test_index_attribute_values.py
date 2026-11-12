"""Custom index attributes (Searchable attributes): value extraction + write.

_attr_raw reads the FIRST value of a multi-valued element (str() of a pydicom
MultiValue is "['A', 'B']", which is not a value and does not coerce to a
number); _coerce_attr_value maps it to the column type and truncates STRING to
the VARCHAR(255) column. _apply_index_attributes writes one UPDATE per enabled
def, skips a missing column, but re-raises a deadlock / lock-wait timeout
(the transaction is already aborted, so swallowing it would lose the instance).

Runs against s3-ingest by default; against the live v3 source with
S3INGEST_MODULE_DIR=../ingest S3INGEST_MODULE_ALIAS=engine.
"""

import pytest
from pydicom.dataset import Dataset

import engine as H


def _ds():
    d = Dataset()
    d.Manufacturer = "ACME"
    d.ImageType = ["ORIGINAL", "PRIMARY", "AXIAL"]
    d.SliceThickness = "1.25"
    d.PixelSpacing = ["0.5", "0.6"]
    d.AcquisitionNumber = "7"
    d.ContentDate = "20240102"
    d.InstitutionName = "X" * 300
    return d


def test_attr_raw_single_value():
    assert H._attr_raw(_ds(), "00080070") == "ACME"


def test_attr_raw_multivalue_takes_first():
    assert H._attr_raw(_ds(), "00080008") == "ORIGINAL"
    assert H._coerce_attr_value(H._attr_raw(_ds(), "00280030"), "DECIMAL") == 0.5


def test_attr_raw_missing_tag_is_none():
    assert H._attr_raw(_ds(), "00102160") is None


@pytest.mark.parametrize("tag,dtype,expected", [
    ("00180050", "DECIMAL", 1.25),
    ("00200012", "INT", 7),
    ("00080023", "DATE", "2024-01-02"),
    ("00080070", "STRING", "ACME"),
])
def test_coerce_types(tag, dtype, expected):
    assert H._coerce_attr_value(H._attr_raw(_ds(), tag), dtype) == expected


def test_string_truncated_to_column_width():
    v = H._coerce_attr_value(H._attr_raw(_ds(), "00080080"), "STRING")
    assert len(v) == 255


class _Err(Exception):
    pass


class _Cur:
    def __init__(self, conn):
        self.conn = conn

    def execute(self, sql, params=()):
        self.conn.calls.append((sql, params))
        if self.conn.fail is not None:
            raise self.conn.fail

    def close(self):
        pass


class _Conn:
    def __init__(self, fail=None):
        self.calls, self.fail = [], fail

    def cursor(self, *a, **k):
        return _Cur(self)


_DEFS = [
    {"dicom_tag": "00180050", "dicom_level": "INSTANCE", "data_type": "DECIMAL",
     "physical_column": "slicethickness"},
    {"dicom_tag": "00080070", "dicom_level": "SERIES", "data_type": "STRING",
     "physical_column": "manufacturer"},
]


@pytest.fixture
def defs(monkeypatch):
    monkeypatch.setattr(H, "_load_index_attributes", lambda conn, ds_id: _DEFS)


def test_apply_writes_each_level(defs):
    conn = _Conn()
    H._apply_index_attributes(conn, "ds", _ds(), None, None, 42, "iid-1")
    assert [p for _, p in conn.calls] == [(1.25, "ds", "iid-1"), ("ACME", 42)]
    assert "`slicethickness`" in conn.calls[0][0]
    assert "`manufacturer`" in conn.calls[1][0]


def test_apply_skips_missing_column(defs):
    conn = _Conn(fail=_Err(1054, "Unknown column"))
    H._apply_index_attributes(conn, "ds", _ds(), None, None, 42, "iid-1")
    assert len(conn.calls) == 2


@pytest.mark.parametrize("errno", [1213, 1205])
def test_apply_reraises_deadlock(defs, errno):
    conn = _Conn(fail=_Err(errno, "Deadlock"))
    with pytest.raises(_Err):
        H._apply_index_attributes(conn, "ds", _ds(), None, None, 42, "iid-1")
