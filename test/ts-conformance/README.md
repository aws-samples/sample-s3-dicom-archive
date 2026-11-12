# Transfer-syntax conformance (DICOMweb)

Builds one DICOM instance per transfer syntax, uploads them to a storage, and
checks every frame path of the DICOMweb service against an independent decoder.

| Script | What it does |
|---|---|
| `generate.py` | Writes 31 instances (one per transfer syntax) to `$TSC_WORKDIR/tsconf/`, all in one new study "TS conformance" (patient `TSCONF-20261008`), one series per syntax, fresh UIDs. |
| `references.py` | Decodes frame 1 of each instance with imagecodecs (not pydicom's handlers) and records its SHA-256, plus the stored frame-1 bytes for encapsulated syntaxes. |
| `check.py` | For each instance: QIDO, metadata, WADO instance, frame 1 as stored, frame 1 requested as Explicit VR Little Endian, and frame 1 rendered. Writes `results.json`. |

Test tools only (pydicom 2.4.5, imagecodecs, imageio-ffmpeg, python-gdcm). None of
them is installed in a shipped image; imageio-ffmpeg's ffmpeg binary is GPL and
is used here only to make the video test streams.

## Run

```bash
python3.12 -m venv .venv && . .venv/bin/activate
pip install "pydicom==2.4.5" imagecodecs imageio-ffmpeg python-gdcm numpy requests "setuptools<81"
export TSC_WORKDIR=$PWD/tsconf-work
python generate.py && python references.py
aws s3 cp $TSC_WORKDIR/tsconf/ s3://<storage-bucket>/ts-conformance/ --recursive --exclude '*.json' --exclude '*.npy'
# wait about a minute for ingest, then (TSC_TOKEN_FILE holds a Cognito access token):
TSC_BASE=https://<cloudfront>/dicomweb/<datastoreId> TSC_TOKEN_FILE=token.txt python check.py
```

## Expected behaviour per syntax

| Syntax | As stored | Requested as Explicit VR LE | Rendered |
|---|---|---|---|
| Implicit / Explicit LE / Big Endian / Deflated dataset | native frame (deflated: inflated LE bytes) | LE pixels | yes |
| JPEG Lossless `.57` `.70`, JPEG-LS `.80` `.81`, JPEG 2000 lossless `.90` `.92`, HTJ2K lossless `.201` `.202`, RLE `.5`, Deflated Image Frame `.8.1`, Encapsulated Uncompressed `.1.98` | whole frame (all fragments) | decoded, equal to the reference | yes |
| JPEG `.50` `.51`, JPEG 2000 `.91` `.93`, HTJ2K `.203` | whole frame | served as stored (lossy, never re-encoded) | yes |
| JPEG XL `.110` `.112` | whole frame | served as stored (no decoder in the image) | 415 |
| MPEG-2 `.100` `.101`, H.264 `.102`-`.106`, HEVC `.107` `.108` | the whole bitstream | served as stored | 415 |

Not covered: JPIP referenced syntaxes (`.94`, `.95`; no pixel data in the object),
JPEG XL JPEG recompression (`.111`), retired JPEG processes, and SMPTE ST 2110.
The video streams are valid bitstreams but are not checked against each
syntax's profile/level limits.

## Result on a test deployment (2026-10-08)

31 / 31 passed. Before the transfer-syntax fixes, 11 / 31 passed: fragmented frames
were served truncated, deflated and video frames returned 500/502, and every
syntax pydicom 2.4 has no handler for returned a 500 when transcoding was requested.
