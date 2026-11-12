"""Index-attribute application on the live ingest path (engine.py).

Run: cd cdk-infrastructure/lib/import/lambda/ingest && python3.12 -m pytest tests/
"""
import os
import sys

import pytest
from pydicom.dataset import Dataset

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import engine as h  # noqa: E402


class _Cur:
    def __init__(self, log):
        self.log = log

    def execute(self, sql, params=()):
        self.log.append((sql, params))

    def close(self):
        pass


class _Conn:
    def __init__(self):
        self.log = []

    def cursor(self):
        return _Cur(self.log)


@pytest.fixture(autouse=True)
def _defs(monkeypatch):
    attrs = [
        {'physical_column': 'slicethickness', 'dicom_tag': '00180050', 'dicom_level': 'INSTANCE', 'data_type': 'DECIMAL'},
        {'physical_column': 'imagetype', 'dicom_tag': '00080008', 'dicom_level': 'INSTANCE', 'data_type': 'STRING'},
        {'physical_column': 'pixelspacing', 'dicom_tag': '00280030', 'dicom_level': 'INSTANCE', 'data_type': 'DECIMAL'},
        {'physical_column': 'manufacturer', 'dicom_tag': '00080070', 'dicom_level': 'SERIES', 'data_type': 'STRING'},
    ]
    monkeypatch.setattr(h, '_load_index_attributes', lambda conn, ds_id: attrs)


def _ds():
    ds = Dataset()
    ds.SliceThickness = '1.25'
    ds.ImageType = ['ORIGINAL', 'PRIMARY', 'AXIAL']
    ds.PixelSpacing = ['0.5', '0.6']
    ds.Manufacturer = 'ACME'
    return ds


def test_coerce_types():
    assert h._coerce_attr_value('7', 'INT') == 7
    assert h._coerce_attr_value('x', 'INT') is None
    assert h._coerce_attr_value('1.5\\2.5', 'DECIMAL') == 1.5
    assert h._coerce_attr_value('20240102', 'DATE') == '2024-01-02'
    assert h._coerce_attr_value('2024', 'DATE') is None
    assert h._coerce_attr_value('', 'STRING') is None
    assert h._coerce_attr_value('a' * 300, 'STRING') == 'a' * 255


def test_attr_raw_takes_first_of_multivalue():
    ds = _ds()
    assert h._attr_raw(ds, '00080008') == 'ORIGINAL'
    assert h._attr_raw(ds, '00280030') == '0.5'
    assert h._attr_raw(ds, '00080070') == 'ACME'
    assert h._attr_raw(ds, '00100010') is None  # absent


def test_instance_level_written_on_own_row_only():
    conn = _Conn()
    h._apply_instance_index_attributes(conn, 'ds-1', _ds(), 'inst-1')
    by_col = {sql.split('`')[1]: params for sql, params in conn.log}
    assert set(by_col) == {'slicethickness', 'imagetype', 'pixelspacing'}  # no SERIES write
    assert all(sql.startswith('UPDATE instance SET') for sql, _ in conn.log)
    assert by_col['slicethickness'] == (1.25, 'ds-1', 'inst-1')
    assert by_col['imagetype'] == ('ORIGINAL', 'ds-1', 'inst-1')
    assert by_col['pixelspacing'] == (0.5, 'ds-1', 'inst-1')


def test_parent_level_on_create_writes_only_that_level():
    conn = _Conn()
    h._apply_parent_index_attributes_on_create(conn, 'ds-1', _ds(), 'SERIES', 42)
    assert conn.log == [('UPDATE `series` SET `manufacturer`=%s WHERE series_pkey=%s', ('ACME', 42))]


def test_live_lean_branch_calls_instance_attributes():
    """Regression guard: the INGESTION_V2 (lean, live) branch of _index_dicom must
    apply index attributes (it once did not)."""
    import inspect
    src = inspect.getsource(h._index_dicom)
    lean = src.split('if _INGESTION_V2:', 1)[1].split('\n    else:', 1)[0]
    assert '_apply_instance_index_attributes(' in lean
