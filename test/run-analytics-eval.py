"""Text-to-SQL evaluation: natural-language questions scored against reference SQL.

Each case is a question plus a hand-written reference query. The suite runs the
reference through POST /query (type=sql) and the question through POST /query
(type=natural), both against the same storage, and compares the RESULTS, not
the SQL text. The reference is computed live, so the cases hold on any stack
seeded with the test data, and as that data changes.

Matching (column-agnostic, like the "execution accuracy" metric used by text-to-SQL
benchmarks): the generated result must have the same number of rows as the
reference, and every reference row must match a distinct generated row whose
values include all of the reference row's values. Extra columns are allowed,
column names and order are ignored, and so is datastore_id. Values are compared
after normalising: numbers to 2 decimals, dates to YYYY-MM-DD, text trimmed and
lower-cased. Rows are compared in order when the case says `ordered`.

A `number` case has a one-value reference. It passes if the model answered in
chat with that number in the text, or returned rows containing it.

A `paging` case checks the server pages generated SQL: page 2 of a long list
must be a full page that does not repeat page 1.

Env: AE_API, AE_DS (storage id), AE_TOKEN_FILE (admin access token).
Optional: AE_ONLY (comma-separated case ids), AE_MIN_SCORE (0-1, default 0:
report only), AE_RESULTS (JSON path). Prints [PASS]/[FAIL] per case.
"""
import datetime as dt
import decimal
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

API = os.environ['AE_API'].rstrip('/')
DS = os.environ['AE_DS']
TOK = open(os.environ['AE_TOKEN_FILE']).read().strip()
ONLY = set(filter(None, os.environ.get('AE_ONLY', '').split(',')))
MIN_SCORE = float(os.environ.get('AE_MIN_SCORE', '0'))
OUT = os.environ.get('AE_RESULTS', 'analytics-eval-results.json')

# Every reference reads only live rows (deleted_at IS NULL) and, inside
# aggregates, uses CASE WHEN (the guard cannot parse SUM(a = 'x')).
L = 'deleted_at IS NULL'
CASES = [
    # ---- counts -------------------------------------------------------------
    ('count-patients', 'How many patients are there?', 'number',
     f"SELECT p.datastore_id, COUNT(*) n FROM patient p WHERE p.{L} GROUP BY p.datastore_id"),
    ('count-studies', 'How many studies are there?', 'number',
     f"SELECT s.datastore_id, COUNT(*) n FROM study s WHERE s.{L} GROUP BY s.datastore_id"),
    ('count-series', 'How many series are there?', 'number',
     f"SELECT se.datastore_id, COUNT(*) n FROM series se WHERE se.{L} GROUP BY se.datastore_id"),
    ('count-instances', 'How many instances are there?', 'number',
     f"SELECT i.datastore_id, COUNT(*) n FROM instance i WHERE i.{L} GROUP BY i.datastore_id"),
    ('count-ct-series', 'How many CT series are there?', 'number',
     f"SELECT se.datastore_id, COUNT(*) n FROM series se WHERE se.{L} AND se.modality = 'CT' GROUP BY se.datastore_id"),
    ('count-female', 'How many female patients are there?', 'number',
     f"SELECT p.datastore_id, COUNT(*) n FROM patient p WHERE p.{L} AND p.patientsex = 'F' GROUP BY p.datastore_id"),
    ('count-wsi-studies', 'How many studies contain a whole-slide microscopy series?', 'number',
     f"SELECT se.datastore_id, COUNT(DISTINCT se.study_pkey) n FROM series se WHERE se.{L} AND se.modality = 'SM' GROUP BY se.datastore_id"),
    ('count-multiframe', 'How many instances have more than one frame?', 'number',
     f"SELECT i.datastore_id, COUNT(*) n FROM instance i WHERE i.{L} AND i.numberofframes > 1 GROUP BY i.datastore_id"),
    ('count-large-matrix', 'How many instances are larger than 512 by 512 pixels (more than 512 rows and more than 512 columns)?', 'number',
     f"SELECT i.datastore_id, COUNT(*) n FROM instance i WHERE i.{L} AND i.rows > 512 AND i.columns > 512 GROUP BY i.datastore_id"),
    ('count-jpeg-baseline', 'How many instances are stored as JPEG Baseline (transfer syntax 1.2.840.10008.1.2.4.50)?', 'number',
     f"SELECT i.datastore_id, COUNT(*) n FROM instance i WHERE i.{L} AND i.transfersyntaxuid = '1.2.840.10008.1.2.4.50' GROUP BY i.datastore_id"),
    ('count-distinct-ts', 'How many different transfer syntaxes are used by the instances?', 'number',
     f"SELECT i.datastore_id, COUNT(DISTINCT i.transfersyntaxuid) n FROM instance i WHERE i.{L} GROUP BY i.datastore_id"),
    ('count-no-bodypart', 'How many series have no body part examined?', 'number',
     f"SELECT se.datastore_id, COUNT(*) n FROM series se WHERE se.{L} AND (se.bodypartexamined IS NULL OR se.bodypartexamined = '') GROUP BY se.datastore_id"),
    ('count-no-study-desc', 'How many studies have no study description?', 'number',
     f"SELECT s.datastore_id, COUNT(*) n FROM study s WHERE s.{L} AND (s.studydescription IS NULL OR s.studydescription = '') GROUP BY s.datastore_id"),
    ('count-studies-2004', 'How many studies were performed in 2004?', 'number',
     f"SELECT s.datastore_id, COUNT(*) n FROM study s WHERE s.{L} AND YEAR(s.studydate) = 2004 GROUP BY s.datastore_id"),
    ('count-t1-series', "How many series have a description containing T1 (case-insensitive)?", 'number',
     f"SELECT se.datastore_id, COUNT(*) n FROM series se WHERE se.{L} AND LOWER(se.seriesdescription) LIKE '%t1%' GROUP BY se.datastore_id"),
    ('count-patients-ct-mr', 'How many patients have both a CT series and an MR series?', 'number',
     f"SELECT x.datastore_id, COUNT(*) n FROM (SELECT p.datastore_id, p.patient_pkey FROM patient p "
     f"JOIN study s ON s.patient_pkey = p.patient_pkey JOIN series se ON se.study_pkey = s.study_pkey "
     f"WHERE p.{L} AND s.{L} AND se.{L} GROUP BY p.datastore_id, p.patient_pkey "
     f"HAVING SUM(CASE WHEN se.modality = 'CT' THEN 1 ELSE 0 END) > 0 AND SUM(CASE WHEN se.modality = 'MR' THEN 1 ELSE 0 END) > 0) x "
     f"GROUP BY x.datastore_id"),
    # ---- the user's words differ from the stored value (CHEST is stored as "PORT CHEST")
    ('count-chest-series', 'How many chest series are there?', 'number',
     f"SELECT se.datastore_id, COUNT(*) n FROM series se WHERE se.{L} AND se.bodypartexamined LIKE '%CHEST%' GROUP BY se.datastore_id"),
    ('count-wholebody-series', 'How many whole-body series are there?', 'number',
     f"SELECT se.datastore_id, COUNT(*) n FROM series se WHERE se.{L} AND se.bodypartexamined = 'WHOLE BODY' GROUP BY se.datastore_id"),
    ('gamma-knife-studies', 'List the study instance UIDs of the gamma knife studies.', 'rows',
     f"SELECT s.datastore_id, s.studyinstanceuid FROM study s WHERE s.{L} AND LOWER(s.studydescription) LIKE '%gamma knife%'"),
    # ---- everyday words that map to a SOP class or transfer syntax (dicom-glossary.txt).
    # The PDF/SR/KO cases need the "Analytics glossary documents" study (glossary-demo/ in
    # the storage bucket); without it their reference is 0 and they still score correctly.
    ('glossary-count-pdf', 'How many PDF documents are there?', 'number',
     f"SELECT i.datastore_id, COUNT(*) n FROM instance i WHERE i.{L} AND i.sopclassuid = '1.2.840.10008.5.1.4.1.1.104.1' GROUP BY i.datastore_id"),
    ('glossary-list-pdf', 'Show me the PDF documents.', 'rows',
     f"SELECT i.datastore_id, i.sopinstanceuid FROM instance i WHERE i.{L} AND i.sopclassuid = '1.2.840.10008.5.1.4.1.1.104.1'"),
    ('glossary-count-sr', 'How many structured reports are there?', 'number',
     f"SELECT i.datastore_id, COUNT(*) n FROM instance i WHERE i.{L} AND i.sopclassuid IN ('1.2.840.10008.5.1.4.1.1.88.11', "
     f"'1.2.840.10008.5.1.4.1.1.88.22', '1.2.840.10008.5.1.4.1.1.88.33', '1.2.840.10008.5.1.4.1.1.88.34', '1.2.840.10008.5.1.4.1.1.88.35') GROUP BY i.datastore_id"),
    ('glossary-count-key-images', 'How many key image notes are there?', 'number',
     f"SELECT i.datastore_id, COUNT(*) n FROM instance i WHERE i.{L} AND i.sopclassuid = '1.2.840.10008.5.1.4.1.1.88.59' GROUP BY i.datastore_id"),
    ('glossary-count-sc', 'How many secondary capture images are there?', 'number',
     f"SELECT i.datastore_id, COUNT(*) n FROM instance i WHERE i.{L} AND i.sopclassuid IN ('1.2.840.10008.5.1.4.1.1.7', "
     f"'1.2.840.10008.5.1.4.1.1.7.1', '1.2.840.10008.5.1.4.1.1.7.2', '1.2.840.10008.5.1.4.1.1.7.3', '1.2.840.10008.5.1.4.1.1.7.4') GROUP BY i.datastore_id"),
    ('glossary-count-video', 'How many videos are there?', 'number',
     f"SELECT i.datastore_id, COUNT(*) n FROM instance i WHERE i.{L} AND (i.sopclassuid IN ('1.2.840.10008.5.1.4.1.1.77.1.1.1', "
     f"'1.2.840.10008.5.1.4.1.1.77.1.2.1', '1.2.840.10008.5.1.4.1.1.77.1.4.1') OR i.transfersyntaxuid IN ('1.2.840.10008.1.2.4.100', "
     f"'1.2.840.10008.1.2.4.100.1', '1.2.840.10008.1.2.4.101', '1.2.840.10008.1.2.4.101.1', '1.2.840.10008.1.2.4.102', '1.2.840.10008.1.2.4.102.1', "
     f"'1.2.840.10008.1.2.4.103', '1.2.840.10008.1.2.4.103.1', '1.2.840.10008.1.2.4.104', '1.2.840.10008.1.2.4.104.1', '1.2.840.10008.1.2.4.105', "
     f"'1.2.840.10008.1.2.4.105.1', '1.2.840.10008.1.2.4.106', '1.2.840.10008.1.2.4.106.1', '1.2.840.10008.1.2.4.107', '1.2.840.10008.1.2.4.108')) GROUP BY i.datastore_id"),
    ('glossary-count-jpeg2000', 'How many instances are compressed with JPEG 2000?', 'number',
     f"SELECT i.datastore_id, COUNT(*) n FROM instance i WHERE i.{L} AND i.transfersyntaxuid IN ('1.2.840.10008.1.2.4.90', "
     f"'1.2.840.10008.1.2.4.91', '1.2.840.10008.1.2.4.92', '1.2.840.10008.1.2.4.93') GROUP BY i.datastore_id"),
    ('glossary-count-segmentation', 'How many segmentations are there?', 'number',
     f"SELECT i.datastore_id, COUNT(*) n FROM instance i WHERE i.{L} AND i.sopclassuid = '1.2.840.10008.5.1.4.1.1.66.4' GROUP BY i.datastore_id"),
    ('glossary-count-pdf-files', 'How many raw PDF files are in the storage that were not converted to DICOM?', 'number',
     f"SELECT si.datastore_id, COUNT(*) n FROM storage_index si WHERE si.{L} AND si.content_kind = 'NON_DICOM' AND si.non_dicom_type = 'application/pdf' GROUP BY si.datastore_id"),
    # ---- single values -----------------------------------------------------
    ('total-bytes', 'What is the total size in bytes of all stored objects?', 'number',
     f"SELECT si.datastore_id, SUM(si.size_bytes) n FROM storage_index si WHERE si.{L} GROUP BY si.datastore_id"),
    ('max-object', 'What is the size in bytes of the largest stored object?', 'number',
     f"SELECT si.datastore_id, MAX(si.size_bytes) n FROM storage_index si WHERE si.{L} GROUP BY si.datastore_id"),
    ('avg-inst-per-series', 'What is the average number of instances per series? Round to 2 decimals.', 'number',
     f"SELECT x.datastore_id, ROUND(AVG(x.n), 2) a FROM (SELECT se.datastore_id, se.series_pkey, COUNT(i.instance_pkey) n FROM series se "
     f"LEFT JOIN instance i ON i.series_pkey = se.series_pkey AND i.{L} WHERE se.{L} GROUP BY se.datastore_id, se.series_pkey) x GROUP BY x.datastore_id"),
    ('earliest-study', 'What is the earliest study date?', 'number',
     f"SELECT s.datastore_id, MIN(s.studydate) d FROM study s WHERE s.{L} AND s.studydate IS NOT NULL GROUP BY s.datastore_id"),
    ('latest-study', 'What is the most recent study date?', 'number',
     f"SELECT s.datastore_id, MAX(s.studydate) d FROM study s WHERE s.{L} GROUP BY s.datastore_id"),
    # ---- grouped results ---------------------------------------------------
    ('studies-per-modality', 'How many studies are there per modality?', 'rows',
     f"SELECT se.datastore_id, se.modality, COUNT(DISTINCT se.study_pkey) n FROM series se WHERE se.{L} GROUP BY se.datastore_id, se.modality"),
    ('series-per-modality', 'How many series are there per modality?', 'rows',
     f"SELECT se.datastore_id, se.modality, COUNT(*) n FROM series se WHERE se.{L} GROUP BY se.datastore_id, se.modality"),
    ('instances-per-modality', 'How many instances are there per modality?', 'rows',
     f"SELECT se.datastore_id, se.modality, COUNT(i.instance_pkey) n FROM series se JOIN instance i ON i.series_pkey = se.series_pkey "
     f"WHERE se.{L} AND i.{L} GROUP BY se.datastore_id, se.modality"),
    ('bytes-per-modality', 'What is the total stored size in bytes per modality?', 'rows',
     f"SELECT se.datastore_id, se.modality, SUM(si.size_bytes) b FROM series se JOIN instance i ON i.series_pkey = se.series_pkey "
     f"JOIN storage_index si ON si.content_pkey = i.content_pkey WHERE se.{L} AND i.{L} AND si.{L} GROUP BY se.datastore_id, se.modality"),
    ('patients-per-sex', 'How many patients are there for each patient sex value?', 'rows',
     f"SELECT p.datastore_id, p.patientsex, COUNT(*) n FROM patient p WHERE p.{L} GROUP BY p.datastore_id, p.patientsex"),
    ('studies-per-year', 'How many studies are there per study year? Leave out studies without a date.', 'rows',
     f"SELECT s.datastore_id, YEAR(s.studydate) y, COUNT(*) n FROM study s WHERE s.{L} AND s.studydate IS NOT NULL GROUP BY s.datastore_id, YEAR(s.studydate)"),
    ('instances-per-ts', 'How many instances are there per transfer syntax UID?', 'rows',
     f"SELECT i.datastore_id, i.transfersyntaxuid, COUNT(*) n FROM instance i WHERE i.{L} GROUP BY i.datastore_id, i.transfersyntaxuid"),
    ('instances-per-sopclass', 'How many instances are there per SOP class UID?', 'rows',
     f"SELECT i.datastore_id, i.sopclassuid, COUNT(*) n FROM instance i WHERE i.{L} GROUP BY i.datastore_id, i.sopclassuid"),
    ('series-per-bodypart', 'How many series are there per body part examined? Leave out series with no body part.', 'rows',
     f"SELECT se.datastore_id, se.bodypartexamined, COUNT(*) n FROM series se WHERE se.{L} AND se.bodypartexamined IS NOT NULL "
     f"AND se.bodypartexamined <> '' GROUP BY se.datastore_id, se.bodypartexamined"),
    ('modalities-over-10', 'Which modalities have more than 10 series?', 'rows',
     f"SELECT se.datastore_id, se.modality FROM series se WHERE se.{L} GROUP BY se.datastore_id, se.modality HAVING COUNT(*) > 10"),
    ('studies-per-sex', 'How many studies are there per patient sex?', 'rows',
     f"SELECT p.datastore_id, p.patientsex, COUNT(s.study_pkey) n FROM patient p JOIN study s ON s.patient_pkey = p.patient_pkey "
     f"WHERE p.{L} AND s.{L} GROUP BY p.datastore_id, p.patientsex"),
    # ---- lists ----------------------------------------------------------------
    ('patients-ct-and-mr', 'List the patient IDs of patients who have both a CT series and an MR series.', 'rows',
     f"SELECT p.datastore_id, p.patientid FROM patient p JOIN study s ON s.patient_pkey = p.patient_pkey "
     f"JOIN series se ON se.study_pkey = s.study_pkey WHERE p.{L} AND s.{L} AND se.{L} GROUP BY p.datastore_id, p.patient_pkey, p.patientid "
     f"HAVING SUM(CASE WHEN se.modality = 'CT' THEN 1 ELSE 0 END) > 0 AND SUM(CASE WHEN se.modality = 'MR' THEN 1 ELSE 0 END) > 0"),
    ('patients-multi-study', 'List the patient IDs of patients with more than one study, with their number of studies.', 'rows',
     f"SELECT p.datastore_id, p.patientid, COUNT(s.study_pkey) n FROM patient p JOIN study s ON s.patient_pkey = p.patient_pkey "
     f"WHERE p.{L} AND s.{L} GROUP BY p.datastore_id, p.patient_pkey, p.patientid HAVING COUNT(s.study_pkey) > 1"),
    ('series-over-100', 'List the series instance UIDs of series with more than 100 instances, with their instance counts.', 'rows',
     f"SELECT se.datastore_id, se.seriesinstanceuid, COUNT(i.instance_pkey) n FROM series se JOIN instance i ON i.series_pkey = se.series_pkey "
     f"WHERE se.{L} AND i.{L} GROUP BY se.datastore_id, se.series_pkey, se.seriesinstanceuid HAVING COUNT(i.instance_pkey) > 100"),
    ('studies-most-series', 'Which study instance UIDs have the largest number of series? Include all ties, with the series count.', 'rows',
     f"SELECT x.datastore_id, x.studyinstanceuid, x.n FROM (SELECT s.datastore_id, s.studyinstanceuid, COUNT(se.series_pkey) n FROM study s "
     f"JOIN series se ON se.study_pkey = s.study_pkey WHERE s.{L} AND se.{L} GROUP BY s.datastore_id, s.study_pkey, s.studyinstanceuid) x "
     f"WHERE x.n = (SELECT MAX(y.n) FROM (SELECT s2.study_pkey, COUNT(se2.series_pkey) n FROM study s2 JOIN series se2 ON se2.study_pkey = s2.study_pkey "
     f"WHERE s2.{L} AND se2.{L} GROUP BY s2.study_pkey) y)"),
    ('top5-series-bytes', 'Show the 5 largest series by total stored bytes: series instance UID and total bytes, largest first.', 'ordered',
     f"SELECT se.datastore_id, se.seriesinstanceuid, SUM(si.size_bytes) b FROM series se JOIN instance i ON i.series_pkey = se.series_pkey "
     f"JOIN storage_index si ON si.content_pkey = i.content_pkey WHERE se.{L} AND i.{L} AND si.{L} "
     f"GROUP BY se.datastore_id, se.series_pkey, se.seriesinstanceuid ORDER BY b DESC LIMIT 5"),
    ('top3-modalities', 'What are the 3 modalities with the most instances, most first, with their counts?', 'ordered',
     f"SELECT se.datastore_id, se.modality, COUNT(i.instance_pkey) n FROM series se JOIN instance i ON i.series_pkey = se.series_pkey "
     f"WHERE se.{L} AND i.{L} GROUP BY se.datastore_id, se.modality ORDER BY n DESC LIMIT 3"),
    ('sm-series', 'List the series instance UIDs of all whole-slide microscopy (SM) series.', 'rows',
     f"SELECT se.datastore_id, se.seriesinstanceuid FROM series se WHERE se.{L} AND se.modality = 'SM'"),
    ('studies-2007', 'List the study instance UIDs and study dates of studies performed in 2007.', 'rows',
     f"SELECT s.datastore_id, s.studyinstanceuid, s.studydate FROM study s WHERE s.{L} AND s.studydate BETWEEN '2007-01-01' AND '2007-12-31'"),
    # ---- harder cases: few-shot patterns (nl-examples.json), stored-value hints
    # (value-hints.js) and escalation to the stronger model (nl-agent.js) ----
    ('hard-pt-ct-patients', 'How many patients have both a PET series and a CT series?', 'number',
     f"SELECT x.datastore_id, COUNT(*) n FROM (SELECT p.datastore_id, p.patient_pkey FROM patient p "
     f"JOIN study s ON s.patient_pkey = p.patient_pkey JOIN series se ON se.study_pkey = s.study_pkey "
     f"WHERE p.{L} AND s.{L} AND se.{L} GROUP BY p.datastore_id, p.patient_pkey "
     f"HAVING SUM(CASE WHEN se.modality = 'PT' THEN 1 ELSE 0 END) > 0 AND SUM(CASE WHEN se.modality = 'CT' THEN 1 ELSE 0 END) > 0) x "
     f"GROUP BY x.datastore_id"),
    ('hard-top3-series-ties', 'Which 3 series have the most instances? Include every series tied with the third, '
     'with the series instance UID and the instance count.', 'rows',
     f"SELECT x.datastore_id, x.seriesinstanceuid, x.n FROM (SELECT se.datastore_id, se.seriesinstanceuid, COUNT(i.instance_pkey) n "
     f"FROM series se JOIN instance i ON i.series_pkey = se.series_pkey WHERE se.{L} AND i.{L} "
     f"GROUP BY se.datastore_id, se.series_pkey, se.seriesinstanceuid) x WHERE x.n >= (SELECT MIN(t.n) FROM "
     f"(SELECT COUNT(i2.instance_pkey) n FROM series se2 JOIN instance i2 ON i2.series_pkey = se2.series_pkey "
     f"WHERE se2.{L} AND i2.{L} GROUP BY se2.series_pkey ORDER BY n DESC LIMIT 3) t)"),
    ('hard-studies-with-sr', 'How many studies contain at least one structured report?', 'number',
     f"SELECT se.datastore_id, COUNT(DISTINCT se.study_pkey) n FROM series se JOIN instance i ON i.series_pkey = se.series_pkey "
     f"WHERE se.{L} AND i.{L} AND i.sopclassuid IN ('1.2.840.10008.5.1.4.1.1.88.11', '1.2.840.10008.5.1.4.1.1.88.22', "
     f"'1.2.840.10008.5.1.4.1.1.88.33', '1.2.840.10008.5.1.4.1.1.88.34', '1.2.840.10008.5.1.4.1.1.88.35') GROUP BY se.datastore_id"),
    # Sex "other" is stored as the DICOM code O: the value hints show it.
    ('hard-hint-sex-other', 'How many patients have their sex recorded as other?', 'number',
     f"SELECT p.datastore_id, COUNT(*) n FROM patient p WHERE p.{L} AND p.patientsex = 'O' GROUP BY p.datastore_id"),
    ('hard-uncompressed-ct', 'How many CT instances are stored uncompressed?', 'number',
     f"SELECT se.datastore_id, COUNT(*) n FROM series se JOIN instance i ON i.series_pkey = se.series_pkey WHERE se.{L} AND i.{L} "
     f"AND se.modality = 'CT' AND i.transfersyntaxuid IN ('1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2', "
     f"'1.2.840.10008.1.2.1.98', '1.2.840.10008.1.2.1.99') GROUP BY se.datastore_id"),
    ('hard-avg-series-per-study-sex', 'For each patient sex, what is the average number of series per study? Round to 2 decimals.', 'rows',
     f"SELECT x.datastore_id, x.patientsex, ROUND(AVG(x.n), 2) a FROM (SELECT p.datastore_id, p.patientsex, s.study_pkey, "
     f"COUNT(se.series_pkey) n FROM patient p JOIN study s ON s.patient_pkey = p.patient_pkey LEFT JOIN series se "
     f"ON se.study_pkey = s.study_pkey AND se.{L} WHERE p.{L} AND s.{L} GROUP BY p.datastore_id, p.patientsex, s.study_pkey) x "
     f"GROUP BY x.datastore_id, x.patientsex"),
    ('hard-female-mr-before-2010', 'How many studies of female patients that contain an MR series were performed before 2010?', 'number',
     f"SELECT p.datastore_id, COUNT(DISTINCT s.study_pkey) n FROM patient p JOIN study s ON s.patient_pkey = p.patient_pkey "
     f"WHERE p.{L} AND s.{L} AND p.patientsex = 'F' AND s.studydate < '2010-01-01' AND EXISTS (SELECT 1 FROM series se "
     f"WHERE se.study_pkey = s.study_pkey AND se.{L} AND se.modality = 'MR') GROUP BY p.datastore_id"),
    ('hard-video-studies', 'List the study instance UIDs of studies that contain a video, with the number of video instances in each.', 'rows',
     f"SELECT s.datastore_id, s.studyinstanceuid, COUNT(i.instance_pkey) n FROM study s JOIN series se ON se.study_pkey = s.study_pkey "
     f"JOIN instance i ON i.series_pkey = se.series_pkey WHERE s.{L} AND se.{L} AND i.{L} AND (i.sopclassuid IN "
     f"('1.2.840.10008.5.1.4.1.1.77.1.1.1', '1.2.840.10008.5.1.4.1.1.77.1.2.1', '1.2.840.10008.5.1.4.1.1.77.1.4.1') OR i.transfersyntaxuid IN "
     f"('1.2.840.10008.1.2.4.100', '1.2.840.10008.1.2.4.100.1', '1.2.840.10008.1.2.4.101', '1.2.840.10008.1.2.4.101.1', "
     f"'1.2.840.10008.1.2.4.102', '1.2.840.10008.1.2.4.102.1', '1.2.840.10008.1.2.4.103', '1.2.840.10008.1.2.4.103.1', "
     f"'1.2.840.10008.1.2.4.104', '1.2.840.10008.1.2.4.104.1', '1.2.840.10008.1.2.4.105', '1.2.840.10008.1.2.4.105.1', "
     f"'1.2.840.10008.1.2.4.106', '1.2.840.10008.1.2.4.106.1', '1.2.840.10008.1.2.4.107', '1.2.840.10008.1.2.4.108')) "
     f"GROUP BY s.datastore_id, s.study_pkey, s.studyinstanceuid"),
    # ---- saved conversations: the message route runs lookups like /query ----
    ('conversation-lookup', 'How many studies contain a whole-slide microscopy series?', 'conversation',
     f"SELECT se.datastore_id, COUNT(DISTINCT se.study_pkey) n FROM series se WHERE se.{L} AND se.modality = 'SM' GROUP BY se.datastore_id"),
    # ---- paging (bug: a model-written OFFSET was applied twice) -------------
    ('paging-page2', 'List the SOP instance UIDs of all instances, ordered by SOP instance UID.', 'paging',
     f"SELECT i.datastore_id, i.sopinstanceuid FROM instance i WHERE i.{L}"),
]


def post(body, page_size=1000, offset=0):
    body = {**body, 'pageSize': page_size, 'pageOffset': offset, 'source': {'kind': 'storage', 'ids': [DS]}}
    r = urllib.request.Request(f'{API}/analytics-projects/{DS}/query', method='POST', data=json.dumps(body).encode(),
                               headers={'Authorization': f'Bearer {TOK}', 'Content-Type': 'application/json'})
    t0 = time.time()
    try:
        with urllib.request.urlopen(r, timeout=180) as resp:
            return time.time() - t0, resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return time.time() - t0, e.code, json.loads(e.read() or b'{}')


def api(method, path, body=None):
    r = urllib.request.Request(f'{API}{path}', method=method, data=json.dumps(body).encode() if body is not None else None,
                               headers={'Authorization': f'Bearer {TOK}', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(r, timeout=180) as resp:
            return resp.status, json.loads(resp.read() or b'{}')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')


def norm(v):
    if v is None:
        return 'null'
    if isinstance(v, (int, float, decimal.Decimal)) or (isinstance(v, str) and re.fullmatch(r'-?\d+(\.\d+)?', v.strip())):
        return f'{round(float(v), 2):.2f}'
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()[:10]
    s = str(v).strip().lower()
    m = re.match(r'^(\d{4}-\d{2}-\d{2})t', s)   # ISO timestamp from a DATE column
    return m.group(1) if m else s


def values(row):
    return [norm(v) for k, v in row.items() if k != 'datastore_id']


def rows_match(ref, got, ordered):
    if len(ref) != len(got):
        return False, f'rows: expected {len(ref)}, got {len(got)}'
    got_vals = [values(g) for g in got]
    used = set()
    for idx, r in enumerate(ref):
        want = values(r)
        cands = [idx] if ordered else range(len(got_vals))
        hit = next((j for j in cands if j not in used and all(w in got_vals[j] for w in want)), None)
        if hit is None:
            return False, f'no generated row matches {want}'
        used.add(hit)
    return True, f'{len(ref)} rows match'


def number_in_text(n, text):
    """True if the answer states the number n as a whole token. UIDs and dates are
    removed first, so a digit inside 1.2.840.10008... or "JPEG 2000" cannot match."""
    t = text.replace(',', '')
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}', n):
        return n in t
    t = re.sub(r'\d+(?:\.\d+){2,}', ' ', t)           # UIDs
    t = re.sub(r'\d{4}-\d{2}-\d{2}', ' ', t)          # dates
    t = re.sub(r'JPEG[ -]?2000|J2K|H\.?26[45]|MPEG-?[24]', ' ', t, flags=re.I)
    nums = {norm(x) for x in re.findall(r'(?<![\w.])-?\d+(?:\.\d+)?(?![\w.]*\d)', t)}
    return n in nums


results = []
for cid, question, kind, ref_sql in CASES:
    if ONLY and cid not in ONLY:
        continue
    model = ''   # the model that answered (data.model), when the API reports it
    _, rs, rb = post({'type': 'sql', 'sql': ref_sql})
    if rs != 200:
        print(f'  [FAIL] {cid}: reference query failed ({rs}) :: {json.dumps(rb)[:200]}', flush=True)
        results.append({'id': cid, 'ok': False, 'reason': 'reference failed'})
        continue
    ref = rb['data']['rows']

    if kind == 'conversation':
        t0 = time.time()
        st, b = api('POST', f'/analytics-projects/{DS}/conversations', {'title': 'analytics eval'})
        cid = (b.get('data') or {}).get('id')
        ok, detail, sql = False, f'create conversation: HTTP {st}', ''
        if cid:
            try:
                st, b = api('POST', f'/analytics-projects/{DS}/conversations/{cid}/message',
                            {'text': question, 'source': {'kind': 'storage', 'ids': [DS]}})
                g = (b.get('data') or {}).get('generated') or {}
                model = g.get('model') or ''
                want = values(ref[0])[0] if ref else '0.00'
                ok = st == 200 and g.get('mode') == 'chat' and number_in_text(want, g.get('answer') or '')
                detail = f"HTTP {st} mode={g.get('mode')} want {want}: {(g.get('answer') or g.get('sql') or '')[:120]!r}"
            finally:
                api('DELETE', f'/analytics-projects/{DS}/conversations/{cid}')
        secs = time.time() - t0
    elif kind == 'paging':
        t1, s1, b1 = post({'type': 'natural', 'text': question}, page_size=10, offset=0)
        t2, s2, b2 = post({'type': 'natural', 'text': question}, page_size=10, offset=10)
        p1 = [values(r) for r in (b1.get('data') or {}).get('rows', [])]
        p2 = [values(r) for r in (b2.get('data') or {}).get('rows', [])]
        ok = len(ref) > 20 and len(p1) == 10 and len(p2) == 10 and not any(r in p1 for r in p2)
        detail = f'page1={len(p1)} page2={len(p2)} overlap={sum(1 for r in p2 if r in p1)}'
        secs, sql = t1 + t2, ((b2.get('data') or {}).get('generatedSql') or '')
        model = (b2.get('data') or {}).get('model') or ''
    else:
        secs, st, b = post({'type': 'natural', 'text': question})
        d = b.get('data') or {}
        sql = d.get('generatedSql') or ''
        model = d.get('model') or ''
        if st != 200:
            ok, detail = False, f'HTTP {st}: {json.dumps(b.get("error"))[:200]}'
        elif kind == 'number':
            want = values(ref[0])[0] if ref else '0.00'   # a grouped COUNT over no rows returns no row
            if 'answer' in d:
                ok = number_in_text(want, d['answer'])
                detail = f'chat answer {"has" if ok else "lacks"} {want}: {d["answer"][:120]!r}'
            else:
                got = d.get('rows', [])
                # A grouped COUNT over no matching rows returns no row at all.
                ok = (len(got) == 1 and want in values(got[0])) or (not got and want == '0.00')
                detail = f'want {want}, got {[values(g) for g in got[:3]]}'
        else:
            if 'answer' in d:
                ok, detail = False, f'answered in chat instead of rows: {d["answer"][:120]!r}'
            else:
                ok, detail = rows_match(ref, d.get('rows', []), kind == 'ordered')
    tag = f" [{model.split('.')[-1].split('-v')[0]}]" if model else ''
    print(f"  [{'PASS' if ok else 'FAIL'}] {cid} ({secs:.1f}s){tag} :: {detail}", flush=True)
    results.append({'id': cid, 'question': question, 'ok': ok, 'detail': detail, 'seconds': round(secs, 1), 'sql': sql, 'model': model})

passed = sum(r['ok'] for r in results)
score = passed / len(results) if results else 0
mean = sum(r.get('seconds', 0) for r in results) / max(1, len(results))
escalated = sum(1 for r in results if 'sonnet' in (r.get('model') or ''))
print(f'\nAnalytics text-to-SQL eval: {passed}/{len(results)} correct ({score:.0%}), mean {mean:.1f}s per question, '
      f'{escalated} answered by the escalation model')
json.dump({'score': score, 'passed': passed, 'total': len(results), 'cases': results}, open(OUT, 'w'), indent=1)
sys.exit(0 if score >= MIN_SCORE else 1)
