"""
Teach pydicom the transfer syntaxes it does not know yet.

JPEG XL (DICOM 2024c) and Deflated Image Frame Compression (2025b) are standard
transfer syntaxes the DIMSE service now accepts on C-STORE, but pydicom 2.4
(pinned here, see requirements.txt) and every released 3.x do not list them.
pydicom READS such a file (an unknown syntax is parsed as Explicit VR LE), but
refuses to WRITE one ("UID is not a transfer syntax"), which broke the folder
(virtual-folder de-identification) retrieve: _encode_part10 re-encodes the
header. pixel_codecs already handles the frames (Deflated Image Frame is
decoded with zlib, JPEG XL is served as stored).

All four are Explicit VR Little Endian with encapsulated pixel data. Adding the
UID to pydicom's UID dictionary as a 'Transfer Syntax' makes
UID.is_transfer_syntax / is_compressed / is_implicit_VR behave exactly as for
JPEG 2000 (pydicom 2.4 has no register_transfer_syntax, and 3.x's only covers
private UIDs). Each UID is also appended to pydicom.uid.AllTransferSyntaxes.

Same logic as interface-container/DICOM/DIMSEtoS3/extra_transfer_syntaxes.py.
Guarded: each step is skipped when pydicom already knows the syntax, so this is
a no-op once a pydicom release ships them. Safe to call more than once.
"""

# (UID, name, keyword) - names/keywords as in DICOM PS3.6 and pydicom main.
EXTRA_TRANSFER_SYNTAXES = [
    ('1.2.840.10008.1.2.4.110', 'JPEG XL Lossless', 'JPEGXLLossless'),
    ('1.2.840.10008.1.2.4.111', 'JPEG XL JPEG Recompression', 'JPEGXLJPEGRecompression'),
    ('1.2.840.10008.1.2.4.112', 'JPEG XL', 'JPEGXL'),
    ('1.2.840.10008.1.2.8.1', 'Deflated Image Frame Compression', 'DeflatedImageFrameCompression'),
]


def register_extra_transfer_syntaxes():
    """Register the syntaxes above with pydicom. Returns the UIDs changed."""
    import pydicom.uid as pydicom_uid
    from pydicom._uid_dict import UID_dictionary

    changed = []
    for uid, name, keyword in EXTRA_TRANSFER_SYNTAXES:
        touched = False
        if not pydicom_uid.UID(uid).is_transfer_syntax:
            UID_dictionary[uid] = (name, 'Transfer Syntax', '', '', keyword)
            touched = True
        ts = pydicom_uid.UID(uid)
        if ts not in pydicom_uid.AllTransferSyntaxes:
            pydicom_uid.AllTransferSyntaxes.append(ts)
            touched = True
        if not hasattr(pydicom_uid, keyword):
            setattr(pydicom_uid, keyword, ts)
        if touched:
            changed.append(uid)
    return changed


register_extra_transfer_syntaxes()
