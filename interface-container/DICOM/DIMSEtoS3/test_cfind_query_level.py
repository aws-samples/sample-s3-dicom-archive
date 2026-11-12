"""C-FIND query-level determination + QIDO resource-path construction.

Regression coverage for the hierarchical C-GET/C-MOVE retrieve path that Weasis
(and any hierarchical SCU) exercises. Two bugs were fixed here:

  1. _determine_query_level ignored the explicit QueryRetrieveLevel (0008,0052)
     element and inferred the level from which UIDs were non-empty. A study->series
     expansion sends QueryRetrieveLevel=SERIES with a populated StudyInstanceUID and
     an EMPTY SeriesInstanceUID (universal matching = "all series in this study"),
     which was misread as STUDY -> queried the `studies` path -> returned the study,
     not its series -> SCU reported "No series found" and never issued the C-GET.

  2. _build_qido_resource_path promoted the StudyInstanceUID (and, at instance level,
     the SeriesInstanceUID) into the QIDO resource PATH but ALSO left it in the query
     params. dicomweb-s3 rejects a path-scoped UID as a search key:
     `400 Unsupported search key: StudyInstanceUID` -> 0 results.

These paths are in the DIMSE container and are shared by BOTH network modes
(public/CloudFront and in-VPC), so the fix applies everywhere.
"""
from pydicom.dataset import Dataset

import cfind_handler


def _handler():
    # Bypass __init__ (needs a registry + config); we only exercise pure methods.
    return cfind_handler.CFindHandler.__new__(cfind_handler.CFindHandler)


def _ds(**attrs):
    ds = Dataset()
    for k, v in attrs.items():
        setattr(ds, k, v)
    return ds


# ───────────────────── _determine_query_level ─────────────────────

def test_explicit_series_level_honored_even_with_empty_series_uid():
    """The Weasis study->series expansion: QRL=SERIES, Study set, Series EMPTY."""
    h = _handler()
    ds = _ds(QueryRetrieveLevel='SERIES', StudyInstanceUID='1.2.3', SeriesInstanceUID='')
    assert h._determine_query_level(ds) == 'SERIES'


def test_explicit_study_level_honored():
    h = _handler()
    assert h._determine_query_level(_ds(QueryRetrieveLevel='STUDY')) == 'STUDY'


def test_explicit_patient_level_honored():
    h = _handler()
    assert h._determine_query_level(_ds(QueryRetrieveLevel='PATIENT')) == 'PATIENT'


def test_image_level_maps_to_instance():
    """DICOM retrieve level is IMAGE; this handler's instance level is INSTANCE."""
    h = _handler()
    ds = _ds(QueryRetrieveLevel='IMAGE', StudyInstanceUID='1.2.3',
             SeriesInstanceUID='1.2.3.4', SOPInstanceUID='')
    assert h._determine_query_level(ds) == 'INSTANCE'


def test_query_retrieve_level_is_case_insensitive():
    h = _handler()
    assert h._determine_query_level(_ds(QueryRetrieveLevel='series')) == 'SERIES'


def test_fallback_infers_from_uids_when_level_absent():
    """No QueryRetrieveLevel -> fall back to UID-presence inference (legacy)."""
    h = _handler()
    assert h._determine_query_level(_ds(StudyInstanceUID='1.2.3')) == 'STUDY'
    assert h._determine_query_level(_ds(SeriesInstanceUID='1.2.3.4')) == 'SERIES'
    assert h._determine_query_level(_ds(SOPInstanceUID='1.2.3.4.5')) == 'INSTANCE'
    assert h._determine_query_level(_ds()) == 'PATIENT'


def test_unrecognized_level_falls_back_to_inference():
    h = _handler()
    # A junk QRL value is ignored; inference from the populated study UID wins.
    assert h._determine_query_level(_ds(QueryRetrieveLevel='BOGUS',
                                        StudyInstanceUID='1.2.3')) == 'STUDY'


# ───────────────────── _build_qido_resource_path ─────────────────────

def test_series_path_strips_study_uid_from_params():
    h = _handler()
    path, params = h._build_qido_resource_path('SERIES', {'StudyInstanceUID': '1.2.3'})
    assert path == 'studies/1.2.3/series'
    # StudyInstanceUID is in the PATH, so it must NOT remain a query search key
    # (dicomweb-s3 returns 400 Unsupported search key otherwise).
    assert 'StudyInstanceUID' not in params


def test_instance_path_strips_both_uids_from_params():
    h = _handler()
    path, params = h._build_qido_resource_path(
        'INSTANCE', {'StudyInstanceUID': '1.2.3', 'SeriesInstanceUID': '1.2.3.4'})
    assert path == 'studies/1.2.3/series/1.2.3.4/instances'
    assert 'StudyInstanceUID' not in params
    assert 'SeriesInstanceUID' not in params


def test_study_level_keeps_study_uid_as_search_key():
    """At STUDY level the study UID IS a valid QIDO search key, so it stays."""
    h = _handler()
    path, params = h._build_qido_resource_path(
        'STUDY', {'StudyInstanceUID': '1.2.3', 'PatientID': 'X'})
    assert path == 'studies'
    assert params.get('StudyInstanceUID') == '1.2.3'
    assert params.get('PatientID') == 'X'


def test_series_level_without_study_uid_lists_studies():
    """Defensive: a SERIES level with no study UID can't scope a /series path."""
    h = _handler()
    path, params = h._build_qido_resource_path('SERIES', {})
    assert path == 'studies'


def test_non_path_params_are_preserved_at_series_level():
    """Only the path-promoted UID is stripped; other filters survive."""
    h = _handler()
    path, params = h._build_qido_resource_path(
        'SERIES', {'StudyInstanceUID': '1.2.3', 'Modality': 'CT'})
    assert path == 'studies/1.2.3/series'
    assert params.get('Modality') == 'CT'
    assert 'StudyInstanceUID' not in params


def test_build_path_does_not_mutate_caller_params():
    """The builder returns a COPY; the caller's dict is untouched."""
    h = _handler()
    original = {'StudyInstanceUID': '1.2.3'}
    h._build_qido_resource_path('SERIES', original)
    assert original == {'StudyInstanceUID': '1.2.3'}
