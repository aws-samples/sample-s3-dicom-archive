const tags = require('./tags.json');

exports.handler = async (event) => {
  const { queryStringParameters } = event;
  const searchQuery = queryStringParameters?.q?.toLowerCase();

  let filteredTags = tags.tags;

  if (searchQuery) {
    filteredTags = tags.tags.filter(tag => 
      tag.tag.includes(searchQuery) ||
      tag.name.toLowerCase().includes(searchQuery) ||
      tag.description.toLowerCase().includes(searchQuery)
    );
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,OPTIONS'
    },
    body: JSON.stringify({ data: { tags: filteredTags } })
  };
};
