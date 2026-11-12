"""Virtual-folder de-identification engine — Python port of the action engine in
virtual-folder-indexer/index.js, used to de-identify DICOM-JSON header elements
ON THE FLY at WADO /metadata retrieve for a VF-scoped request.

CONSISTENCY CONTRACT (docs/INDEX-ATTRIBUTES-REDESIGN.md §F): this MUST produce
the SAME value the indexer wrote into the virtual_* columns, so a hashed/shifted
tag reads identically whether it came from the indexed column (QIDO search) or
the on-the-fly metadata (retrieve). Every algorithm below mirrors the JS:

  * values are keyed with HMAC-SHA256(key=salt, msg=value), salt =
    "{pepper}:{vf_id}" (was SHA-256 of "{salt}:{value}");
  * UID hashing uses root "2.25." + decimal of the first 30 hex chars of the
    SHA-256 digest (BigInt in JS; int in Python);
  * non-UID HASH truncates the SHA-256 hex to N chars (HASH=64, _8/_16/_32);
  * SHIFT_DATE seeds HMAC-SHA256(salt, patientId) and offsets by
    min + (uint32_be(digest[0:4]) % (max-min+1)) days;
  * actions: HASH, HASH_8, HASH_16, HASH_32, REMOVE, EMPTY, REPLACE, SHIFT_DATE,
    KEEP. REMOVE/EMPTY -> None (blank the element).

Header ELEMENTS ONLY. Pixel/frame/bulk de-id is out of scope.
"""
import datetime
import hashlib
import hmac
import os

# S7 (option A): the de-id hash pepper is resolved LAZILY and CACHED, so the
# container never needs it at startup and the first use happens long after the
# task role's IAM policy has propagated. Resolution order, highest first:
#   1. DEID_HASH_PEPPER            — plain env (if ever injected directly)
#   2. DEID_HASH_PEPPER_SECRET_NAME — Secrets Manager secret fetched via the
#      task role with boto3 (the ECS `secrets:` injection path is NOT used, so
#      there is no start-time GetSecretValue gate that can fail the task).
#   3. '' — no pepper configured; salt falls back to the bare VF id.
# A module-level sentinel caches the first resolution (including an empty one),
# so Secrets Manager is hit at most once per container.
_PEPPER_CACHE = None  # None = not yet resolved; str = resolved (possibly '')


def _resolve_pepper() -> str:
    global _PEPPER_CACHE
    if _PEPPER_CACHE is not None:
        return _PEPPER_CACHE
    val = os.environ.get('DEID_HASH_PEPPER', '')
    if not val:
        secret_name = os.environ.get('DEID_HASH_PEPPER_SECRET_NAME', '')
        if secret_name:
            # Security: a pepper that is configured but cannot be read is an
            # error, never a silent fallback to the public folder id (that wrote
            # brute-forceable pseudonyms that also disagreed with the indexer).
            # Nothing is cached on failure, so the next request retries.
            import boto3  # local import so unit tests without boto3 still load
            region = os.environ.get('AWS_REGION') or os.environ.get('AWS_DEFAULT_REGION')
            client = boto3.client('secretsmanager', region_name=region)
            resp = client.get_secret_value(SecretId=secret_name)
            val = resp.get('SecretString') or ''
            if not val:
                raise RuntimeError('de-id pepper secret is empty')
    _PEPPER_CACHE = val
    return val


def effective_salt(vf_id: str) -> str:
    """S7: prepend the per-deployment SECRET pepper to the VF id, so the de-id
    hash salt is "{pepper}:{vf_id}" instead of the (non-secret) VF id alone.
    MUST match the JS indexer's effectiveSalt() exactly, or index-time and
    query-time hashes diverge. The pepper is resolved lazily/cached (see
    _resolve_pepper); when unset, falls back to the bare VF id so existing
    data/deployments are unchanged until the pepper is configured AND the VF is
    re-indexed."""
    pepper = _resolve_pepper()
    if not pepper:
        # Security: never fall back to the public folder id as the only salt.
        raise RuntimeError('de-id pepper is not configured')
    return f"{pepper}:{vf_id}"


def _keyed_hex(salt: str, text: str) -> str:
    """Security: HMAC-SHA256 keyed by the (peppered) salt. MUST match the JS
    indexer's keyedHex() byte for byte."""
    return hmac.new(str(salt).encode('utf-8'), str(text).encode('utf-8'), hashlib.sha256).hexdigest()


def hash_uid(uid_value: str, salt: str) -> str:
    """'2.25.' + decimal of the first 30 hex chars of HMAC-SHA256(salt, uid)."""
    h = _keyed_hex(salt, uid_value)
    return '2.25.' + str(int(h[:30], 16))


def hash_value(value: str, salt: str, vr: str, max_length: int) -> str:
    h = _keyed_hex(salt, value)
    # JS: for UI VR, return the UID form regardless of max_length.
    if vr == 'UI':
        return '2.25.' + str(int(h[:30], 16))
    return h[:(max_length or 64)]


def shift_date(date_value: str, action_rule: dict, salt: str, patient_id: str) -> str:
    if not date_value or len(str(date_value)) < 8 or not str(date_value)[:8].isdigit():
        return date_value
    dv = str(date_value)
    _min = action_rule.get('shiftDaysMin') or 0
    _max = action_rule.get('shiftDaysMax')
    if _max is None:
        _max = 365
    digest = hmac.new(str(salt).encode('utf-8'), str(patient_id).encode('utf-8'), hashlib.sha256).digest()
    span = (_max - _min + 1)
    if span <= 0:
        span = 1
    offset = _min + (int.from_bytes(digest[0:4], 'big') % span)
    y = int(dv[0:4]); m = int(dv[4:6]); d = int(dv[6:8])
    try:
        base = datetime.date(y, m, d)
    except ValueError:
        return date_value
    shifted = base + datetime.timedelta(days=offset)
    return f"{shifted.year:04d}{shifted.month:02d}{shifted.day:02d}"


def apply_deid_action(original_value, tag_id: str, action_rule: dict, salt: str,
                      vr: str, patient_id: str):
    """Apply one profile action to one value. Mirrors JS applyDeidAction.
    Returns the transformed value, or None when the tag is removed/emptied.
    `action_rule` is the tag_actions entry already matched to this tag."""
    if not action_rule or original_value is None or original_value == '':
        return original_value
    action = action_rule.get('action')
    if action in ('REMOVE', 'EMPTY'):
        return None
    if action == 'HASH':
        return hash_uid(original_value, salt) if vr == 'UI' else hash_value(original_value, salt, vr, 64)
    if action == 'HASH_8':
        return hash_value(original_value, salt, vr, 8)
    if action == 'HASH_16':
        return hash_value(original_value, salt, vr, 16)
    if action == 'HASH_32':
        return hash_value(original_value, salt, vr, 32)
    if action == 'KEEP':
        return original_value
    if action == 'REPLACE':
        # profile-api persists the fixed value as `replacement`; older records
        # used `value`. Honor both (matches JS).
        rep = action_rule.get('replacement')
        if rep is None:
            rep = action_rule.get('value')
        return rep or None
    if action == 'SHIFT_DATE':
        return shift_date(original_value, action_rule, salt, patient_id)
    return original_value


def _norm_tag(t) -> str:
    """Normalize a tag to 8-hex uppercase, no comma (e.g. '0010,0010'->'00100010').
    Both the profile tag_actions keys and the DICOM-JSON element keys are
    normalized to this form before matching, so either stored form works."""
    if t is None:
        return ''
    s = ''.join(ch for ch in str(t) if ch in '0123456789abcdefABCDEF')
    return s.upper()


def build_action_index(tag_actions):
    """tag_actions (list of {tag, action, ...}) -> {normalized_tag: rule}."""
    idx = {}
    if not isinstance(tag_actions, list):
        return idx
    for rule in tag_actions:
        if isinstance(rule, dict) and rule.get('tag') is not None:
            idx[_norm_tag(rule.get('tag'))] = rule
    return idx


# DICOM-JSON PN value form is {"Alphabetic": "..."} (also Ideographic/Phonetic).
def _scalar_from_json_value(v):
    if isinstance(v, dict):
        return v.get('Alphabetic') or next(iter(v.values()), None)
    return v


def _json_value_for(vr: str, val):
    """Wrap a scalar back into the DICOM-JSON Value form for its VR."""
    if vr == 'PN':
        return [{'Alphabetic': str(val)}]
    return [str(val)]


def apply_profile_to_json(obj: dict, action_index: dict, salt: str,
                          patient_id: str = None) -> None:
    """Apply the VF de-id profile to EVERY covered element of a DICOM-JSON object,
    in place, INCLUDING elements nested in sequences (a PatientName
    inside e.g. OtherPatientIDsSequence or ReferencedPatientSequence used to pass
    through). PatientID (0010,0020) of the top-level object seeds SHIFT_DATE.

    Only elements whose (normalized) tag has an action rule are transformed; a
    REMOVE/EMPTY rule on a sequence empties the whole sequence."""
    if not action_index:
        return
    if patient_id is None:
        patient_id = ''
        pid_el = obj.get('00100020') or obj.get('00100020'.lower())
        if isinstance(pid_el, dict) and pid_el.get('Value'):
            patient_id = _scalar_from_json_value(pid_el['Value'][0]) or ''

    for json_tag in list(obj.keys()):
        el = obj.get(json_tag)
        if not isinstance(el, dict):
            continue
        norm = _norm_tag(json_tag)
        rule = action_index.get(norm)
        vr = el.get('vr') or ''
        values = el.get('Value')
        if vr == 'SQ':
            if rule and rule.get('action') in ('REMOVE', 'EMPTY'):
                el['Value'] = []
                continue
            for item in values or []:
                if isinstance(item, dict):
                    apply_profile_to_json(item, action_index, salt, patient_id)
            continue
        if not rule:
            continue
        if not values:
            # No value to transform; a REMOVE/EMPTY still blanks it.
            if rule.get('action') in ('REMOVE', 'EMPTY'):
                el['Value'] = []
            continue
        new_values = []
        removed = False
        for v in values:
            scalar = _scalar_from_json_value(v)
            out = apply_deid_action(None if scalar is None else str(scalar),
                                    norm, rule, salt, vr, patient_id)
            if out is None:
                removed = True
                continue
            new_values.extend(_json_value_for(vr, out))
        if removed and not new_values:
            el['Value'] = []
        else:
            el['Value'] = new_values
        # A transformed element must not keep a pointer to the original bytes.
        el.pop('BulkDataURI', None)
        el.pop('InlineBinary', None)


def strip_private_json(obj: dict) -> None:
    """Remove private elements (odd group, PS3.5 7.8.1) from a DICOM-JSON object
    in place, at every sequence depth."""
    for tag in list(obj.keys()):
        try:
            group = int(str(tag)[:4], 16)
        except (ValueError, TypeError):
            continue
        if group % 2 == 1:
            del obj[tag]
            continue
        el = obj.get(tag)
        if isinstance(el, dict) and el.get('vr') == 'SQ':
            for item in el.get('Value') or []:
                if isinstance(item, dict):
                    strip_private_json(item)


# VRs whose value is raw bytes. A profile cannot hash or shift raw bytes the
# way the indexer does for text, so any non-KEEP rule on one blanks it.
_BINARY_VRS = {'OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'UN'}
_NUMERIC_VRS = {'US', 'SS', 'UL', 'SL', 'FL', 'FD', 'AT', 'UV', 'SV'}


def apply_profile_to_dataset(ds, action_index: dict, salt: str, drop_private: bool,
                             patient_id: str = None) -> None:
    """pydicom counterpart of apply_profile_to_json + strip_private_json, used
    for responses built from the object itself (WADO retrieve, /bulk/element;
    see above). Same engine, same salt, so a value reads identically in
    QIDO, /metadata and the retrieved object. In place, every sequence depth.
    REMOVE/EMPTY blank the element (value emptied, element kept), as the JSON
    path does, so type-2 attributes stay present."""
    if patient_id is None:
        try:
            patient_id = str(ds.get('PatientID', '') or '')
        except Exception:
            patient_id = ''
    for elem in list(ds):
        tag = elem.tag
        if drop_private and tag.is_private:
            del ds[tag]
            continue
        rule = action_index.get(f"{int(tag):08X}") if action_index else None
        action = rule.get('action') if rule else None
        if elem.VR == 'SQ':
            if action in ('REMOVE', 'EMPTY'):
                elem.value = []
                continue
            for item in elem.value or []:
                apply_profile_to_dataset(item, action_index, salt, drop_private, patient_id)
            continue
        if not rule or action == 'KEEP':
            continue
        if elem.VR in _BINARY_VRS or isinstance(elem.value, (bytes, bytearray)):
            elem.value = b''
            continue
        if elem.VR in _NUMERIC_VRS:
            elem.value = None
            continue
        if action in ('REMOVE', 'EMPTY') or elem.value is None or elem.value == '':
            elem.value = ''
            continue
        multi = not isinstance(elem.value, (str, bytes)) and hasattr(elem.value, '__iter__')
        values = list(elem.value) if multi else [elem.value]
        out = []
        for v in values:
            r = apply_deid_action(str(v), f"{int(tag):08X}", rule, salt, elem.VR, patient_id)
            if r is not None and r != '':
                out.append(r)
        if not out:
            elem.value = ''
        elif len(out) == 1:
            elem.value = out[0]
        else:
            elem.value = out
