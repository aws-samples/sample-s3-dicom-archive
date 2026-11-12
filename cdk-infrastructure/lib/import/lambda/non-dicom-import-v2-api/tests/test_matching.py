import matching as m


def F(**kw):
    """Normalised-fields dict as extraction.normalise() returns it."""
    out = {}
    for k, v in kw.items():
        out[k] = {'value': v, 'confidence': 0.9, 'evidence': None}
    return out


JANE = {'patientId': 'MRN123', 'patientName': 'DOE^JANE', 'birthDate': '19800101', 'sex': 'F'}


def test_levenshtein():
    assert m.levenshtein('kitten', 'sitting') == 3
    assert m.levenshtein('', 'abc') == 3
    assert m.levenshtein('abc', 'abc') == 0


def test_name_similarity_order_case_accents():
    assert m.name_similarity('DOE^JANE', 'Jane Doe') == 1.0
    assert m.name_similarity('MÜLLER^JÜRGEN', 'muller^jurgen') == 1.0
    assert 0.85 < m.name_similarity('DOE^JANE', 'DOE^JAINE') < 1.0          # one typo
    assert 0.85 < m.name_similarity('DOE^JANE^MARIE', 'DOE^JANE') < 1.0     # missing middle name
    assert m.name_similarity('DOE^JANE', 'SMITH^JOHN') < 0.5
    assert m.name_similarity('', 'DOE') == 0.0


def test_exact_id_name_birth_sex_is_top_score():
    score, reasons = m.score_candidate(F(patientId='MRN123', patientName='DOE^JANE', birthDate='19800101', sex='F'), JANE)
    assert score == 1.0
    assert reasons == ['ID matches exactly', 'name matches', 'birth date matches', 'sex matches']


def test_id_alone_is_strongest_signal():
    id_only, _ = m.score_candidate(F(patientId='MRN123'), JANE)
    name_birth, _ = m.score_candidate(F(patientName='Jane Doe', birthDate='19800101'), JANE)
    assert id_only == 0.5
    assert name_birth == 0.45
    assert id_only > name_birth


def test_id_formatting_and_case():
    score, reasons = m.score_candidate(F(patientId='mrn123'), JANE)
    assert score == 0.5 and reasons == ['ID matches exactly']  # case-insensitive
    score, reasons = m.score_candidate(F(patientId='MRN-00123'), {**JANE, 'patientId': 'MRN123'})
    assert reasons == ['ID matches when formatting is ignored']
    assert score == 0.4


def test_conflicts_subtract():
    score, reasons = m.score_candidate(F(patientName='DOE^JANE', birthDate='19790101', sex='M'), JANE)
    assert 'birth date differs' in reasons and 'sex differs' in reasons
    assert score == round(0.30 - 0.10 - 0.05, 3)


def test_similar_name_scores_less_than_exact():
    exact, _ = m.score_candidate(F(patientName='DOE^JANE'), JANE)
    typo, reasons = m.score_candidate(F(patientName='DOE^JAINE'), JANE)
    assert typo < exact and 'name is similar' in reasons


def test_rank_top5_drops_zero_and_orders():
    patients = [
        {'patientId': f'P{i}', 'patientName': f'OTHER^PERSON{i}', 'birthDate': '19500101', 'sex': 'M', '_pkey': i}
        for i in range(10)
    ] + [
        {**JANE, '_pkey': 100},
        {'patientId': 'X9', 'patientName': 'DOE^JANE', 'birthDate': '19800101', 'sex': 'F', '_pkey': 101},
    ]
    ranked = m.rank_candidates(F(patientId='MRN123', patientName='DOE^JANE', birthDate='19800101'), patients)
    assert [c['_pkey'] for c in ranked[:2]] == [100, 101]
    assert len(ranked) <= 5
    assert all(c['score'] > 0 for c in ranked)
    assert ranked[0]['reasons'][0] == 'ID matches exactly'


def test_no_fields_no_candidates():
    assert m.rank_candidates({}, [JANE]) == []


def test_search_terms():
    pid, bd, toks = m.search_terms(F(patientId='MRN1', birthDate='19800101', patientName='DOE^JANE^A'))
    assert (pid, bd) == ('MRN1', '19800101')
    assert toks == ['doe', 'jane']  # 1-char tokens dropped
