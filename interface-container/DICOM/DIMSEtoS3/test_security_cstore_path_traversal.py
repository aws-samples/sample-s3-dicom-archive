"""Security: C-STORE SOPInstanceUID -> temp filename path traversal.

The C-STORE handler built the incoming temp filename straight from the
peer-supplied SOPInstanceUID (`temp_dir / f"{uid}.dcm"`). A crafted UID such as
"../../../tmp/evil" or an absolute path would let a peer write a .dcm outside
the incoming directory (pathlib's `/` even REPLACES the base when the right side
is absolute). The fix validates SOPInstanceUID against the DICOM UID grammar in
_validate_dataset and, as defense-in-depth, resolves the final path and asserts
it is contained in temp_dir before writing.

These are fast unit tests (no network): they drive is_valid_dicom_uid directly,
check _validate_dataset's reject decision, and exercise handle_c_store with a
hostile UID to prove nothing is written outside temp_dir. Placed alongside the
module's other test_security_*.py files (the established per-module convention).
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pydicom.dataset import Dataset  # noqa: E402

import dicom_handlers as dh  # noqa: E402


# UIDs that must be REJECTED: traversal, separators, absolute paths, empty /
# malformed components, over-length.
BAD_UIDS = [
    "../../../tmp/evil",
    "..",
    ".",
    "",
    "/etc/passwd",
    "1.2.3/../..",
    "1.2.3\\1.2.4",
    "1.2.3/1.2.4",
    "1..2",
    ".1.2",
    "1.2.",
    "1.2.3#",
    "1.2.3?x=1",
    "1.2.3 ",
    "abc.def",
    "1" * 65,          # 65 chars: exceeds the 64-char DICOM UID limit
    None,
]

# UIDs that must be ACCEPTED: valid DICOM UIDs.
GOOD_UIDS = [
    "1.2.840.10008.5.1.4.1.1.2",
    "1.2.3",
    "1",
    "1." + "2" * 62,   # 64 chars exactly (boundary)
]


class IsValidDicomUidTests(unittest.TestCase):
    def test_bad_uids_rejected(self):
        for u in BAD_UIDS:
            self.assertFalse(dh.is_valid_dicom_uid(u), f"should reject: {u!r}")

    def test_good_uids_accepted(self):
        for u in GOOD_UIDS:
            self.assertTrue(dh.is_valid_dicom_uid(u), f"should accept: {u!r}")

    def test_boundary_length(self):
        self.assertTrue(dh.is_valid_dicom_uid("1." + "2" * 62))   # 64 chars (valid)
        self.assertFalse(dh.is_valid_dicom_uid("1." + "2" * 63))  # 65 chars (too long)


def _handler(temp_dir):
    """A DICOMEventHandler with just the fields handle_c_store/_validate need,
    built without running __init__ (which would pull in the service registry)."""
    h = dh.DICOMEventHandler.__new__(dh.DICOMEventHandler)
    h.logger = mock.Mock()
    h.registry = mock.Mock()
    h.config = mock.Mock()
    h.temp_dir = Path(temp_dir)
    return h


def _dataset(sop_uid):
    ds = Dataset()
    ds.SOPInstanceUID = sop_uid
    ds.StudyInstanceUID = "1.2.3"
    ds.SeriesInstanceUID = "1.2.4"
    ds.SOPClassUID = "1.2.840.10008.5.1.4.1.1.2"
    return ds


class ValidateDatasetTests(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.mkdtemp(prefix="cstore_test_")
        self.h = _handler(self._td)

    def test_rejects_traversal_uid(self):
        self.assertFalse(self.h._validate_dataset(_dataset("../../../tmp/evil")))

    def test_rejects_absolute_uid(self):
        self.assertFalse(self.h._validate_dataset(_dataset("/etc/passwd")))

    def test_accepts_valid_uid(self):
        self.assertTrue(self.h._validate_dataset(_dataset("1.2.840.113619.2")))


class HandleCStoreContainmentTests(unittest.TestCase):
    """End-to-end on handle_c_store: a hostile UID must NEVER write outside the
    incoming temp_dir, and the operation must report a C-STORE failure."""

    def setUp(self):
        self._td = tempfile.mkdtemp(prefix="cstore_incoming_")
        self.h = _handler(self._td)
        # If validation were ever bypassed, _process_stored_dataset would run —
        # stub it so the test observes only the write decision, not S3/DB.
        self.h._process_stored_dataset = mock.Mock()

    def _event(self, ds):
        ev = mock.Mock()
        ev.dataset = ds
        ev.file_meta = Dataset()
        ev.assoc.requestor.ae_title = "PEER"
        return ev

    def test_traversal_uid_is_refused_and_writes_nothing_outside(self):
        # A UID that would escape to a sibling of temp_dir.
        escape_target = Path(self._td).parent / "ESCAPED.dcm"
        if escape_target.exists():
            escape_target.unlink()

        status = self.h.handle_c_store(self._event(_dataset("../ESCAPED")))

        # C-STORE failure status (non-zero).
        self.assertNotEqual(status, 0x0000)
        # Nothing was written outside the incoming dir.
        self.assertFalse(escape_target.exists(), "a file escaped temp_dir")
        # And the downstream processing was never reached.
        self.h._process_stored_dataset.assert_not_called()

    def test_absolute_path_uid_is_refused(self):
        status = self.h.handle_c_store(self._event(_dataset("/tmp/ABS_ESCAPE")))
        self.assertNotEqual(status, 0x0000)
        self.assertFalse(Path("/tmp/ABS_ESCAPE.dcm").exists())
        self.h._process_stored_dataset.assert_not_called()

    def test_valid_uid_writes_inside_temp_dir(self):
        # Mock Dataset.save_as so the test asserts the HANDLER's path/containment
        # decision independent of the installed pydicom version (the real
        # save_as kwarg `enforce_file_format` is pydicom 3.x only; the container
        # pins pydicom 3.x, but the local test env may be 2.x). The mock records
        # the path the handler chose and creates the file there.
        written_paths = []

        def fake_save_as(path, *a, **k):
            p = Path(path)
            p.write_bytes(b"DICM")
            written_paths.append(p)

        ds = _dataset("1.2.840.113619.2.55")
        # Patch on the INSTANCE (not the class) so the replacement is not bound
        # as a method — the handler calls ds.save_as(temp_file, ...), and an
        # instance attribute receives temp_file as its first positional arg.
        ds.save_as = fake_save_as
        status = self.h.handle_c_store(self._event(ds))

        self.assertEqual(status, 0x0000)
        expected = (Path(self._td).resolve() / "1.2.840.113619.2.55.dcm")
        self.assertEqual(written_paths, [expected])
        self.assertTrue(expected.exists(), "valid instance should be written inside temp_dir")
        self.h._process_stored_dataset.assert_called_once()


if __name__ == "__main__":
    unittest.main()
