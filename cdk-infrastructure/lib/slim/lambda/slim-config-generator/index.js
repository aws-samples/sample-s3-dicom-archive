const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const s3Client = new S3Client({ region: process.env.REGION });

exports.handler = async (event) => {
  try {
    const config = {
      path: '/slim/',
      servers: [
        { id: 'default', url: '*', write: true }
      ],
      enableServerSelection: true,
      disableWorklist: false,
      disableAnnotationTools: false,
      mode: 'dark',
      preload: true,
      annotations: [
        {
          finding: { value: '85756007', schemeDesignator: 'SCT', meaning: 'Tissue' },
          findingCategory: { value: '91723000', schemeDesignator: 'SCT', meaning: 'Anatomical structure' },
          geometryTypes: ['polygon', 'freehandpolygon'],
          style: { stroke: { color: [255, 255, 0, 1], width: 2 }, fill: { color: [255, 255, 255, 0.2] } }
        },
        {
          finding: { value: '108369006', schemeDesignator: 'SCT', meaning: 'Tumor' },
          findingCategory: { value: '49755003', schemeDesignator: 'SCT', meaning: 'Morphologically abnormal structure' },
          geometryTypes: ['polygon', 'freehandpolygon'],
          style: { stroke: { color: [255, 0, 255, 1], width: 2 }, fill: { color: [255, 255, 255, 0.2] } }
        },
        {
          finding: { value: '34823008', schemeDesignator: 'SCT', meaning: 'Tumor necrosis' },
          findingCategory: { value: '49755003', schemeDesignator: 'SCT', meaning: 'Morphologically abnormal structure' },
          geometryTypes: ['polygon', 'freehandpolygon'],
          style: { stroke: { color: [51, 204, 51, 1], width: 2 }, fill: { color: [255, 255, 255, 0.2] } }
        },
        {
          finding: { value: '369705002', schemeDesignator: 'SCT', meaning: 'Invasive tumor border' },
          findingCategory: { value: '395557000', schemeDesignator: 'SCT', meaning: 'Tumor finding' },
          geometryTypes: ['line', 'freehandline'],
          style: { stroke: { color: [51, 102, 255, 1], width: 2 }, fill: { color: [255, 255, 255, 0.2] } }
        },
        {
          finding: { value: '399721002', schemeDesignator: 'SCT', meaning: 'Tumor infiltration by lymphocytes present' },
          findingCategory: { value: '395557000', schemeDesignator: 'SCT', meaning: 'Tumor finding' },
          geometryTypes: ['polygon', 'freehandpolygon'],
          style: { stroke: { color: [51, 204, 204, 1], width: 2 }, fill: { color: [255, 255, 255, 0.2] } }
        },
        {
          finding: { value: '47973001', schemeDesignator: 'SCT', meaning: 'Artifact' },
          geometryTypes: ['polygon', 'freehandpolygon'],
          style: { stroke: { color: [255, 80, 80, 1], width: 2 }, fill: { color: [255, 255, 255, 0.2] } }
        }
      ]
    };

    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.SLIM_BUCKET_NAME,
      Key: (process.env.SLIM_PREFIX || '') + 'config/local.js',
      Body: `window.config = ${JSON.stringify(config)};`,
      ContentType: 'application/javascript',
      CacheControl: 'no-cache',
    }));

    console.log('SLIM config updated');
    return { statusCode: 200 };
  } catch (error) {
    console.error('Error generating SLIM config:', error.message);
    throw error;
  }
};
