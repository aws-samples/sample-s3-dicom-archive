"""Security: what a virtual-folder reader receives is de-identified.

B-1  WADO retrieve of a folder object returns a de-identified Part 10 object
     (header rewritten, pixel data byte-identical), never the source object.
B-2  /bulk/element and /rendered read from de-identified values.
B-3  the profile reaches sequence items and private tags at every depth, and a
     profile that cannot be loaded refuses (503) instead of serving the source.
"""
import json
from io import BytesIO
from types import SimpleNamespace

import pydicom
import pytest
from pydicom.data import get_testdata_file
from pydicom.dataset import Dataset
from pydicom.sequence import Sequence

import vf_deid

VF = "aaaaaaaa-0000-4000-8000-0000000000b1"
SALT = "pepper:" + VF
PROFILE = [
    {"tag": "00100010", "action": "REMOVE"},          # PatientName
    {"tag": "00100020", "action": "HASH_16"},         # PatientID
    {"tag": "00100030", "action": "SHIFT_DATE", "shiftDaysMin": 3, "shiftDaysMax": 3},
    {"tag": "00080050", "action": "EMPTY"},           # AccessionNumber
    {"tag": "00081030", "action": "REPLACE", "replacement": "DEID"},
]
INDEX = vf_deid.build_action_index(PROFILE)


# ── engine: sequences + private tags ─────────────────────────────────────────
def test_json_profile_reaches_sequence_items_and_drops_nested_private():
    obj = {
        "00100010": {"vr": "PN", "Value": [{"Alphabetic": "DOE^JANE"}]},
        "00100020": {"vr": "LO", "Value": ["MRN1"]},
        "00101002": {"vr": "SQ", "Value": [{  # OtherPatientIDsSequence
            "00100020": {"vr": "LO", "Value": ["MRN-OTHER"]},
            "00100010": {"vr": "PN", "Value": [{"Alphabetic": "DOE^J"}]},
            "00091001": {"vr": "LO", "Value": ["private nested"]},
        }]},
        "00091010": {"vr": "LO", "Value": ["private top"]},
    }
    vf_deid.apply_profile_to_json(obj, INDEX, SALT)
    vf_deid.strip_private_json(obj)
    text = json.dumps(obj)
    for leaked in ("DOE^JANE", "DOE^J", "MRN1", "MRN-OTHER", "private nested", "private top"):
        assert leaked not in text, leaked
    assert obj["00101002"]["Value"][0]["00100020"]["Value"] == \
        [vf_deid.hash_value("MRN-OTHER", SALT, "LO", 16)]


def test_dataset_profile_matches_json_engine():
    ds = Dataset()
    ds.PatientName = "DOE^JANE"
    ds.PatientID = "MRN1"
    ds.PatientBirthDate = "19610304"
    ds.AccessionNumber = "ACC1"
    ds.StudyDescription = "CT CHEST"
    item = Dataset()
    item.PatientID = "MRN-OTHER"
    item.add_new(0x00091001, "LO", "private nested")
    ds.OtherPatientIDsSequence = Sequence([item])
    ds.add_new(0x00091010, "LO", "private top")
    vf_deid.apply_profile_to_dataset(ds, INDEX, SALT, drop_private=True)
    assert str(ds.PatientName) == "" and ds.AccessionNumber == ""
    assert ds.PatientID == vf_deid.hash_value("MRN1", SALT, "LO", 16)
    assert ds.PatientBirthDate == vf_deid.shift_date("19610304", PROFILE[2], SALT, "MRN1")
    assert ds.StudyDescription == "DEID"
    assert ds.OtherPatientIDsSequence[0].PatientID == vf_deid.hash_value("MRN-OTHER", SALT, "LO", 16)
    assert 0x00091010 not in ds and 0x00091001 not in ds.OtherPatientIDsSequence[0]


# ── B-1: Part 10 rewrite ─────────────────────────────────────────────────────
def _source_object(implicit=False):
    raw = open(get_testdata_file("CT_small.dcm"), "rb").read()
    ds = pydicom.dcmread(BytesIO(raw))
    ds.add_new(0x00091010, "LO", "private top")
    if implicit:
        ds.file_meta.TransferSyntaxUID = pydicom.uid.ImplicitVRLittleEndian
        ds.is_implicit_VR, ds.is_little_endian = True, True
    buf = BytesIO()
    ds.save_as(buf, write_like_original=True)
    raw = buf.getvalue()
    return raw, raw.rfind(b"\xe0\x7f\x10\x00"), ds


def _fake_s3(raw):
    def get(bucket, key, byte_range=None):
        data = raw
        if byte_range:
            a, _, b = byte_range[len("bytes="):].partition("-")
            data = raw[int(a): (int(b) + 1) if b else None]
        return {"Body": SimpleNamespace(read=lambda: data,
                                        iter_chunks=lambda chunk_size: iter([data])),
                "ContentLength": len(data)}
    return get


@pytest.mark.parametrize("implicit", [False, True])
@pytest.mark.parametrize("use_offset", [True, False])
def test_folder_retrieve_returns_deidentified_part10_with_original_pixels(service, monkeypatch, use_offset, implicit):
    main = service.main
    raw, pixel_at, src = _source_object(implicit)
    monkeypatch.setattr(main, "_s3_get", _fake_s3(raw))
    row = {"bucketname": "b", "s3key": "k", "member_offset": None, "member_length": None,
           "metadataendoffset": pixel_at if use_offset else None}
    out = b"".join(main._deid_part10_chunks(row, (INDEX, True, SALT)))
    ds = pydicom.dcmread(BytesIO(out))
    assert str(ds.PatientName) == ""
    assert ds.PatientID == vf_deid.hash_value(src.PatientID, SALT, "LO", 16)
    assert 0x00091010 not in ds
    assert ds.PixelData == src.PixelData            # pixels untouched
    assert ds.SOPInstanceUID == src.SOPInstanceUID  # v1 keeps UIDs
    assert str(src.PatientName).encode() not in out
    assert ds.file_meta.TransferSyntaxUID == src.file_meta.TransferSyntaxUID


def test_full_read_is_capped_when_offset_unknown(service, monkeypatch):
    main = service.main
    raw, _, _ = _source_object()
    monkeypatch.setattr(main, "_s3_get", _fake_s3(raw))
    monkeypatch.setattr(main, "VF_DEID_FULL_READ_MAX_BYTES", 100)
    row = {"bucketname": "b", "s3key": "k", "member_offset": None, "member_length": None,
           "metadataendoffset": None}
    with pytest.raises(ValueError):
        b"".join(main._deid_part10_chunks(row, (INDEX, False, SALT)))


# ── B-3: profile loading fails closed ────────────────────────────────────────
def _ctx(service, monkeypatch, rows=None, error=None):
    main = service.main
    monkeypatch.setenv('DEID_HASH_PEPPER', 'test-pepper')
    monkeypatch.setattr(vf_deid, '_PEPPER_CACHE', None)

    def q(sql, params):
        if error:
            raise error
        return rows
    monkeypatch.setattr(main, "_execute_query", q)
    with service.app.test_request_context("/"):
        main.g.identity = SimpleNamespace(virtual_folder_id=VF, datastore_id="")
        return main._vf_deid_context()


def test_profile_db_error_refuses(service, monkeypatch):
    with pytest.raises(service.main.VfDeidUnavailable):
        _ctx(service, monkeypatch, error=RuntimeError("db down"))


def test_missing_or_unreadable_profile_refuses(service, monkeypatch):
    for rows in ([{"deid_profile_id": "p1", "profile_id": None, "tag_actions": None, "drop_private_tags": 0}],
                 [{"deid_profile_id": "p1", "profile_id": "p1", "tag_actions": "{not json", "drop_private_tags": 0}],
                 [{"deid_profile_id": "p1", "profile_id": "p1", "tag_actions": '{"a":1}', "drop_private_tags": 0}],
                 []):
        with pytest.raises(service.main.VfDeidUnavailable):
            _ctx(service, monkeypatch, rows=rows)


def test_folder_without_profile_is_not_deidentified(service, monkeypatch):
    ctx = _ctx(service, monkeypatch, rows=[{"deid_profile_id": None, "profile_id": None,
                                             "tag_actions": None, "drop_private_tags": 0}])
    assert ctx[0] == {} and ctx[1] is False
    assert not service.main._vf_deid_active(ctx)


def test_folder_request_without_a_pepper_refuses(service, monkeypatch):
    main = service.main
    monkeypatch.delenv('DEID_HASH_PEPPER', raising=False)
    monkeypatch.delenv('DEID_HASH_PEPPER_SECRET_NAME', raising=False)
    monkeypatch.setattr(vf_deid, '_PEPPER_CACHE', None)
    monkeypatch.setattr(main, "_execute_query", lambda sql, p: [{"deid_profile_id": None, "profile_id": None,
                                                                    "tag_actions": None, "drop_private_tags": 0}])
    with service.app.test_request_context("/"):
        main.g.identity = SimpleNamespace(virtual_folder_id=VF, datastore_id="")
        with pytest.raises(main.VfDeidUnavailable):
            main._vf_deid_context()


def test_storage_request_has_no_context(service, monkeypatch):
    main = service.main
    with service.app.test_request_context("/"):
        main.g.identity = SimpleNamespace(virtual_folder_id=None, datastore_id="ds")
        assert main._vf_deid_context() is None


# ── B-7: STOW never overwrites ───────────────────────────────────────────────
def test_stow_conditional_put(service, monkeypatch):
    import hashlib
    main = service.main
    store = {}

    class S3:
        def put_object(self, Bucket, Key, Body, ContentType, IfNoneMatch=None):
            assert IfNoneMatch == '*'
            if Key in store:
                raise main.ClientError({'Error': {'Code': 'PreconditionFailed'},
                                        'ResponseMetadata': {'HTTPStatusCode': 412}}, 'PutObject')
            store[Key] = Body

        def head_object(self, Bucket, Key):
            return {'ETag': '"%s"' % hashlib.md5(store[Key]).hexdigest()}
    monkeypatch.setattr(main, 's3_client', S3())
    assert main._put_if_absent_or_identical('b', 'k', b'one') is True
    assert main._put_if_absent_or_identical('b', 'k', b'one') is True      # identical re-send
    assert main._put_if_absent_or_identical('b', 'k', b'two') is False     # different bytes refused
    assert store['k'] == b'one'


def test_stow_uid_validation(service):
    ok, bad = service.main._is_dicom_uid, ['1.2/../x', '', 'abc', '1..2', '1.' * 40, None]
    assert ok('1.2.840.10008.1.2') and ok('2.25.123')
    assert not any(ok(b) for b in bad)


# ── D-6: keyed hashing, same values as the JS indexer ────────────────────────
def test_keyed_hash_vectors_match_the_indexer():
    # Values produced by hashValue / hashUid / shiftDate in virtual-folder-indexer/index.js.
    assert vf_deid.hash_value('MRN1', 'pep:vf', 'LO', 16) == 'e8ef55f86b082c8f'
    assert vf_deid.hash_uid('1.2.3', 'pep:vf') == '2.25.695757587007268595812842039316285979'
    assert vf_deid.shift_date('20200101', {'shiftDaysMin': 1, 'shiftDaysMax': 30}, 'pep:vf', 'MRN1') == '20200126'


def test_missing_pepper_refuses(monkeypatch):
    monkeypatch.delenv('DEID_HASH_PEPPER', raising=False)
    monkeypatch.delenv('DEID_HASH_PEPPER_SECRET_NAME', raising=False)
    monkeypatch.setattr(vf_deid, '_PEPPER_CACHE', None)
    with pytest.raises(RuntimeError):
        vf_deid.effective_salt(VF)
