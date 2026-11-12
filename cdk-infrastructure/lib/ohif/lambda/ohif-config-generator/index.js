// RDS Proxy migration (P2): read Aurora through the RDS Proxy via mysql2 (shared
// layer at /opt/nodejs/database), NOT the RDS Data API. executeStatement keeps a
// Data-API-shaped result ({ records }) so the downstream record[i][j].stringValue
// reads below are unchanged; the shared layer reads DB_HOST(proxy)/DB_SECRET_ARN/
// DB_NAME from the environment.
const { query } = require('/opt/nodejs/database');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const s3Client = new S3Client({ region: process.env.REGION });

function _wrapCell(v) {
  if (v === null || v === undefined) {
    return { isNull: true, stringValue: null, longValue: null, doubleValue: null, booleanValue: null };
  }
  return { stringValue: v, longValue: v, doubleValue: v, booleanValue: v };
}

// Run a SELECT and return the Data-API `{ records }` shape (each cell exposes the
// value under every *Value accessor). No parameters are used by this generator.
async function executeStatement(sql) {
  const rows = await query(sql);
  return { records: (rows || []).map(row => Object.values(row).map(_wrapCell)) };
}

// Transfer syntaxes the viewer can decode itself, so the S3 DICOMweb container
// can hand the stored bytes straight through without re-encoding. Explicit VR
// Little Endian comes last as the catch-all: for anything not listed above it,
// the container decodes to raw pixels rather than serving bytes the viewer
// cannot read. A `transfer-syntax=*` entry must never appear here - the
// container reads it as "no preference" and always serves as-stored.
const S3_ACCEPT_HEADER = [
  'multipart/related; type=image/jphc; transfer-syntax=1.2.840.10008.1.2.4.201; Q=1.0',
  'multipart/related; type=image/jphc; transfer-syntax=1.2.840.10008.1.2.4.202; Q=1.0',
  'multipart/related; type=image/jp2; transfer-syntax=1.2.840.10008.1.2.4.90; Q=0.9',
  'multipart/related; type=image/jp2; transfer-syntax=1.2.840.10008.1.2.4.91; Q=0.8',
  'multipart/related; type=image/jls; transfer-syntax=1.2.840.10008.1.2.4.80; Q=0.7',
  'multipart/related; type=image/jls; transfer-syntax=1.2.840.10008.1.2.4.81; Q=0.6',
  'multipart/related; type=image/jpeg; transfer-syntax=1.2.840.10008.1.2.4.70; Q=0.5',
  'multipart/related; type=image/jpeg; transfer-syntax=1.2.840.10008.1.2.4.50; Q=0.3',
  'multipart/related; type=image/jpeg; transfer-syntax=1.2.840.10008.1.2.4.51; Q=0.2',
  'multipart/related; type=image/dicom-rle; transfer-syntax=1.2.840.10008.1.2.5; Q=0.2',
  'multipart/related; type=application/octet-stream; transfer-syntax=1.2.840.10008.1.2.1; Q=0.1',
];

// Options shared by every data source; only the roots, name and accept header differ.
//
// No Authorization header is set here on purpose. OHIF builds its DICOMweb
// client's headers from userAuthenticationService, not from a source's
// requestOptions, so a header placed here is never sent. The viewer is opened
// with `#token=<Cognito access token>` (fragment, never sent in a request); an
// inline shim moves it to `?token=`, which OHIF turns into
// `Authorization: Bearer <token>` on every request and then strips from the URL.
const COMMON_SOURCE_CONFIG = {
  qidoSupportsIncludeField: false,
  supportsReject: false,
  imageRendering: 'wadors',
  thumbnailRendering: 'wadors',
  enableStudyLazyLoad: true,
  supportsFuzzyMatching: false,
  supportsWildcard: false,
  staticWado: false,
  singlepart: 'bulkdata,video',
};

exports.handler = async (event) => {
  console.log('Generating OHIF app-config.js');

  try {
    // Query datastores. id is the S3 container's key; every datastore is S3.
    const datastoreResult = await executeStatement(
      `SELECT id, name FROM datastores WHERE status = 'ACTIVE'`
    );

    // Query virtual folders
    const vfResult = await executeStatement(
      `SELECT id, name FROM virtual_folders WHERE deleted = FALSE`
    );

    const datastoreSources = (datastoreResult.records || []).map(record => {
      const datastoreId = record[0].stringValue;
      const name = record[1].stringValue;

      // Every datastore is served by this solution's own S3 DICOMweb
      // container, behind the same distribution as the viewer, and is keyed on
      // the internal datastore id.
      const root = `https://${process.env.DISTRIBUTION_DOMAIN}/dicomweb/${datastoreId}`;
      return {
        namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
        sourceName: datastoreId,
        configuration: {
          ...COMMON_SOURCE_CONFIG,
          friendlyName: `${name} (S3)`,
          name: datastoreId,
          wadoUriRoot: root,
          qidoRoot: root,
          wadoRoot: root,
          acceptHeader: S3_ACCEPT_HEADER,
        }
      };
    }).filter(Boolean);

    // Virtual folders are served by the SAME S3 DICOMweb container as datastores,
    // at /dicomweb/{vfId} (the container resolves a VF id on that route and
    // scopes QIDO/WADO to its virtual_folder_assignments). So a VF source mirrors
    // a datastore source exactly: keyed by the VF id, rooted on the distribution.
    const vfSources = (vfResult.records || []).map(record => {
      const vfId = record[0].stringValue;
      const name = record[1].stringValue;
      const root = `https://${process.env.DISTRIBUTION_DOMAIN}/dicomweb/${vfId}`;
      return {
        namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
        sourceName: vfId,
        configuration: {
          ...COMMON_SOURCE_CONFIG,
          friendlyName: `VF: ${name}`,
          name: vfId,
          wadoUriRoot: root,
          qidoRoot: root,
          wadoRoot: root,
          acceptHeader: S3_ACCEPT_HEADER,
        }
      };
    });

    const dataSources = [...datastoreSources, ...vfSources];

    const config = {
      routerBasename: '/ohif',
      extensions: [],
      modes: [],
      showStudyList: false,
      disableStudyListNavigation: true,
      investigationalUseDialog: { option: 'never' },
      defaultDataSourceName: dataSources[0]?.sourceName || 'dicomweb',
      maxNumRequests: { interaction: 200, thumbnail: 100, prefetch: 50 },
      stackRetrieveOptions: {
            retrieveOptions: { single: { streaming: false } },
          },
      useNorm16Texture: true,
      dataSources
    };

    const configContent = `window.config=${JSON.stringify(config)};window.config.whiteLabeling={createLogoComponentFn:function(React){return React.createElement('div',{style:{width:'150px'}})}};`;

    const key = process.env.OHIF_PREFIX ? `${process.env.OHIF_PREFIX}app-config.js` : 'app-config.js';

    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.OHIF_BUCKET_NAME,
      Key: key,
      Body: configContent,
      ContentType: 'application/javascript',
      CacheControl: 'no-cache',
    }));

    console.log(`OHIF config updated: ${datastoreSources.length} datastores, ${vfSources.length} virtual folders`);
    return { statusCode: 200, body: 'Config updated' };
  } catch (error) {
    console.error('Error generating OHIF config:', { errorType: error.name });
    throw error;
  }
};
