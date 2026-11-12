const fs = require('fs');
const path = require('path');

// Load DICOM tags from local file
const dicomTagsPath = path.join(__dirname, 'dicom-tags.json');
let dicomTags = null;

const loadDicomTags = () => {
  if (!dicomTags) {
    const data = fs.readFileSync(dicomTagsPath, 'utf8');
    dicomTags = JSON.parse(data);
  }
  return dicomTags;
};

exports.handler = async (event) => {
  console.log('DICOM Tags API:', event.httpMethod, event.path);
  
  const { httpMethod, queryStringParameters } = event;

  try {
    if (httpMethod === 'GET') {
      const tags = loadDicomTags();
      
      // Optional filtering by search term
      const search = queryStringParameters?.search?.toLowerCase();
      let filteredTags = tags.dicom_attributes;
      
      if (search) {
        filteredTags = filteredTags.filter(tag => 
          tag.name.toLowerCase().includes(search) ||
          tag.keyword.toLowerCase().includes(search) ||
          tag.tag.includes(search)
        );
      }

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({
          success: true,
          data: { dicom_attributes: filteredTags },
          total: filteredTags.length
        })
      };
    }

    return {
      statusCode: 405,
      body: JSON.stringify({ success: false, message: 'Method not allowed' })
    };

  } catch (error) {
    console.error('Error:', error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, message: 'Internal server error' })
    };
  }
};
