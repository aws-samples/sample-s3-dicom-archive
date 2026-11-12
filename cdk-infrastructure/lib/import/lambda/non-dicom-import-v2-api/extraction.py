# PHI notice: this module handles Protected Health Information (patient name, ID,
# birth date, sex, accession number and other DICOM identifiers). Deployers are
# responsible for HIPAA (and, where applicable, GDPR) controls under the AWS shared
# responsibility model; use only synthetic data for testing. See PHI-HANDLING.md.
"""Extraction schema, validation and normalisation of the model's output.

The model is asked for JSON matching EXTRACTION_SCHEMA. Whatever it returns is
treated as untrusted: unknown keys are dropped, every value is type-checked,
length-capped and normalised (names to DICOM PN, dates to DA, sex to M/F/O).
A response whose top-level shape is wrong fails validation, which is the
escalation signal for the Sonnet retry.
"""
import datetime
import json
import math
import re
import unicodedata

# Field name -> (kind, max length of the normalised value).
#   pn  DICOM Person Name (one alphabetic component group, max 64 chars)
#   da  DICOM Date YYYYMMDD
#   sex M / F / O
#   lo  free text, single line
FIELD_SPECS = {
    'patientName': ('pn', 64),
    'patientId': ('lo', 64),
    'birthDate': ('da', 8),
    'sex': ('sex', 1),
    'documentDate': ('da', 8),
    'documentType': ('lo', 64),
    'documentTitle': ('lo', 255),
    'referringPhysician': ('pn', 64),
    'institution': ('lo', 64),
    'accessionNumber': ('lo', 16),
}
FIELD_NAMES = tuple(FIELD_SPECS)

# Fields that identify the patient. Reported in printedIdentifiers when found
# with confidence >= PRINTED_MIN_CONFIDENCE, so the UI can warn that they stay
# visible in a de-identified folder.
IDENTIFIER_FIELDS = ('patientName', 'patientId', 'birthDate', 'sex', 'accessionNumber')
PRINTED_MIN_CONFIDENCE = 0.5

EVIDENCE_MAX = 200

_FIELD_SCHEMA = {
    'type': ['object', 'null'],
    'properties': {
        'value': {'type': ['string', 'null']},
        'confidence': {'type': 'number', 'minimum': 0, 'maximum': 1},
        'evidence': {'type': ['string', 'null']},
    },
    'required': ['value', 'confidence'],
}

# JSON schema the model is told to follow (and that validate() enforces).
EXTRACTION_SCHEMA = {
    'type': 'object',
    'properties': {
        'fields': {
            'type': 'object',
            'properties': {name: _FIELD_SCHEMA for name in FIELD_NAMES},
        },
    },
    'required': ['fields'],
}


class SchemaError(ValueError):
    """The model output does not match EXTRACTION_SCHEMA."""


def parse_model_json(text):
    """Parse the model's reply into a dict. Tolerates code fences and prose
    around one JSON object; raises SchemaError when there is no object."""
    if not isinstance(text, str) or not text.strip():
        raise SchemaError('empty model output')
    s = text.strip()
    start = s.find('{')
    end = s.rfind('}')
    if start < 0 or end <= start:
        raise SchemaError('no JSON object in model output')
    try:
        obj = json.loads(s[start:end + 1])
    except ValueError as e:
        raise SchemaError(f'model output is not valid JSON: {e.__class__.__name__}') from None
    if not isinstance(obj, dict):
        raise SchemaError('model output is not a JSON object')
    return obj


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def validate(obj):
    """Validate the raw model object against EXTRACTION_SCHEMA.

    Strict about types, lenient about absence: a missing field is "not found".
    Unknown keys (top level, field names, per-field keys) are ignored, not
    errors, and dropped by normalise(). Raises SchemaError on a type mismatch.
    """
    if not isinstance(obj, dict):
        raise SchemaError('output is not an object')
    fields = obj.get('fields')
    if not isinstance(fields, dict):
        raise SchemaError('"fields" is missing or not an object')
    for name in FIELD_NAMES:
        if name not in fields or fields[name] is None:
            continue
        entry = fields[name]
        if not isinstance(entry, dict):
            raise SchemaError(f'field {name} is not an object')
        value = entry.get('value')
        if isinstance(value, bool) or (value is not None and not isinstance(value, (str, int, float))):
            raise SchemaError(f'field {name}.value has the wrong type')
        conf = entry.get('confidence')
        if not _is_number(conf) or conf < 0 or conf > 1:
            raise SchemaError(f'field {name}.confidence must be a number from 0 to 1')
        ev = entry.get('evidence')
        if ev is not None and not isinstance(ev, str):
            raise SchemaError(f'field {name}.evidence has the wrong type')
    return True


# --- value normalisers ------------------------------------------------------

_CONTROL_RE = re.compile(r'[\x00-\x1f\x7f]')
_WS_RE = re.compile(r'\s+')


def clean_text(value, max_len):
    """Single-line text: control chars removed, whitespace collapsed, capped."""
    if value is None:
        return None
    s = str(value)
    s = _CONTROL_RE.sub(' ', s)
    s = _WS_RE.sub(' ', s).strip()
    if not s:
        return None
    return s[:max_len].rstrip()


_TITLES = {'MR', 'MRS', 'MS', 'MISS', 'MX', 'DR', 'PROF', 'SIR', 'MME', 'MLLE', 'M', 'HERR', 'FRAU'}


def normalise_pn(value, max_len=64):
    """Free-text or PN name -> DICOM PN 'FAMILY^GIVEN^MIDDLE', upper case.

    'DOE^JANE' stays; 'Doe, Jane Mary' -> 'DOE^JANE^MARY'; 'Jane Mary Doe' ->
    'DOE^JANE^MARY'; titles (Mr, Dr, ...) are dropped. Only the alphabetic
    component group is kept (anything after '=' is dropped); backslash, which
    is the DICOM value separator, is removed.
    """
    s = clean_text(value, 512)
    if not s:
        return None
    s = s.split('=')[0].replace('\\', ' ').strip()
    if not s:
        return None
    if '^' in s:
        comps = [c.strip() for c in s.split('^')[:5]]
    elif ',' in s:
        family, rest = s.split(',', 1)
        rest_tokens = [t for t in rest.replace(',', ' ').split() if t.strip('.').upper() not in _TITLES]
        comps = [family.strip()]
        if rest_tokens:
            comps.append(rest_tokens[0])
        if len(rest_tokens) > 1:
            comps.append(' '.join(rest_tokens[1:]))
    else:
        tokens = [t for t in s.split() if t.strip('.').upper() not in _TITLES]
        if not tokens:
            return None
        if len(tokens) == 1:
            comps = [tokens[0]]
        else:
            comps = [tokens[-1], tokens[0]]
            if len(tokens) > 2:
                comps.append(' '.join(tokens[1:-1]))
    comps = [_WS_RE.sub(' ', c).strip().upper() for c in comps]
    while comps and not comps[-1]:
        comps.pop()
    if not comps or not any(comps):
        return None
    pn = '^'.join(comps)
    if len(pn) > max_len:
        pn = pn[:max_len].rstrip('^ ')
    return pn or None


_MONTHS = {
    'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
    'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12,
}


def _valid_date(y, m, d, today=None):
    today = today or datetime.date.today()
    try:
        dt = datetime.date(y, m, d)
    except ValueError:
        return None
    # A clinical date is never in the future; two days of slack covers time zones.
    if y < 1880 or dt > today + datetime.timedelta(days=2):
        return None
    return dt.strftime('%Y%m%d')


def normalise_da(value, today=None):
    """Date text -> DICOM DA 'YYYYMMDD', or None when invalid or ambiguous.

    Accepts YYYYMMDD, YYYY-MM-DD (also / or .), DD/MM/YYYY and MM/DD/YYYY when
    one of the first two numbers is above 12 (or both are equal), and English
    month names ('12 March 1980', 'March 12, 1980', '12-Mar-1980'). A date
    such as 03/04/1980 is ambiguous and is rejected rather than guessed.
    """
    s = clean_text(value, 64)
    if not s:
        return None
    s = s.strip().rstrip('.')
    m = re.fullmatch(r'(\d{4})(\d{2})(\d{2})', s)
    if m:
        return _valid_date(int(m[1]), int(m[2]), int(m[3]), today)
    m = re.fullmatch(r'(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})', s)
    if m:
        return _valid_date(int(m[1]), int(m[2]), int(m[3]), today)
    m = re.fullmatch(r'(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})', s)
    if m:
        a, b, y = int(m[1]), int(m[2]), int(m[3])
        if a > 12 and b <= 12:
            return _valid_date(y, b, a, today)
        if b > 12 and a <= 12:
            return _valid_date(y, a, b, today)
        if a == b:
            return _valid_date(y, a, b, today)
        return None
    m = re.fullmatch(r'(\d{1,2})[\s\-./]+([A-Za-z]{3,9})\.?[\s\-./,]+(\d{4})', s)
    if m and m[2][:3].lower() in _MONTHS:
        return _valid_date(int(m[3]), _MONTHS[m[2][:3].lower()], int(m[1]), today)
    m = re.fullmatch(r'([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})', s)
    if m and m[1][:3].lower() in _MONTHS:
        return _valid_date(int(m[3]), _MONTHS[m[1][:3].lower()], int(m[2]), today)
    return None


_SEX = {
    'm': 'M', 'male': 'M', 'man': 'M', 'homme': 'M', 'masculin': 'M',
    'f': 'F', 'female': 'F', 'woman': 'F', 'femme': 'F', 'feminin': 'F', 'féminin': 'F',
    'o': 'O', 'other': 'O', 'x': 'O', 'autre': 'O',
}


def normalise_sex(value):
    s = clean_text(value, 32)
    if not s:
        return None
    return _SEX.get(s.lower().strip('.'))


def normalise_value(kind, value, max_len, today=None):
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        value = str(int(value)) if float(value).is_integer() else str(value)
    if kind == 'pn':
        return normalise_pn(value, max_len)
    if kind == 'da':
        return normalise_da(value, today)
    if kind == 'sex':
        return normalise_sex(value)
    return clean_text(value, max_len)


def normalise(obj, today=None):
    """Validated model object -> {fieldName: {value, confidence, evidence} | None}.

    Every known field is present in the result; a field the model did not find,
    or whose value does not normalise (e.g. an ambiguous date), is None.
    """
    validate(obj)
    raw = obj['fields']
    out = {}
    for name, (kind, max_len) in FIELD_SPECS.items():
        entry = raw.get(name)
        if not isinstance(entry, dict):
            out[name] = None
            continue
        value = normalise_value(kind, entry.get('value'), max_len, today)
        if value is None:
            out[name] = None
            continue
        conf = float(entry.get('confidence'))
        out[name] = {
            'value': value,
            'confidence': round(min(1.0, max(0.0, conf)), 3),
            'evidence': clean_text(entry.get('evidence'), EVIDENCE_MAX),
        }
    return out


def empty_fields():
    return {name: None for name in FIELD_NAMES}


def overall_confidence(fields):
    """Mean confidence of the fields that were found; 0.0 when none were."""
    confs = [f['confidence'] for f in (fields or {}).values() if f]
    return round(sum(confs) / len(confs), 3) if confs else 0.0


def printed_identifiers(fields):
    return [name for name in IDENTIFIER_FIELDS
            if fields.get(name) and fields[name]['confidence'] >= PRINTED_MIN_CONFIDENCE]


def strip_accents(s):
    return ''.join(c for c in unicodedata.normalize('NFKD', s) if not unicodedata.combining(c))
