// DICOM Tag Reference for QIDO-RS and Indexing
// Based on DICOMweb QIDO-RS specification

const fs = require('fs');
const path = require('path');

// Load DICOM tags from JSON file
const dicomTagsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'dicom-tags.json'), 'utf8'));

// VR max lengths based on DICOM standard
const VR_MAX_LENGTHS = {
  'AE': 16, 'AS': 4, 'CS': 16, 'DA': 8, 'DS': 16, 'DT': 26, 'IS': 12,
  'LO': 64, 'LT': 10240, 'PN': 64, 'SH': 16, 'ST': 1024, 'TM': 14, 'UI': 64, 'UT': 4294967295
};

// Convert array to dictionary keyed by tag (without comma)
const DICOM_TAGS = {};
dicomTagsData.dicom_attributes.forEach(attr => {
  const tagKey = attr.tag.replace(',', '');
  DICOM_TAGS[tagKey] = {
    tag: tagKey,
    name: attr.keyword,
    vr: attr.vr,
    level: attr.level.toUpperCase(),
    maxLength: VR_MAX_LENGTHS[attr.vr] || 64,
    isUid: attr.vr === 'UI'
  };
});

// Mark required tags
const REQUIRED_TAGS = {
  'PATIENT': [],
  'STUDY': ['0020000D', '00080020', '00080030', '00080050', '00080061'],
  'SERIES': ['0020000E', '00080060', '00200011'],
  'INSTANCE': ['00080018', '00080016', '00200013']
};

Object.keys(REQUIRED_TAGS).forEach(level => {
  REQUIRED_TAGS[level].forEach(tagKey => {
    if (DICOM_TAGS[tagKey]) {
      DICOM_TAGS[tagKey].required = true;
    }
  });
});

// Mark computed tags
const COMPUTED_TAGS = ['00080061']; // ModalitiesInStudy
COMPUTED_TAGS.forEach(tagKey => {
  if (DICOM_TAGS[tagKey]) {
    DICOM_TAGS[tagKey].computed = true;
  }
});

const DEID_ACTIONS = {
  REMOVE: 'REMOVE',
  HASH: 'HASH',
  HASH_8: 'HASH_8',
  HASH_16: 'HASH_16',
  HASH_32: 'HASH_32',
  KEEP: 'KEEP',
  REPLACE: 'REPLACE',
  SHIFT_DATE: 'SHIFT_DATE',
  EMPTY: 'EMPTY'
};

function getRequiredTagsByLevel(level) {
  return Object.values(DICOM_TAGS).filter(t => t.level === level && t.required);
}

function getTagsByLevel(level) {
  return Object.values(DICOM_TAGS).filter(t => t.level === level);
}

function getTag(tagId) {
  return DICOM_TAGS[tagId];
}

function getVrMaxLength(vr) {
  return VR_MAX_LENGTHS[vr] || 64;
}

function isUidTag(tagId) {
  const tag = DICOM_TAGS[tagId];
  return tag?.isUid === true;
}

module.exports = {
  DICOM_TAGS,
  DEID_ACTIONS,
  VR_MAX_LENGTHS,
  getRequiredTagsByLevel,
  getTagsByLevel,
  getTag,
  getVrMaxLength,
  isUidTag
};
