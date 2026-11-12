const { EventBridgeClient, PutEventsCommand } = require('@aws-sdk/client-eventbridge');

const eventBridgeClient = new EventBridgeClient({});

/**
 * Publish configuration update notifications to trigger DICOM/HL7 services to reload their config
 * @param {string[]} locationIds - Array of location IDs that were affected
 * @param {string} serviceType - The service type ('DICOM' or 'HL7')
 * @returns {Promise<void>}
 */
async function publishConfigUpdate(locationIds, serviceType = 'DICOM') {
  const eventBusName = process.env.EVENT_BUS_NAME;
  
  if (!eventBusName) {
    console.warn('EVENT_BUS_NAME not set, skipping config update notification');
    return;
  }

  if (!locationIds || !Array.isArray(locationIds) || locationIds.length === 0) {
    console.warn('locationIds array is required for config update notification');
    return;
  }

  try {
    const uniqueLocationIds = [...new Set(locationIds)];
    
    const entries = uniqueLocationIds.map((locationId) => ({
      Source: 'dicom.archive.config',
      DetailType: 'DICOM_CONFIG_UPDATED',
      Detail: JSON.stringify({
        signal: 'config_update',
        location_id: locationId,
        service_type: serviceType,
        timestamp: new Date().toISOString()
      }),
      EventBusName: eventBusName
    }));

    await eventBridgeClient.send(new PutEventsCommand({
      Entries: entries
    }));

    console.log(`Published config update events for locations: ${uniqueLocationIds.join(', ')}, service type: ${serviceType}`);
  } catch (error) {
    console.error('Failed to publish config update notification:', error.message);
  }
}

module.exports = {
  publishConfigUpdate
};
