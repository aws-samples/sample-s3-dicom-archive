"""
Teach pydicom 3.0.x the transfer syntaxes it does not know yet.

JPEG XL (DICOM 2024c) and Deflated Image Frame Compression (2025b) are standard
transfer syntaxes, but no released pydicom (3.0.2 is the newest) lists them;
only pydicom main (3.1.0.dev) does. Without them pydicom refuses to write a
received dataset ("not a valid transfer syntax"), so the Storage contexts could
not accept them.

All four are Explicit VR Little Endian with encapsulated pixel data. We store
objects as received and never decode pixel data, so pydicom only needs to know
the encoding and that the pixel data is encapsulated (undefined length on
write). pydicom.uid.register_transfer_syntax() cannot do that for these UIDs:
it only works for PRIVATE UIDs (a UID under the 1.2.840.10008 root is treated
as public and looked up in pydicom's UID dictionary, so the registration is
ignored when the file is written). Adding the UID to that dictionary as a
'Transfer Syntax' makes UID.is_transfer_syntax / is_compressed / is_encapsulated
behave exactly as for JPEG 2000. Each UID is also appended to
pydicom.uid.AllTransferSyntaxes, which transfer_syntax_config reads.

pynetdicom 3.0.4 already adds these four to pydicom's UID dictionary when it is
imported (pynetdicom/__init__.py), but not to AllTransferSyntaxes, so in this
service the second step is what matters. The lambdas and dicomweb-s3 do not
import pynetdicom and need both steps (they carry their own copy of this logic).

Guarded: each step is skipped when pydicom (or pynetdicom) already did it, so
this is a no-op once a pydicom release ships them. Safe to call more than once.
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
