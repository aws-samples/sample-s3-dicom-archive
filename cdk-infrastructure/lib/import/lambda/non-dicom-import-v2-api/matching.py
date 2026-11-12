"""Patient matching in code (never by the model).

Scores destination patients against the extracted fields: exact patient ID is
the strongest signal, then the name (case, accents, PN component order and
Levenshtein distance are tolerated), birth date and sex. The model only
supplies the extracted values; the ranking is deterministic and never
auto-selects a patient.
"""
import re

from extraction import strip_accents

W_ID = 0.50
W_NAME = 0.30
W_BIRTH = 0.15
W_SEX = 0.05
PENALTY_ID = 0.05
PENALTY_BIRTH = 0.10
PENALTY_SEX = 0.05

MAX_CANDIDATES = 5

_TOKEN_SPLIT = re.compile(r"[\s^,.'\-]+")
_ID_STRIP = re.compile(r'[^0-9A-Za-z]')
_LEADING_ZEROS = re.compile(r'(?<![0-9])0+(?=[0-9])')


def name_tokens(name):
    """Lower-case, accent-free tokens of a PN or free-text name."""
    if not name:
        return []
    s = strip_accents(str(name).split('=')[0]).lower()
    return [t for t in _TOKEN_SPLIT.split(s) if t]


def levenshtein(a, b):
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def token_similarity(a, b):
    if not a or not b:
        return 0.0
    return 1.0 - levenshtein(a, b) / max(len(a), len(b))


def name_similarity(a, b):
    """0..1 similarity of two names, independent of component order.

    Each token of the shorter name is paired with its best match in the longer
    one; the mean of those similarities is lightly penalised when the names
    have a different number of tokens (a missing middle name costs little).
    """
    ta, tb = name_tokens(a), name_tokens(b)
    if not ta or not tb:
        return 0.0
    if sorted(ta) == sorted(tb):
        return 1.0
    short, long_ = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
    remaining = list(long_)
    total = 0.0
    for t in short:
        best_i, best = 0, -1.0
        for i, u in enumerate(remaining):
            s = token_similarity(t, u)
            if s > best:
                best_i, best = i, s
        total += max(best, 0.0)
        if remaining:
            remaining.pop(best_i)
    mean = total / len(short)
    coverage = len(short) / len(long_)
    return round(mean * (0.85 + 0.15 * coverage), 4)


def normalise_id(pid):
    return str(pid).strip().upper() if pid is not None else ''


def loose_id(pid):
    """ID without punctuation and without leading zeros in its digit runs:
    'MRN-00123' and 'mrn123' both give 'MRN123'."""
    return _LEADING_ZEROS.sub('', _ID_STRIP.sub('', pid))


def _value(fields, name):
    f = (fields or {}).get(name)
    return f.get('value') if isinstance(f, dict) else None


def score_candidate(fields, cand):
    """Score one patient row ({patientId, patientName, birthDate, sex}).

    Returns (score 0..1, [reasons]). Weights: ID 0.50, name 0.30, birth date
    0.15, sex 0.05; a conflicting ID, birth date or sex subtracts a little.
    """
    score = 0.0
    reasons = []

    ext_id = normalise_id(_value(fields, 'patientId'))
    cand_id = normalise_id(cand.get('patientId'))
    if ext_id and cand_id:
        if ext_id == cand_id:
            score += W_ID
            reasons.append('ID matches exactly')
        elif loose_id(ext_id) and loose_id(ext_id) == loose_id(cand_id):
            score += W_ID * 0.8
            reasons.append('ID matches when formatting is ignored')
        else:
            score -= PENALTY_ID
            reasons.append('ID differs')

    ext_name = _value(fields, 'patientName')
    cand_name = cand.get('patientName')
    if ext_name and cand_name:
        sim = name_similarity(ext_name, cand_name)
        if sim >= 0.999:
            score += W_NAME
            reasons.append('name matches')
        elif sim >= 0.75:
            score += W_NAME * sim
            reasons.append('name is similar')
        elif sim >= 0.5:
            score += W_NAME * sim * 0.5
            reasons.append('name is partly similar')
        else:
            reasons.append('name differs')

    ext_bd = _value(fields, 'birthDate')
    cand_bd = cand.get('birthDate')
    if ext_bd and cand_bd:
        if ext_bd == cand_bd:
            score += W_BIRTH
            reasons.append('birth date matches')
        else:
            score -= PENALTY_BIRTH
            reasons.append('birth date differs')

    ext_sex = _value(fields, 'sex')
    cand_sex = (cand.get('sex') or '').strip().upper()[:1]
    if ext_sex and cand_sex in ('M', 'F', 'O'):
        if ext_sex == cand_sex:
            score += W_SEX
            reasons.append('sex matches')
        else:
            score -= PENALTY_SEX
            reasons.append('sex differs')

    return round(min(1.0, max(0.0, score)), 3), reasons


def rank_candidates(fields, patients, limit=MAX_CANDIDATES):
    """Top `limit` patients with a positive score, best first."""
    scored = []
    for p in patients:
        s, reasons = score_candidate(fields, p)
        if s > 0:
            scored.append({**p, 'score': s, 'reasons': reasons})
    scored.sort(key=lambda c: (-c['score'], c.get('patientName') or '', c.get('patientId') or ''))
    return scored[:limit]


def search_terms(fields):
    """Values used to fetch candidate rows from the destination (SQL prefilter):
    the extracted ID, birth date and name tokens of at least 2 characters."""
    pid = _value(fields, 'patientId')
    bd = _value(fields, 'birthDate')
    toks = [t for t in name_tokens(_value(fields, 'patientName')) if len(t) >= 2][:4]
    return pid, bd, toks
