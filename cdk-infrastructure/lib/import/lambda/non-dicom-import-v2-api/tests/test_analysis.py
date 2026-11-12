import io
import json

import pytest
from PIL import Image
from pypdf import PdfReader, PdfWriter

import analysis
from analysis import Budget, NotAnalysable


def make_pdf(pages, encrypt=None):
    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(width=612, height=792)
    if encrypt is not None:
        w.encrypt(user_password=encrypt, owner_password='owner', algorithm='RC4-128')
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def make_image(w, h, fmt='PNG', mode='RGB'):
    buf = io.BytesIO()
    Image.new(mode, (w, h), (200, 10, 10) if mode == 'RGB' else 0).save(buf, format=fmt)
    return buf.getvalue()


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


# --- PDF reduction ----------------------------------------------------------

def test_small_pdf_is_sent_unchanged():
    data = make_pdf(3)
    out, pages = analysis.reduce_pdf(data)
    assert out == data and pages == 3


def test_long_pdf_keeps_first_10_pages():
    out, pages = analysis.reduce_pdf(make_pdf(25))
    assert pages == 10
    assert len(PdfReader(io.BytesIO(out)).pages) == 10


def test_pdf_reduced_until_it_fits():
    data = make_pdf(10)
    one_page = len(analysis.reduce_pdf(make_pdf(1))[0])
    limit = one_page * 3
    out, pages = analysis.reduce_pdf(data, max_bytes=limit)
    assert len(out) <= limit and 1 <= pages < 10


def test_pdf_too_large_even_at_one_page():
    with pytest.raises(NotAnalysable, match='too large'):
        analysis.reduce_pdf(make_pdf(2), max_bytes=50)


def test_encrypted_pdf_with_user_password_is_refused():
    with pytest.raises(NotAnalysable, match='PDF is encrypted'):
        analysis.reduce_pdf(make_pdf(1, encrypt='secret'))


def test_invalid_pdf():
    with pytest.raises(NotAnalysable, match='not a valid PDF'):
        analysis.reduce_pdf(b'%PDF-1.4 garbage that is not a pdf')


# --- image downscale ----------------------------------------------------------

def test_image_downscaled_to_jpeg():
    out = analysis.downscale_image(make_image(4000, 3000))
    img = Image.open(io.BytesIO(out))
    assert img.format == 'JPEG' and max(img.size) <= analysis.IMAGE_MAX_EDGE
    assert len(out) <= analysis.IMAGE_MAX_BYTES


def test_png_with_alpha_flattened():
    out = analysis.downscale_image(make_image(100, 50, mode='RGBA'))
    assert Image.open(io.BytesIO(out)).mode == 'RGB'


def test_image_byte_cap_forces_smaller_output():
    noisy = Image.effect_noise((1500, 1500), 100).convert('RGB')
    buf = io.BytesIO()
    noisy.save(buf, format='PNG')
    out = analysis.downscale_image(buf.getvalue(), max_bytes=60_000)
    assert len(out) <= 60_000


def test_invalid_image():
    with pytest.raises(NotAnalysable, match='not a valid image'):
        analysis.downscale_image(b'\x89PNG\r\n\x1a\nbroken')


def test_build_content_blocks():
    pdf_blocks = analysis.build_content('application/pdf', make_pdf(1))
    doc = pdf_blocks[0]['document']
    assert doc['format'] == 'pdf' and doc['citations'] == {'enabled': True} and 'text' in pdf_blocks[1]
    img_blocks = analysis.build_content('image/png', make_image(10, 10))
    assert img_blocks[0]['image']['format'] == 'jpeg'
    with pytest.raises(NotAnalysable):
        analysis.build_content('video/mp4', b'')


def test_response_text_joins_citations():
    resp = {'output': {'message': {'content': [
        {'text': '{"fields": {"patientName": '},
        {'citationsContent': {'content': [{'text': '{"value": "DOE^JANE", "confidence": 0.9}'}],
                              'citations': [{'title': 'document'}]}},
        {'text': '}}'},
    ]}}}
    assert json.loads(analysis.response_text(resp))['fields']['patientName']['value'] == 'DOE^JANE'


# --- analyse(): Haiku, escalation, budget ------------------------------------

def reply(fields):
    return {'output': {'message': {'content': [{'text': json.dumps({'fields': fields})}]}}}


GOOD = {'patientName': {'value': 'Jane Doe', 'confidence': 0.95, 'evidence': 'Patient: Jane Doe'},
        'patientId': {'value': 'MRN1', 'confidence': 0.9, 'evidence': 'MRN1'}}
WEAK = {'patientName': {'value': 'Jane Doe', 'confidence': 0.2, 'evidence': 'J. Doe?'}}


class FakeBedrock:
    def __init__(self, script, clock=None, cost=0.0):
        self.script = list(script)
        self.calls = []
        self.clock = clock
        self.cost = cost

    def factory(self, timeout_s):
        self.calls.append({'timeout': timeout_s})
        return self

    def converse(self, **kw):
        self.calls[-1]['modelId'] = kw['modelId']
        self.calls[-1]['citations'] = 'citations' in (kw['messages'][0]['content'][0].get('document') or {})
        assert 'toolConfig' not in kw  # no tools, ever
        assert len(kw['messages']) == 1  # no conversation history
        if self.clock:
            self.clock.t += self.cost
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def client_error(code):
    from botocore.exceptions import ClientError
    return ClientError({'Error': {'Code': code, 'Message': 'x'}}, 'Converse')


def run(script, budget_s=60, ctype='application/pdf', data=None, clock=None, cost=0.0):
    fake = FakeBedrock(script, clock=clock, cost=cost)
    budget = Budget(budget_s, now=clock or Clock())
    res = analysis.analyse(ctype, data or make_pdf(1), budget, client_factory=fake.factory,
                           first_model='haiku', second_model='sonnet')
    return res, fake


def test_haiku_confident_no_escalation():
    res, fake = run([reply(GOOD)])
    assert res['status'] == 'ANALYSED' and res['escalated'] is False
    assert [c['modelId'] for c in fake.calls] == ['haiku']
    assert res['fields']['patientName']['value'] == 'DOE^JANE'


def test_low_confidence_escalates_and_keeps_better():
    res, fake = run([reply(WEAK), reply(GOOD)])
    assert [c['modelId'] for c in fake.calls] == ['haiku', 'sonnet']
    assert res['escalated'] is True and res['modelId'] == 'sonnet'


def test_escalation_keeps_haiku_when_sonnet_is_worse():
    res, _ = run([reply(WEAK), reply({})])
    assert res['modelId'] == 'haiku' and res['escalated'] is True


def test_schema_failure_escalates():
    bad = {'output': {'message': {'content': [{'text': 'I cannot help with that.'}]}}}
    res, fake = run([bad, reply(GOOD)])
    assert len(fake.calls) == 2 and res['status'] == 'ANALYSED'


def test_both_fail_is_not_analysed():
    from botocore.exceptions import ReadTimeoutError
    res, _ = run([ReadTimeoutError(endpoint_url='x'), client_error('ThrottlingException')])
    assert res['status'] == 'NOT_ANALYSED' and res['reason'] == 'timeout'
    assert res['fields']['patientName'] is None and res['escalated'] is True


def test_no_escalation_when_budget_is_short():
    clock = Clock()
    res, fake = run([reply(WEAK), reply(GOOD)], budget_s=10, clock=clock, cost=5.0)
    # 5 s left < ESCALATE_MIN_SECONDS (8): Sonnet is not called
    assert [c['modelId'] for c in fake.calls] == ['haiku'] and res['escalated'] is False


def test_read_timeout_is_the_time_left():
    clock = Clock()
    clock.t = 0
    _, fake = run([reply(WEAK), reply(GOOD)], budget_s=60, clock=clock, cost=20.0)
    assert fake.calls[0]['timeout'] == pytest.approx(59.5)
    assert fake.calls[1]['timeout'] == pytest.approx(39.5)


def test_citations_validation_error_retries_without_citations():
    res, fake = run([client_error('ValidationException'), reply(GOOD)])
    assert [c['citations'] for c in fake.calls] == [True, False]
    assert [c['modelId'] for c in fake.calls] == ['haiku', 'haiku']
    assert res['status'] == 'ANALYSED' and res['escalated'] is False


def test_not_analysable_file_skips_model():
    res, fake = run([], data=b'%PDF-1.4 nonsense')
    assert res['status'] == 'NOT_ANALYSED' and res['reason'] == 'file is not a valid PDF'
    assert fake.calls == []


def test_image_analysis():
    res, fake = run([reply(GOOD)], ctype='image/png', data=make_image(3000, 2000))
    assert res['status'] == 'ANALYSED' and fake.calls[0]['citations'] is False


# --- file preparation is held to the budget ----------------------------------

def test_slow_preparation_is_not_analysed_timeout(monkeypatch):
    import threading
    release = threading.Event()

    def slow_build(ct, data):
        release.wait(5)
        return [{'text': 'x'}]
    monkeypatch.setattr(analysis, 'build_content', slow_build)
    try:
        res, fake = run([reply(GOOD)], budget_s=0.2, clock=None)
    finally:
        release.set()
    assert res['status'] == 'NOT_ANALYSED' and res['reason'] == 'timeout'
    assert fake.calls == []


def test_unexpected_parser_error_is_not_analysed(monkeypatch):
    def broken(ct, data):
        raise RecursionError('deep')
    monkeypatch.setattr(analysis, 'build_content', broken)
    res, fake = run([reply(GOOD)])
    assert res['status'] == 'NOT_ANALYSED' and res['reason'] == 'the file could not be read for analysis'
    assert fake.calls == []
