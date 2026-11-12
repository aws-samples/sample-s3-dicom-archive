#!/usr/bin/env python3
"""
TDD tests for the CGetHandler generator contract.

First yield = sub-operation count; then (0xFF00, dataset) per sendable instance;
a single final status (0x0000 / 0xB000 / 0xC000 / 0xFE00). The per-instance
encoding decision is delegated to _prepare_dataset_for_send (tested separately),
so it is patched here to isolate the generator contract.
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from pydicom import Dataset
from pydicom.dataset import FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian

sys.path.insert(0, str(Path(__file__).parent))

from cget_handler import CGetHandler, create_cget_handler
from qr_retrieval_base import CMoveInstance, QueryRetrieveBase


class FakeConfig:
    def __init__(self):
        self.location_id = "interface-1"
        self.raw = {"interfaces": [{"accessibleDatastores": []}]}


def _make_event(cancelled=False):
    event = MagicMock()
    event.assoc.requestor.ae_title = "CLIENT_AE"
    ds = Dataset()
    ds.StudyInstanceUID = "1.2.3"
    event.identifier = ds
    event.is_cancelled = cancelled
    return event


def _instance(uid, retrieved):
    return CMoveInstance("1.2.3", "1.2.3.4", uid, "ds-1",
                         cache_path=f"/tmp/{uid}.dcm" if retrieved else None,
                         retrieved=retrieved)


def _ds():
    ds = Dataset()
    fm = FileMetaDataset()
    fm.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.file_meta = fm
    return ds


@pytest.fixture
def handler():
    return CGetHandler(MagicMock(), FakeConfig())


def test_is_subclass_and_factory():
    assert issubclass(CGetHandler, QueryRetrieveBase)
    assert isinstance(create_cget_handler(MagicMock(), FakeConfig()), CGetHandler)


def test_all_success(handler):
    instances = [_instance("a", True), _instance("b", True)]
    with patch.object(handler, "_validate_authorization", return_value=True), \
         patch.object(handler, "_log_client_storage_contexts"), \
         patch.object(handler, "_discover_instances", return_value=instances), \
         patch.object(handler, "_retrieve_instances_parallel", return_value=instances), \
         patch.object(handler, "_cleanup_cache"), \
         patch("cget_handler.os.path.exists", return_value=True), \
         patch.object(handler, "_prepare_dataset_for_send", return_value=_ds()):
        results = list(handler.handle_c_get(_make_event()))
    assert results[0] == 2
    assert len([r for r in results[1:] if isinstance(r, tuple) and r[0] == 0xFF00]) == 2
    assert results[-1][0] == 0x0000


def test_partial_failure_warning(handler):
    instances = [_instance("a", True), _instance("b", True)]
    with patch.object(handler, "_validate_authorization", return_value=True), \
         patch.object(handler, "_log_client_storage_contexts"), \
         patch.object(handler, "_discover_instances", return_value=instances), \
         patch.object(handler, "_retrieve_instances_parallel", return_value=instances), \
         patch.object(handler, "_cleanup_cache"), \
         patch("cget_handler.os.path.exists", return_value=True), \
         patch.object(handler, "_prepare_dataset_for_send", side_effect=[_ds(), None]):
        results = list(handler.handle_c_get(_make_event()))
    assert results[0] == 2
    assert len([r for r in results[1:] if isinstance(r, tuple) and r[0] == 0xFF00]) == 1
    assert results[-1][0] == 0xB000


def test_all_failure(handler):
    instances = [_instance("a", True)]
    with patch.object(handler, "_validate_authorization", return_value=True), \
         patch.object(handler, "_log_client_storage_contexts"), \
         patch.object(handler, "_discover_instances", return_value=instances), \
         patch.object(handler, "_retrieve_instances_parallel", return_value=instances), \
         patch.object(handler, "_cleanup_cache"), \
         patch("cget_handler.os.path.exists", return_value=True), \
         patch.object(handler, "_prepare_dataset_for_send", return_value=None):
        results = list(handler.handle_c_get(_make_event()))
    assert results[0] == 1
    assert results[-1][0] == 0xC000


def test_no_instances(handler):
    with patch.object(handler, "_validate_authorization", return_value=True), \
         patch.object(handler, "_log_client_storage_contexts"), \
         patch.object(handler, "_discover_instances", return_value=[]), \
         patch.object(handler, "_retrieve_instances_parallel") as retr:
        results = list(handler.handle_c_get(_make_event()))
    assert results[0] == 0
    retr.assert_not_called()


def test_not_authorized(handler):
    with patch.object(handler, "_validate_authorization", return_value=False), \
         patch.object(handler, "_discover_instances") as disc:
        results = list(handler.handle_c_get(_make_event()))
    assert results[0] == 0
    disc.assert_not_called()


def test_cancelled(handler):
    instances = [_instance("a", True)]
    with patch.object(handler, "_validate_authorization", return_value=True), \
         patch.object(handler, "_log_client_storage_contexts"), \
         patch.object(handler, "_discover_instances", return_value=instances), \
         patch.object(handler, "_retrieve_instances_parallel", return_value=instances), \
         patch.object(handler, "_cleanup_cache"):
        results = list(handler.handle_c_get(_make_event(cancelled=True)))
    assert results[0] == 1
    assert results[-1][0] == 0xFE00
