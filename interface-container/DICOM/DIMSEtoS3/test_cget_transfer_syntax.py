#!/usr/bin/env python3
"""
Unit tests for C-GET storage-context handling (CGetHandler).

The Storage presentation contexts accept every supported transfer syntax with
Explicit/Implicit VR LE listed first (see transfer_syntax_config), so a peer
that offers an uncompressed syntax settles on it and our Explicit VR LE cache
is sendable. The handler verifies the peer granted an SCU-role context.
"""

import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import (
    UID,
    ExplicitVRLittleEndian,
    ImplicitVRLittleEndian,
    SecondaryCaptureImageStorage,
    generate_uid,
)

sys.path.insert(0, str(Path(__file__).parent))

from cget_handler import CGetHandler
from qr_retrieval_base import CMoveInstance


class FakeConfig:
    def __init__(self):
        self.location_id = "interface-1"
        self.raw = {"interfaces": [{"accessibleDatastores": []}]}


@pytest.fixture
def handler():
    return CGetHandler(MagicMock(), FakeConfig())


def _ctx(sop, ts, as_scu, as_scp=True):
    return SimpleNamespace(
        abstract_syntax=UID(sop),
        transfer_syntax=[UID(ts)],
        as_scu=as_scu,
        as_scp=as_scp,
    )


def _assoc(contexts):
    return SimpleNamespace(accepted_contexts=contexts)


def _write_evrle(directory: Path) -> CMoveInstance:
    sop_uid = generate_uid()
    ds = Dataset()
    ds.PatientID = "TEST"
    ds.SOPClassUID = SecondaryCaptureImageStorage
    ds.SOPInstanceUID = sop_uid
    fm = FileMetaDataset()
    fm.MediaStorageSOPClassUID = SecondaryCaptureImageStorage
    fm.MediaStorageSOPInstanceUID = sop_uid
    fm.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.file_meta = fm
    path = directory / f"{sop_uid}.dcm"
    ds.save_as(str(path), enforce_file_format=True)
    return CMoveInstance("s", "se", sop_uid, "ds-1", cache_path=str(path), retrieved=True)


# ---------------------------------------------------------------------------
# _negotiated_scu_transfer_syntax
# ---------------------------------------------------------------------------

def test_negotiated_ts_returns_scu_role_context(handler):
    assoc = _assoc([_ctx(SecondaryCaptureImageStorage, ImplicitVRLittleEndian, as_scu=True)])
    assert handler._negotiated_scu_transfer_syntax(assoc, SecondaryCaptureImageStorage) == ImplicitVRLittleEndian


def test_negotiated_ts_none_when_no_scu_role(handler):
    assoc = _assoc([_ctx(SecondaryCaptureImageStorage, ImplicitVRLittleEndian, as_scu=False)])
    assert handler._negotiated_scu_transfer_syntax(assoc, SecondaryCaptureImageStorage) is None


def test_negotiated_ts_none_when_sop_not_present(handler):
    assoc = _assoc([_ctx("1.2.840.10008.5.1.4.1.1.2", ImplicitVRLittleEndian, as_scu=True)])
    assert handler._negotiated_scu_transfer_syntax(assoc, SecondaryCaptureImageStorage) is None


# ---------------------------------------------------------------------------
# _prepare_dataset_for_send
# ---------------------------------------------------------------------------

def test_prepare_returns_dataset_when_scu_context_present(handler):
    with tempfile.TemporaryDirectory() as tmp:
        inst = _write_evrle(Path(tmp))
        assoc = _assoc([_ctx(SecondaryCaptureImageStorage, ImplicitVRLittleEndian, as_scu=True)])
        ds = handler._prepare_dataset_for_send(inst, assoc)
        assert ds is not None
        assert ds.SOPClassUID == SecondaryCaptureImageStorage


def test_prepare_explicit_vr_le_context(handler):
    with tempfile.TemporaryDirectory() as tmp:
        inst = _write_evrle(Path(tmp))
        assoc = _assoc([_ctx(SecondaryCaptureImageStorage, ExplicitVRLittleEndian, as_scu=True)])
        assert handler._prepare_dataset_for_send(inst, assoc) is not None


def test_prepare_no_scu_context_returns_none(handler):
    with tempfile.TemporaryDirectory() as tmp:
        inst = _write_evrle(Path(tmp))
        assoc = _assoc([_ctx(SecondaryCaptureImageStorage, ImplicitVRLittleEndian, as_scu=False)])
        assert handler._prepare_dataset_for_send(inst, assoc) is None
