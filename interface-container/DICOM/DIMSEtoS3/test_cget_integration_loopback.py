#!/usr/bin/env python3
"""
End-to-end loopback test for C-GET transfer-syntax handling.

The SCU negotiates the storage context with ONLY Implicit VR Little Endian
(not the Explicit VR LE our WADO cache uses), plus SCP/SCU role selection. This
exercises the real association + _prepare_dataset_for_send path: pynetdicom must
convert our cached EVRLE dataset to the negotiated Implicit VR LE context, and
the sub-operation must succeed.

Discovery/retrieval are mocked with real on-disk EVRLE files; no AWS calls.
"""

import socket
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import (
    ExplicitVRLittleEndian,
    ImplicitVRLittleEndian,
    SecondaryCaptureImageStorage,
    generate_uid,
)
from pynetdicom import AE, evt, build_role
from pynetdicom.sop_class import StudyRootQueryRetrieveInformationModelGet

sys.path.insert(0, str(Path(__file__).parent))

from cget_handler import CGetHandler
from qr_retrieval_base import CMoveInstance


class FakeConfig:
    def __init__(self):
        self.location_id = "interface-1"
        self.raw = {"interfaces": [{"accessibleDatastores": []}]}


def _free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _write_evrle_instance(directory: Path, study_uid: str, series_uid: str) -> CMoveInstance:
    sop_uid = generate_uid()
    ds = Dataset()
    ds.PatientName = "Test^Patient"
    ds.PatientID = "TEST123"
    ds.StudyInstanceUID = study_uid
    ds.SeriesInstanceUID = series_uid
    ds.SOPClassUID = SecondaryCaptureImageStorage
    ds.SOPInstanceUID = sop_uid
    fm = FileMetaDataset()
    fm.MediaStorageSOPClassUID = SecondaryCaptureImageStorage
    fm.MediaStorageSOPInstanceUID = sop_uid
    fm.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.file_meta = fm
    path = directory / f"{sop_uid}.dcm"
    ds.save_as(str(path), enforce_file_format=True)
    return CMoveInstance(study_uid, series_uid, sop_uid, "ds-1",
                         cache_path=str(path), retrieved=True)


def test_c_get_with_implicit_vr_le_negotiation():
    study_uid = generate_uid()
    series_uid = generate_uid()

    with tempfile.TemporaryDirectory() as tmp:
        instances = [_write_evrle_instance(Path(tmp), study_uid, series_uid) for _ in range(2)]
        handler = CGetHandler(MagicMock(), FakeConfig())

        scp = None
        try:
            with patch.object(handler, "_validate_authorization", return_value=True), \
                 patch.object(handler, "_discover_instances", return_value=instances), \
                 patch.object(handler, "_retrieve_instances_parallel", return_value=instances), \
                 patch.object(handler, "_cleanup_cache"):

                port = _free_port()
                scp_ae = AE(ae_title="GETSCP")
                scp_ae.add_supported_context(StudyRootQueryRetrieveInformationModelGet)
                # Offer EVRLE + Implicit VR LE with both roles.
                scp_ae.add_supported_context(
                    SecondaryCaptureImageStorage,
                    transfer_syntax=[ExplicitVRLittleEndian, ImplicitVRLittleEndian],
                    scu_role=True,
                    scp_role=True,
                )
                scp = scp_ae.start_server(
                    ("127.0.0.1", port),
                    block=False,
                    evt_handlers=[(evt.EVT_C_GET, handler.handle_c_get)],
                )

                received = []

                def handle_store(event):
                    received.append(event.dataset.SOPInstanceUID)
                    return 0x0000

                scu_ae = AE(ae_title="GETSCU")
                scu_ae.add_requested_context(StudyRootQueryRetrieveInformationModelGet)
                # SCU proposes the storage context with ONLY Implicit VR LE.
                scu_ae.add_requested_context(
                    SecondaryCaptureImageStorage, transfer_syntax=ImplicitVRLittleEndian
                )
                role = build_role(SecondaryCaptureImageStorage, scp_role=True)

                assoc = scu_ae.associate(
                    "127.0.0.1", port,
                    ext_neg=[role],
                    evt_handlers=[(evt.EVT_C_STORE, handle_store)],
                )
                assert assoc.is_established

                query = Dataset()
                query.QueryRetrieveLevel = "STUDY"
                query.StudyInstanceUID = study_uid

                statuses = []
                for (status, _ident) in assoc.send_c_get(
                    query, StudyRootQueryRetrieveInformationModelGet
                ):
                    if status:
                        statuses.append(status.Status)

                assoc.release()

                # Both instances stored despite the EVRLE->Implicit VR LE mismatch.
                assert len(received) == 2
                assert set(received) == {i.instance_uid for i in instances}
                assert statuses[-1] == 0x0000
        finally:
            if scp is not None:
                scp.shutdown()
