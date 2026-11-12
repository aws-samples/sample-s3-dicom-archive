"""
Non-DICOM to DICOM Encapsulation Lambda.
Reads non-DICOM files from S3, encapsulates them as DICOM Part 10, writes back to S3,
then hands off to the existing import-trigger pipeline.
"""
import os
import io
import json
import uuid
import logging
import datetime
import boto3
import pymysql
import pydicom
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.uid import generate_uid, ExplicitVRLittleEndian
from pydicom.encaps import encapsulate
from PIL import Image
import tempfile

# Verify the Aurora/RDS-Proxy server cert against the bundled Amazon RDS CA
# (rds-global-bundle.pem, shipped beside this file) instead of the old
# check_hostname-only config that supplied NO CA and therefore skipped cert
# verification entirely. PyMySQL verifies the chain once 'ca' is set; hostname
# verification is ENFORCED (check_hostname=True, verify-full): the bundle also
# trusts public roots, so skipping it would accept ANY public cert for the DB.
# DB_SSL_CA_PATH overrides the bundle location.
_RDS_CA = os.environ.get(
    "DB_SSL_CA_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "rds-global-bundle.pem"),
)

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3 = boto3.client('s3')
sqs = boto3.client('sqs')
eventbridge = boto3.client('events')

DB_HOST = os.environ['DB_HOST']
DB_SECRET_ARN = os.environ['DB_SECRET_ARN']
DB_NAME = os.environ.get('DB_NAME', 'dicom_archive')
DB_PORT = int(os.environ.get('DB_PORT', '3306'))
IMPORT_TRIGGER_QUEUE_URL = os.environ['IMPORT_TRIGGER_QUEUE_URL']
S3_CLEANUP_QUEUE_URL = os.environ.get('S3_CLEANUP_QUEUE_URL', '')
UPLOAD_BUCKET = os.environ['UPLOAD_BUCKET_NAME']
EVENT_BUS_NAME = os.environ.get('EVENT_BUS_NAME', '')


def send_audit_event(action, detail_type, job_id, job, status, extra=None):
    if not EVENT_BUS_NAME:
        return
    try:
        new_values = {
            'datastoreId': job.get('datastore_id', ''),
            'fileCount': len(json.loads(job['s3_input_keys']) if isinstance(job['s3_input_keys'], str) else job['s3_input_keys']),
            'status': status
        }
        if extra:
            new_values.update(extra)
        eventbridge.put_events(Entries=[{
            # Shared audit-bus event source consumed by the audit stack's rule —
            # a system-wide contract (see audit-stack.ts), not a cloud-imaging dependency.
            'Source': 'dicom.archive',
            'DetailType': detail_type,
            'Detail': json.dumps({
                'action': action,
                'resourceType': 'non_dicom_import',
                'resourceId': job_id,
                'user': job.get('created_by', 'system'),
                'username': job.get('created_by', 'system'),
                'status': 'SUCCESS' if status != 'FAILED' else 'FAILED',
                'newValues': new_values
            }),
            'EventBusName': EVENT_BUS_NAME
        }])
        logger.info(f'Audit event sent: {action} for job {job_id}')
    except Exception as e:
        logger.error(f'Failed to send audit event: {e}')

# SOP Class UIDs
SOP_ENCAPSULATED_PDF = '1.2.840.10008.5.1.4.1.1.104.1'
SOP_SECONDARY_CAPTURE = '1.2.840.10008.5.1.4.1.1.7'
SOP_VIDEO_PHOTOGRAPHIC = '1.2.840.10008.5.1.4.1.1.77.1.4.1'

CONTENT_TYPE_MAP = {
    'application/pdf': (SOP_ENCAPSULATED_PDF, 'DOC'),
    'image/jpeg': (SOP_SECONDARY_CAPTURE, 'SC'),
    'image/png': (SOP_SECONDARY_CAPTURE, 'SC'),
    'video/mp4': (SOP_VIDEO_PHOTOGRAPHIC, 'XC'),
    'video/mpeg': (SOP_VIDEO_PHOTOGRAPHIC, 'XC'),
    'video/quicktime': (SOP_VIDEO_PHOTOGRAPHIC, 'XC'),
}


def probe_video(file_bytes):
    """Extract video metadata. Returns None if probing is unavailable."""
    try:
        import cv2
        tmp_path = None
        with tempfile.NamedTemporaryFile(suffix='.mp4', delete=False) as tmp:
            tmp.write(file_bytes)
            tmp_path = tmp.name
        cap = cv2.VideoCapture(tmp_path)
        if not cap.isOpened():
            os.unlink(tmp_path)
            return None
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        nb_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        cap.release()
        os.unlink(tmp_path)
        return {
            'width': width,
            'height': height,
            'nb_frames': nb_frames,
            'frame_time': round(1000.0 / fps, 2) if fps > 0 else 33.33,
        }
    except ImportError:
        logger.info('opencv not available, skipping video probe')
        return None
    except Exception as e:
        logger.warning(f'video probe failed: {e}')
        return None


def _connect_db():
    """Open a PyMySQL connection to Aurora over the RDS Proxy (mirrors the ingest
    reference cdk-infrastructure/lib/import/lambda/ingest/engine.py).

    PyMySQL uses the text protocol (no server-side prepared statements), so RDS
    Proxy does not pin the backend connection per invocation. SSL is required for
    the Aurora MySQL 8 auth handshake through the proxy. autocommit=True: this
    lambda's writes are independent single statements (job-status updates,
    per-job inserts), so per-statement commit matches the prior Data-API
    (each execute_statement auto-committed) behaviour.
    """
    sm = boto3.client('secretsmanager')
    sec = json.loads(sm.get_secret_value(SecretId=DB_SECRET_ARN)['SecretString'])
    return pymysql.connect(
        host=DB_HOST or sec['host'],
        user=sec['username'], password=sec['password'],
        database=DB_NAME or sec.get('dbname'),
        port=DB_PORT,
        charset='utf8mb4',
        autocommit=True,
        cursorclass=pymysql.cursors.DictCursor,
        ssl={"ca": _RDS_CA, "check_hostname": True},
    )


# Warm-container connection reuse: ping-and-reconnect, else fresh connect.
_conn = None


def _get_db_conn():
    global _conn
    if _conn is not None:
        try:
            _conn.ping(reconnect=True)
            return _conn
        except Exception:
            try:
                _conn.close()
            except Exception:
                pass
            _conn = None
    _conn = _connect_db()
    return _conn


def db_execute(sql, params=None):
    """Execute a statement via PyMySQL. params is a tuple/list for %s placeholders."""
    conn = _get_db_conn()
    with conn.cursor() as cur:
        cur.execute(sql, params or ())
    return None


def db_query(sql, params=None):
    """Execute a query and return a list of dicts (DictCursor)."""
    conn = _get_db_conn()
    with conn.cursor() as cur:
        cur.execute(sql, params or ())
        return cur.fetchall()


def update_job_status(job_id, status, description=None):
    if description:
        db_execute(
            'UPDATE non_dicom_imports SET status = %s, status_description = %s, updated_at = NOW() WHERE id = %s',
            (status, description, job_id)
        )
    else:
        db_execute(
            'UPDATE non_dicom_imports SET status = %s, updated_at = NOW() WHERE id = %s',
            (status, job_id)
        )


def build_base_dataset(patient_attrs, study_attrs, series_uid, series_desc, modality, sop_class_uid, sop_instance_uid):
    """Build a DICOM dataset with patient/study/series/instance level attributes."""
    file_meta = FileMetaDataset()
    file_meta.MediaStorageSOPClassUID = sop_class_uid
    file_meta.MediaStorageSOPInstanceUID = sop_instance_uid
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian

    ds = FileDataset('', {}, file_meta=file_meta, preamble=b'\x00' * 128)

    # Patient level
    ds.PatientID = patient_attrs.get('PatientID', '')
    ds.PatientName = patient_attrs.get('PatientName', '')
    ds.PatientBirthDate = patient_attrs.get('PatientBirthDate', '')
    ds.PatientSex = patient_attrs.get('PatientSex', '')

    # Study level
    ds.StudyInstanceUID = study_attrs.get('StudyInstanceUID', generate_uid())
    ds.StudyDate = study_attrs.get('StudyDate', datetime.date.today().strftime('%Y%m%d'))
    ds.StudyTime = study_attrs.get('StudyTime', datetime.datetime.now().strftime('%H%M%S'))
    ds.StudyDescription = study_attrs.get('StudyDescription', '')
    ds.AccessionNumber = study_attrs.get('AccessionNumber', '')
    ds.StudyID = study_attrs.get('StudyID', '')
    ds.ReferringPhysicianName = study_attrs.get('ReferringPhysicianName', '')

    # Series level
    ds.SeriesInstanceUID = series_uid
    ds.SeriesDescription = series_desc
    ds.Modality = modality
    ds.SeriesNumber = 1

    # Instance level
    ds.SOPClassUID = sop_class_uid
    ds.SOPInstanceUID = sop_instance_uid
    ds.InstanceNumber = 1

    # General
    now = datetime.datetime.now()
    ds.ContentDate = now.strftime('%Y%m%d')
    ds.ContentTime = now.strftime('%H%M%S')
    ds.InstanceCreationDate = now.strftime('%Y%m%d')
    ds.InstanceCreationTime = now.strftime('%H%M%S')
    ds.SpecificCharacterSet = 'ISO_IR 100'

    return ds


def encapsulate_pdf(file_bytes, patient_attrs, study_attrs, series_uid, series_desc, instance_number):
    sop_uid = generate_uid()
    ds = build_base_dataset(patient_attrs, study_attrs, series_uid, series_desc, 'DOC',
                            SOP_ENCAPSULATED_PDF, sop_uid)
    ds.InstanceNumber = instance_number
    ds.MIMETypeOfEncapsulatedDocument = 'application/pdf'
    ds.EncapsulatedDocument = file_bytes
    ds.BurnedInAnnotation = 'NO'
    ds.ConceptNameCodeSequence = [Dataset()]
    ds.ConceptNameCodeSequence[0].CodeValue = '11528-7'
    ds.ConceptNameCodeSequence[0].CodingSchemeDesignator = 'LN'
    ds.ConceptNameCodeSequence[0].CodeMeaning = 'Radiology Report'
    return ds


def encapsulate_image(file_bytes, content_type, patient_attrs, study_attrs, series_uid, series_desc, instance_number):
    sop_uid = generate_uid()
    ds = build_base_dataset(patient_attrs, study_attrs, series_uid, series_desc, 'SC',
                            SOP_SECONDARY_CAPTURE, sop_uid)
    ds.InstanceNumber = instance_number
    ds.ConversionType = 'WSD'

    img = Image.open(io.BytesIO(file_bytes))
    if img.mode == 'RGBA':
        img = img.convert('RGB')

    ds.Rows = img.height
    ds.Columns = img.width

    if img.mode == 'L':
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = 'MONOCHROME2'
        ds.BitsAllocated = 8
        ds.BitsStored = 8
        ds.HighBit = 7
        ds.PixelRepresentation = 0
        ds.PixelData = img.tobytes()
    else:
        ds.SamplesPerPixel = 3
        ds.PhotometricInterpretation = 'RGB'
        ds.PlanarConfiguration = 0
        ds.BitsAllocated = 8
        ds.BitsStored = 8
        ds.HighBit = 7
        ds.PixelRepresentation = 0
        ds.PixelData = img.tobytes()

    return ds


def encapsulate_video(file_bytes, content_type, patient_attrs, study_attrs, series_uid, series_desc, instance_number, video_width=0, video_height=0):
    sop_uid = generate_uid()
    ds = build_base_dataset(patient_attrs, study_attrs, series_uid, series_desc, 'XC',
                            SOP_VIDEO_PHOTOGRAPHIC, sop_uid)
    ds.InstanceNumber = instance_number

    # MPEG-4 transfer syntax
    ds.file_meta.TransferSyntaxUID = '1.2.840.10008.1.2.4.102'
    ds.BitsAllocated = 8
    ds.BitsStored = 8
    ds.HighBit = 7
    ds.SamplesPerPixel = 3
    ds.PhotometricInterpretation = 'YBR_PARTIAL_420'
    ds.PlanarConfiguration = 0
    ds.PixelRepresentation = 0

    rows, cols, num_frames, frame_time = video_height, video_width, 1, '33.33'
    probe = probe_video(file_bytes)
    if probe:
        rows = probe['height'] or rows
        cols = probe['width'] or cols
        num_frames = probe['nb_frames'] or 1
        frame_time = str(probe['frame_time'])
        logger.info(f'ffprobe: {cols}x{rows}, {num_frames} frames, FrameTime={frame_time}ms')

    ds.Rows = rows
    ds.Columns = cols
    ds.NumberOfFrames = num_frames
    ds.FrameIncrementPointer = pydicom.tag.Tag(0x0018, 0x1063)
    ds.FrameTime = frame_time
    ds.PixelData = encapsulate([file_bytes])

    return ds


def handler(event, context):
    for record in event['Records']:
        message = json.loads(record['body'])
        job_id = message['jobId']

        try:
            # Fetch job from DB
            rows = db_query(
                'SELECT * FROM non_dicom_imports WHERE id = %s',
                (job_id,)
            )
            if not rows:
                logger.error(f'Job {job_id} not found')
                continue

            job = rows[0]
            if job['status'] != 'SUBMITTED':
                logger.info(f'Job {job_id} not SUBMITTED (status={job["status"]}), skipping')
                continue

            update_job_status(job_id, 'PROCESSING')
            send_audit_event('PROCESS_NON_DICOM_IMPORT', 'NonDicomImportProcessing', job_id, job, 'PROCESSING')

            s3_input_keys = json.loads(job['s3_input_keys']) if isinstance(job['s3_input_keys'], str) else job['s3_input_keys']
            patient_attrs = json.loads(job['patient_attrs']) if isinstance(job['patient_attrs'], str) else job['patient_attrs']
            study_attrs = json.loads(job['study_attrs']) if isinstance(job['study_attrs'], str) else job['study_attrs']
            series_assignments = json.loads(job['series_assignments']) if isinstance(job['series_assignments'], str) else job['series_assignments']

            # Ensure StudyInstanceUID exists
            if not study_attrs.get('StudyInstanceUID'):
                study_attrs['StudyInstanceUID'] = generate_uid()

            encapsulated_prefix = f'encapsulated/{job_id}/'
            instance_counter = {}  # per series instance numbering

            # F17: the staged objects a job may read are ONLY those under its
            # creator's own prefix ({created_by}/...). The create API enforces
            # this, but the worker re-validates so a tampered series_assignments
            # row can never make this privileged worker read another user's
            # staged object. A key outside the prefix (or traversing) is refused.
            creator = job.get('created_by') or ''
            allowed_prefix = f'{creator}/'

            def _key_is_owned(k):
                s = str(k if k is not None else '')
                return bool(creator) and s.startswith(allowed_prefix) and '..' not in s and not s.startswith('/')

            # Process each file
            for file_entry in series_assignments:
                s3_key = file_entry['s3Key']
                if not _key_is_owned(s3_key):
                    raise ValueError(f'Refusing staged object outside job owner prefix: job {job_id}')
                content_type = file_entry['contentType']
                series_uid = file_entry.get('seriesInstanceUID') or generate_uid()
                series_desc = file_entry.get('seriesDescription', '')

                if series_uid not in instance_counter:
                    instance_counter[series_uid] = 0
                instance_counter[series_uid] += 1
                instance_number = instance_counter[series_uid]

                sop_class, modality = CONTENT_TYPE_MAP.get(content_type, (None, None))
                if not sop_class:
                    logger.warning(f'Unsupported content type: {content_type}, skipping {s3_key}')
                    continue

                # Read source file from S3
                obj = s3.get_object(Bucket=UPLOAD_BUCKET, Key=s3_key)
                file_bytes = obj['Body'].read()

                # Encapsulate
                if content_type == 'application/pdf':
                    ds = encapsulate_pdf(file_bytes, patient_attrs, study_attrs, series_uid, series_desc, instance_number)
                elif content_type.startswith('image/'):
                    ds = encapsulate_image(file_bytes, content_type, patient_attrs, study_attrs, series_uid, series_desc, instance_number)
                elif content_type.startswith('video/'):
                    ds = encapsulate_video(file_bytes, content_type, patient_attrs, study_attrs, series_uid, series_desc, instance_number,
                                           video_width=int(file_entry.get('videoWidth', 0)), video_height=int(file_entry.get('videoHeight', 0)))
                else:
                    continue

                # Write DICOM Part 10 to S3
                buf = io.BytesIO()
                ds.save_as(buf, write_like_original=False)
                buf.seek(0)
                output_key = f'{encapsulated_prefix}{ds.SOPInstanceUID}.dcm'
                s3.put_object(Bucket=UPLOAD_BUCKET, Key=output_key, Body=buf.getvalue())
                logger.info(f'Wrote {output_key}')

            # Update encapsulated URI
            s3_encapsulated_uri = f's3://{UPLOAD_BUCKET}/{encapsulated_prefix}'
            db_execute(
                'UPDATE non_dicom_imports SET s3_encapsulated_uri = %s, updated_at = NOW() WHERE id = %s',
                (s3_encapsulated_uri, job_id)
            )

            # Create import_jobs record for the import-trigger pipeline
            import_job_id = str(uuid.uuid4())
            s3_input_uri = s3_encapsulated_uri
            s3_output_uri = f's3://{UPLOAD_BUCKET}/output/{job_id}/'
            job_name = f'NonDICOM-{job_id[:8]}'

            db_execute(
                """INSERT INTO import_jobs
                   (id, datastore_id, s3_input_uri, s3_output_uri,
                    source_type, source_location, job_name, status, created_by)
                   VALUES (%s, %s, %s, %s, 'S3', %s, %s, 'PENDING', %s)""",
                (
                    import_job_id,
                    job['datastore_id'],
                    s3_input_uri,
                    s3_output_uri,
                    s3_input_uri,
                    job_name,
                    job.get('created_by', 'system'),
                )
            )

            # Link the created import job to the non-DICOM import, so the ingest
            # path can cascade COMPLETED/FAILED to it (import_jobs.py).
            update_job_status(job_id, 'IMPORTING')
            db_execute(
                'UPDATE non_dicom_imports SET import_job_id = %s, updated_at = NOW() WHERE id = %s',
                (import_job_id, job_id)
            )

            # Send to import-trigger queue
            sqs.send_message(
                QueueUrl=IMPORT_TRIGGER_QUEUE_URL,
                MessageBody=json.dumps({'importJobId': import_job_id})
            )

            # Send source files to s3-cleanup queue
            if S3_CLEANUP_QUEUE_URL:
                # Build prefix from first input key's directory
                first_key = s3_input_keys[0] if s3_input_keys else ''
                source_prefix = '/'.join(first_key.split('/')[:-1]) + '/' if '/' in first_key else first_key
                sqs.send_message(
                    QueueUrl=S3_CLEANUP_QUEUE_URL,
                    MessageBody=json.dumps({
                        'inputS3Uri': f's3://{UPLOAD_BUCKET}/{source_prefix}',
                        'jobId': job_id,
                        'jobType': 'non_dicom_import'
                    })
                )

            logger.info(f'Job {job_id} encapsulated and handed off to import-trigger')
            send_audit_event('COMPLETE_NON_DICOM_IMPORT', 'NonDicomImportCompleted', job_id, job, 'IMPORTING', {
                's3EncapsulatedUri': s3_encapsulated_uri, 'importJobId': import_job_id
            })

        except Exception as e:
            logger.error(f'Job {job_id} failed: {type(e).__name__}')
            update_job_status(job_id, 'FAILED', type(e).__name__)
            send_audit_event('FAIL_NON_DICOM_IMPORT', 'NonDicomImportFailed', job_id, job, 'FAILED', {
                'errorMessage': str(e)
            })
