import React from 'react';
import {
  ContentLayout,
  Header,
  Container,
  Box,
  Button,
  SpaceBetween
} from '@cloudscape-design/components';

const OnPremiseGateway: React.FC = () => {
  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button>Create HL7 Gateway</Button>
              <Button variant="primary">Create DICOM Gateway</Button>
            </SpaceBetween>
          }
        >
          On-Premise Gateway Management
        </Header>
      }
    >
      <Container>
        <SpaceBetween direction="vertical" size="l">
          <Box variant="h2">On-Premise Gateway Deployment</Box>
          <Box variant="p">
            This section will manage on-premise DICOM and HL7 gateways.
            Features include:
          </Box>
          <Box>
            <ul>
              <li>Create DICOM interfaces as "on-premise gateways"</li>
              <li>Create HL7 interfaces as "on-premise gateways"</li>
              <li>Generate deployment scripts based on AWS Greengrass IoT device</li>
              <li>Monitor gateway status with "call home" functionality</li>
              <li>Display connection status and health metrics</li>
              <li>Manage certificates and authentication for devices</li>
              <li>Remote configuration updates and management</li>
            </ul>
          </Box>
          <Box variant="p" color="text-status-info">
            Implementation coming soon...
          </Box>
        </SpaceBetween>
      </Container>
    </ContentLayout>
  );
};

export default OnPremiseGateway;
